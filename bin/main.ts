import "source-map-support/register";

import * as socketActivation from "socket-activation";

import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as tinyhttp from "@tinyhttp/app";
import debug from "debug";
import sirv from "sirv";
import * as ws from "ws";
import debounce from "debounce";
import * as C from "@mechanize-systems/base/CommandLine";

import type * as API from "../src/api";
import type * as Api from "./Api";
import * as App from "./App";
import * as Logging from "./Logging";
import * as Watch from "./Watch";
import * as Routing from "../src/Routing";

type ServeConfig = {
  /**
   * Interface to listen to.
   *
   * Can be also specified through ASAP__INTERFACE environment variable.
   */
  iface: string | undefined;

  /**
   * Port to listen to.
   *
   * Can be also specified through ASAP__PORT environment variable.
   */
  port: number | undefined;

  xForwardedUser: string | undefined;

  /**
   * Start WebSocket connection.
   */
  websocket: boolean;
};

function fatal(msg: string): never {
  Logging.error(msg);
  process.exit(1);
}

async function build(config: App.AppConfig) {
  let { projectPath, env = "development" } = config;
  App.info("building project");
  App.info("projectPath: $PWD/%s", path.relative(process.cwd(), projectPath));
  App.info("env: %s", env);

  let app = await App.create(config);

  await Promise.all([
    app.buildApp.start(),
    app.buildAppForSsr.start(),
    app.buildApi.start(),
  ]);
  let [appOk, apiOk] = await Promise.all([
    app.buildApp.ready(),
    app.buildAppForSsr.ready(),
    app.buildApi.ready(),
  ]);
  await Promise.all([
    app.buildApp.stop(),
    app.buildAppForSsr.stop(),
    app.buildApi.stop(),
  ]);
  return appOk && apiOk;
}

async function serve(config: App.AppConfig, serveConfig: ServeConfig) {
  let { projectPath, env = "development" } = config;
  let app = await App.create(config);

  App.info("serving project");
  App.info("projectPath: $PWD/%s", path.relative(process.cwd(), projectPath));
  App.info("env: %s", env);
  App.info("basePath: %s", app.basePath);
  if (serveConfig.websocket) App.info("enabling WebSocket support");

  if (env === "development") {
    process.on("unhandledRejection", (reason, _promise) => {
      // TODO: figure out a way to properly format errors if they come from
      // bundles
      console.log("Unhandled promise rejection:", reason);
    });

    let watch = new Watch.Watch();
    let watchPath = app.workspace?.path ?? projectPath;
    await watch.watch(watchPath);
    let clock = await watch.clock(watchPath);

    await Promise.all([
      app.buildApp.start(),
      app.buildAppForSsr.start(),
      app.buildApi.start(),
    ]);

    let onChange = debounce(() => {
      App.info("changes detected, rebuilding");
      app.buildApp.rebuild();
      app.buildAppForSsr.rebuild();
      app.buildApi.rebuild();
    }, 300);

    App.info(
      "watching path: $PWD/%s",
      path.relative(process.cwd(), watchPath)
    );
    await watch.subscribe({ path: watchPath, since: clock }, onChange);
  }

  let prevApi: Api.API | Error | null = null;
  async function getApi() {
    let api = await App.getApi(app);
    if (prevApi != null && !(prevApi instanceof Error) && prevApi !== api) {
      if (prevApi.onCleanup != null) prevApi.onCleanup();
    }
    prevApi = api;
    return api;
  }

  if (env === "production") {
    let [appOutput, apiOutput] = await Promise.all([
      app.buildApp.ready(),
      app.buildAppForSsr.ready(),
      app.buildApi.ready(),
    ]);
    if (appOutput == null) {
      fatal("app bundle was not built");
    }
    if (apiOutput == null) {
      fatal("api bundle was not built");
    }
    // Preload API bundle at the startup so we fail early.
    try {
      await getApi();
    } catch {
      fatal("could not initialize api bundle");
    }
  }

  let apiServer = new tinyhttp.App();
  apiServer.all("*", async (req, res, next) => {
    let api = await getApi();
    serveApi(api, req, res, next);
  });

  let staticServer = sirv(app.buildApp.buildPath, {
    dev: app.config.env === "development",
    immutable: true,
    etag: true,
  });

  let server = new tinyhttp.App();
  server.use((req, _res, next) => {
    if (serveConfig.xForwardedUser != null) {
      req.headers["x-forwarded-user"] = serveConfig.xForwardedUser;
    }
    next();
  });
  server.use(async (req, res, next) => {
    let api = await getApi();
    if (api instanceof Error) return res.sendStatus(500);
    if (api == null) return next();

    if (api.onRequest != null) {
      return api.handle(
        api.onRequest,
        undefined,
        req as any as API.Request,
        res,
        next
      );
    } else {
      return next();
    }
  });
  server.use(`/_api`, apiServer);
  server.use(`/__static`, staticServer);
  server.get(`*`, (req, res) => serveApp(app, req, res));

  let rootApp = new tinyhttp.App({ settings: { xPoweredBy: false } });
  rootApp.use(app.basePath, server);

  function createServer() {
    let server = http.createServer((req, res) =>
      rootApp.handler(req as tinyhttp.Request, res as tinyhttp.Response)
    );
    if (serveConfig.websocket) {
      let wsserver = new ws.WebSocketServer({ server });
      wsserver.on("connection", async (connection) => {
        let api = await getApi();
        if (api == null || api instanceof Error) {
          connection.close();
        } else if (api.onWebSocket == null) {
          Logging.error("missing onWebSocket(socket) in api");
          connection.close();
        } else {
          api.onWebSocket(connection);
        }
      });
    }
    server.on("error", (err) => {
      throw err;
    });
    return server;
  }

  if (serveConfig.iface === "systemd") {
    for (const fd of socketActivation.collect("asap")) {
      let server = createServer();
      server.listen({ fd }, () => {
        let address = server.address();
        if (typeof address === "string") App.info("listening on %s", address);
        else App.info("listening");
      });
    }
  } else {
    let iface = serveConfig.iface ?? "127.0.0.1";
    let port = serveConfig.port ?? 3001;
    let server = createServer();
    server.listen(port, iface, () => {
      App.info("listening on %s:%d", iface, port);
    });
  }
}

let serveApp = async (
  app: App.App,
  req: tinyhttp.Request,
  res: tinyhttp.Response
) => {
  let sendError = (_err: unknown) => {
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/html");
    res.end(`
      <!doctype html>
      <html>
      <h1>ERROR: SSR ERROR</h1>
      </html>
    `);
  };
  const [out, ssr] = await Promise.all([
    app.buildApp.ready(),
    App.getSsr(app),
  ]);
  if (ssr instanceof Error) {
    return sendError(ssr);
  }
  let js = out?.__main__.js?.relativePath ?? "__buildError.js";
  let css = out?.__main__.css?.relativePath;
  let rendered = await ssr.render(
    {
      basePath: app.basePath,
      initialPath: req.path,
      js: `${app.basePath}/__static/${js}`,
      css: css != null ? `${app.basePath}/__static/${css}` : null,
    },
    {
      setTitle(title) {
        res.write(
          `<script>document.title = ${JSON.stringify(title)};</script>`
        );
      },
    }
  );
  if (rendered instanceof Error) {
    return sendError(rendered);
  }
  let { page, ReactDOMServer, endpointsCache } = rendered;
  if (page == null) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/html");
    res.end(`
      <!doctype html>
      <html>
      <h1>404 not found</h1>
      </html>
    `);
    return;
  }
  let didError = false;
  let stream = ReactDOMServer.renderToPipeableStream(page, {
    onShellReady() {
      res.statusCode = didError ? 500 : 200;
      res.setHeader("Content-type", "text/html");
      stream.pipe(res);
    },
    onShellError(_error: unknown) {
      sendError(_error);
    },
    onAllReady() {
      if (res.statusCode === 200)
        res.write(
          `<script>
             window.ASAPApi = {
               setTitle(title) {
                 document.title = title;
               },
               endpoints: null,
               endpointsCache: ${JSON.stringify(endpointsCache)}
             };
           </script>`
        );
    },
    onError(err: unknown) {
      didError = true;
      ssr.formatError(err).then((err) => console.error(err));
    },
  });
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html");
};

let serveApi = async (
  api: Api.API | null | Error,
  req: tinyhttp.Request,
  res: tinyhttp.Response,
  next: tinyhttp.NextFunction
) => {
  let url = new URL(`proto://example${req.url}`);
  if (api instanceof Error) {
    res.statusCode = 500;
    res.end("500 INTERNAL SERVER ERROR");
    return;
  }
  if (api == null) {
    res.statusCode = 404;
    res.end("404 NOT FOUND");
    return;
  }

  if (api.routes.length > 0)
    for (let route of api.routes) {
      if (route.method !== req.method) continue;
      let params = Routing.matches(route, url.pathname);
      if (params == null) continue;
      return await api.handle(route.handle, params, req, res, next);
    }

  res.statusCode = 404;
  res.end("404 NOT FOUND");
};

/**
 * Command Line Interface.
 */

if (!("DEBUG" in process.env)) {
  debug.enable("asap:info,asap:error");
}

let projectPath = C.argOptional(
  C.argAnd(
    {
      docv: "PROJECT_PATH",
      doc: "Project path",
    },
    (p: string) => {
      if (!fs.existsSync(p)) C.error(`not a directory: ${p}`);
      let stat = fs.statSync(p);
      if (!stat.isDirectory()) C.error(`not a directory: ${p}`);
      return path.resolve(p);
    }
  ),
  process.cwd()
);

let basePath = C.option({
  name: "base-path",
  doc: "Application path",
  docv: "PATH",
  env: "ASAP__BASE_PATH",
  default: "",
});

let env = C.optionAnd(
  {
    name: "env",
    shortName: "E",
    doc: "either 'development' or 'production'",
    docv: "ENV",
    env: "NODE_ENV",
    default: "development",
  },
  (env) => {
    if (env === "production" || env === "development") return env;
    C.error(`--env should be set to "production" or "development"`);
  }
);

function parsePort(value: string) {
  if (value.startsWith(":")) value = value.slice(1);
  if (!/^\d+$/.exec(value)) throw new Error("Not a number");
  return parseInt(value, 10);
}

let serveCmd = C.cmd(
  {
    name: "serve",
    doc: "Serve application",
    opts: {
      basePath,
      env,
      iface: C.option({
        name: "interface",
        doc: 'interface to listen on, pass "systemd" to use systemd socket activation',
        docv: "INTERFACE",
        default: "127.0.0.1",
        env: "ASAP__INTERFACE",
      }),
      port: C.optionAnd(
        {
          name: "port",
          doc: "port to listen on",
          docv: "PORT",
          default: "3001",
          env: "ASAP__PORT",
        },
        parsePort
      ),
      websocket: C.optionFlag({
        name: "websocket",
        doc: "handle WebSocket connection",
      }),
      xForwardedUser: C.option({
        name: "x-forwarded-user",
        doc: "set X-Forwarded-User HTTP header",
        env: "ASAP__X_FORWARDED_USER",
      }),
    },
    argsRest: projectPath,
  },
  ({ basePath, env, port, iface, xForwardedUser, websocket }, projectPath) => {
    serve(
      { projectPath, basePath, env: env as App.AppEnv },
      { port, iface, xForwardedUser, websocket }
    );
  }
);

let buildCmd = C.cmd(
  {
    name: "build",
    doc: "Build application",
    opts: {
      basePath,
      env,
    },
    argsRest: projectPath,
  },
  async ({ env }, projectPath) => {
    let ok = await build({ projectPath, env: env as App.AppEnv });
    if (!ok) process.exit(1);
  }
);

let asapCmd = C.cmd({
  name: "asap",
  version: require("../package.json").version,
  cmds: {
    serve: serveCmd,
    build: buildCmd,
  },
});

C.run(process.argv.slice(2), asapCmd);
