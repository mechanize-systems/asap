import "source-map-support/register";

import type * as API from "../src/api";
import * as socketActivation from "socket-activation";

import * as path from "path";
import * as http from "http";
import * as tinyhttp from "@tinyhttp/app";
import debug from "debug";
import * as Cmd from "cmd-ts";
import * as CmdFs from "cmd-ts/batteries/fs";
import sirv from "sirv";
import debounce from "debounce";

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
      await App.getApi(app);
    } catch {
      fatal("could not initialize api bundle");
    }
  }

  let apiServer = new tinyhttp.App();
  apiServer.all("*", (req, res, next) => serveApi(app, req, res, next));

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
    let api = await App.getApi(app);
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
    let server = http.createServer(async (req, res) => {
      await rootApp.handler(req as tinyhttp.Request, res as tinyhttp.Response);
    });
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
  app: App.App,
  req: tinyhttp.Request,
  res: tinyhttp.Response,
  next: tinyhttp.NextFunction
) => {
  let url = new URL(`proto://example${req.url}`);
  let output = await app.buildApi.ready();
  if (output == null) {
    res.statusCode = 500;
    res.end("500 INTERNAL SERVER ERROR");
    return;
  }

  let api = await App.getApi(app);
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

let appConfigArgs = {
  projectPath: Cmd.positional({
    type: Cmd.optional(CmdFs.Directory),
    displayName: "PROJECT_PATH",
  }),
  basePath: Cmd.option({
    long: "base-path",
    description: "Base path application is running at",
    env: "ASAP__BASE_PATH",
    defaultValue: () => "" as App.AppEnv,
    type: Cmd.string,
  }),
  env: Cmd.option({
    short: "E",
    long: "env",
    description:
      "either 'development' or 'production' (default: 'production')",
    env: "NODE_ENV",
    defaultValue: () => "development" as App.AppEnv,
    type: Cmd.oneOf(["development", "production"]),
  }),
};

let portType: Cmd.Type<string, number> = {
  async from(value: string) {
    if (value.startsWith(":")) value = value.slice(1);
    if (!/^\d+$/.exec(value)) throw new Error("Not a number");
    return parseInt(value, 10);
  },
};

let serveCmd = Cmd.command({
  name: "serve",
  description: "Serve application",
  args: {
    ...appConfigArgs,
    xForwardedUser: Cmd.option({
      long: "x-forwarded-user",
      description: "Set X-Forwarded-User HTTP header",
      env: "ASAP__X_FORWARDED_USER",
      type: Cmd.optional(Cmd.string),
    }),
    port: Cmd.option({
      long: "port",
      description: "Port to listen on (default: 3001)",
      defaultValue: () => 3001,
      env: "ASAP__PORT",
      type: portType,
    }),
    iface: Cmd.option({
      long: "interface",
      description: "Interface to listen on (default: 127.0.0.1)",
      defaultValue: () => "127.0.0.1",
      env: "ASAP__INTERFACE",
      type: Cmd.string,
    }),
  },
  handler: ({
    projectPath = process.cwd(),
    basePath,
    env,
    port,
    iface,
    xForwardedUser,
  }) => {
    serve(
      { projectPath, basePath, env: env as App.AppEnv },
      { port, iface, xForwardedUser }
    );
  },
});

let buildCmd = Cmd.command({
  name: "build",
  description: "Build application",
  args: {
    ...appConfigArgs,
  },
  handler: async ({ projectPath = process.cwd(), env }) => {
    let ok = await build({ projectPath, env: env as App.AppEnv });
    if (!ok) process.exit(1);
  },
});

let asapCmd = Cmd.subcommands({
  name: "asap",
  version: require("../package.json").version,
  cmds: {
    serve: serveCmd,
    build: buildCmd,
  },
});

Cmd.run(asapCmd, process.argv.slice(2));
