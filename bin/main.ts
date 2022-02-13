import "source-map-support/register";

import module from "module";
import * as SourceMap from "source-map";
import * as ConvertSourceMap from "convert-source-map";
import * as ErrorStackParser from "error-stack-parser";
import * as path from "path";
import * as tinyhttp from "@tinyhttp/app";
import * as vm from "vm";
import * as fs from "fs";
import jsesc from "jsesc";
import debug from "debug";
import * as Cmd from "cmd-ts";
import * as CmdFs from "cmd-ts/batteries/fs";
import memoize from "memoize-weak";
import sirv from "sirv";

import * as Build from "./Build";
import * as Workspace from "./Workspace";
import * as Logging from "./Logging";
import * as Watch from "./Watch";
import * as Routing from "../src/Routing";
import type * as API from "../src/api";

type AppConfig = {
  /**
   * Project root.
   */
  projectPath: string;

  /**
   * What env application is running in.
   */
  env: AppEnv;

  /**
   * Base path application is mounted to.
   *
   * Can be also specified through ASAP__BASEPATH environment variable.
   * Can be also specified dynamically via Content-Base HTTP header.
   */
  basePath?: string;

  /**
   * Page routes.
   *
   * This is mounted directly under $basePath/.
   */
};

type AppEnv = "development" | "production";

type ServeConfig = {
  /**
   * Interface to listen to.
   *
   * Can be also specified through ASAP__IFACE environment variable.
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

type App = {
  config: AppConfig;
  workspace: Workspace.Workspace | null;
  basePath: string;
  buildApi: Build.BuildService<{ __main__: string }>;
  buildApp: Build.BuildService<{ __main__: string }>;
};

let info = debug("asap:info");
let log = debug("asap:main");

function fatal(msg: string): never {
  Logging.error(msg);
  process.exit(1);
}

async function createApp(config: AppConfig): Promise<App> {
  let basePath = config.basePath ?? "";

  // Normalize basePath
  if (basePath != "") {
    if (basePath.endsWith("/")) {
      basePath = basePath.slice(0, basePath.length - 1);
    }
    if (!basePath.startsWith("/")) {
      basePath = "/" + basePath;
    }
  }

  let buildApp = Build.build({
    buildId: "app",
    projectPath: config.projectPath,
    entryPoints: {
      __main__: path.join(config.projectPath, "app"),
    },
    env: config.env,
    onBuild: () => info("app build ready"),
  });

  let workspace = await Workspace.find(config.projectPath);
  if (workspace != null) {
    log("workspace", path.relative(process.cwd(), workspace.path));
  }

  let buildApi = Build.build({
    buildId: "api",
    projectPath: config.projectPath,
    entryPoints: {
      __main__: path.join(config.projectPath, "api"),
    },
    platform: "node",
    env: config.env,
    external: (importSpecifier: string) => {
      // No workspace found so every import should be treated as external.
      if (workspace == null) return true;
      // Fast check if the importSpecifier is exactly a package name from the
      // workspace (this is a common thing to for packages to have a single
      // entry point).
      if (workspace?.packageNames.has(importSpecifier)) return false;
      // Now slower check for imports of package submodules.
      for (let name of workspace.packageNames)
        if (importSpecifier.startsWith(name + "/")) return false;
      return true;
    },
    onBuild: () => info(`api build ready`),
  });

  return { buildApi, buildApp, config, basePath, workspace };
}

async function build(config: AppConfig) {
  let { projectPath, env = "development" } = config;
  info("building project");
  info("projectPath: $PWD/%s", path.relative(process.cwd(), projectPath));
  info("env: %s", env);

  let app = await createApp(config);

  await Promise.all([app.buildApp.start(), app.buildApi.start()]);
  let [appOk, apiOk] = await Promise.all([
    app.buildApp.ready(),
    app.buildApi.ready(),
  ]);
  await Promise.all([app.buildApp.stop(), app.buildApi.stop()]);
  return appOk && apiOk;
}

async function serve(config: AppConfig, serveConfig: ServeConfig) {
  let { projectPath, env = "development" } = config;
  let app = await createApp(config);

  info("serving project");
  info("projectPath: $PWD/%s", path.relative(process.cwd(), projectPath));
  info("env: %s", env);
  info("basePath: %s", app.basePath);

  if (env === "development") {
    let watch = new Watch.Watch();
    let watchPath = app.workspace?.path ?? projectPath;
    await watch.watch(watchPath);
    let clock = await watch.clock(watchPath);

    await app.buildApp.start();
    await app.buildApi.start();

    await watch.subscribe({ path: watchPath, since: clock }, () => {
      info("changes detected, rebuilding");
      app.buildApp.rebuild();
      app.buildApi.rebuild();
    });
    info("watching path: $PWD/%s", path.relative(process.cwd(), watchPath));
  }

  if (env === "production") {
    let [appOutput, apiOutput] = await Promise.all([
      app.buildApp.ready(),
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
      let api = await loadAPI(app, apiOutput);
      if (api == null) throw new Error("no api");
      if (api instanceof Error) throw api;
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
  server.use(`/_api`, apiServer);
  server.use(`/__static`, staticServer);
  server.get(`*`, (req, res) => serveApp(app, req, res));

  let rootServer = new tinyhttp.App({ settings: { xPoweredBy: false } });
  if (app.basePath !== "") {
    rootServer.use(app.basePath, server);
  } else {
    rootServer.use(server);
  }
  rootServer.listen(
    serveConfig.port,
    () =>
      info("listening on http://%s:%d", serveConfig.iface, serveConfig.port),
    serveConfig.iface
  );
}

let serveApp = async (
  app: App,
  _req: tinyhttp.Request,
  res: tinyhttp.Response
) => {
  let outs = await app.buildApp.ready();
  let js = outs?.__main__.js?.relativePath ?? "__buildError.js";
  let css = outs?.__main__.css?.relativePath;
  let config = jsesc(
    {
      basePath: app.basePath,
    },
    { json: true, isScriptContext: true }
  );
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html");
  res.end(
    `
    <!doctype html>
    <html>
      <head>
        ${
          css
            ? `<link rel="stylesheet" href="${app.basePath}/__static/${css}" />`
            : ""
        }
      </head>
      <body>
        <div id="asap"></div>
        <script>
          window.ASAPConfig = ${config};
        </script>
        <script type="module" src="${app.basePath}/__static/${js}"></script>
      </body>
    </html>
      `
  );
};

let serveApi = async (
  app: App,
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

  let api = await loadAPI(app, output);
  if (api instanceof Error || api == null) {
    if (api instanceof Error) {
      console.log(api);
    }
    res.statusCode = 500;
    res.end("500 INTERNAL SERVER ERROR");
    return;
  }

  for (let route of api.routes) {
    if (route.method !== req.method) continue;
    let params = Routing.matches(route, url.pathname);
    if (params == null) continue;
    return await api.runRoute(route, params, req, res, next);
  }

  res.statusCode = 404;
  res.end("404 NOT FOUND");
};

type LoadedAPI = {
  routes: API.Routes;
  runRoute: <P extends string>(
    route: API.Route<P>,
    params: API.RouteParams<P>,
    req: API.Request,
    res: API.Response,
    next: API.Next
  ) => Promise<unknown>;
};

let loadAPI = memoize(
  async (
    app: App,
    output: Build.BuildOutput<{ __main__: string }>
  ): Promise<LoadedAPI | Error | null> => {
    log("loading api bundle");

    const bundlePath = output.__main__.js?.path;
    if (bundlePath == null) return new Error("no api bundle found");

    let bundle = await fs.promises.readFile(bundlePath, "utf8");

    let apiModule = { exports: {} as { routes?: API.Routes } };

    let apiRequire = module.createRequire(
      path.join(app.config.projectPath, "api")
    );

    let context = {
      ASAPConfig: { basePath: app.basePath },
      module: apiModule,
      require: apiRequire,
      Buffer,
      process,
      console,
      setTimeout,
      setInterval,
      setImmediate,
      clearTimeout,
      clearInterval,
      clearImmediate,
    };
    vm.createContext(context);
    try {
      let script = new vm.Script(bundle, { filename: "asap://api" });
      script.runInContext(context);
    } catch (err: any) {
      Logging.error("while loading API code");
      console.log(
        await formatBundleErrorStackTrace(bundlePath, bundle, err as Error)
      );
      return null;
    }

    let runRoute = async <P extends string>(
      route: API.Route<P>,
      params: API.RouteParams<P>,
      req: API.Request,
      res: API.Response,
      next: API.Next
    ) => {
      let handleError = async (err: any) => {
        res.statusCode = 500;
        res.end("500 INTERNAL SERVER ERROR");
        Logging.error("while serving API request");
        console.log(
          await formatBundleErrorStackTrace(bundlePath, bundle, err as Error)
        );
      };

      try {
        // TODO: seems fishy...
        req.params = params;
        return await route.handle(req, res, async (err) => {
          if (err == null) return next(err);
          handleError(err);
        });
      } catch (err) {
        handleError(err);
      }
    };

    let routes = context.module.exports.routes;
    if (routes == null) return new Error("api bundle has no routes defined");
    return { routes, runRoute };
  }
);

async function extractSourceMap(bundlePath: string, bundle: string) {
  let conv = ConvertSourceMap.fromSource(bundle);
  let rawSourceMap = conv?.toObject() as SourceMap.RawSourceMap | null;
  if (rawSourceMap != null) return rawSourceMap;
  try {
    let data = await fs.promises.readFile(bundlePath + ".map", "utf8");
    return JSON.parse(data) as SourceMap.RawSourceMap;
  } catch {
    return null;
  }
}

async function formatBundleErrorStackTrace(
  bundlePath: string,
  bundle: string,
  error: Error
): Promise<string> {
  let sourceMap = await extractSourceMap(bundlePath, bundle);
  if (sourceMap == null) return "  " + String(error.stack);
  let consumer = new SourceMap.SourceMapConsumer(sourceMap);
  let stack = ErrorStackParser.parse(error);
  let items: string[] = [`  Error: ${error.message}`];
  let cwd = process.cwd();
  for (let frame of stack) {
    if (frame.fileName !== "asap://api") continue;
    if (frame.lineNumber == null || frame.columnNumber == null) continue;
    let { line, column, source } = consumer.originalPositionFor({
      line: frame.lineNumber!,
      column: frame.columnNumber!,
    });
    if (line == null || column == null || source == null) continue;
    source = path.relative(cwd, path.resolve(path.dirname(bundlePath), source));
    let item = `    at ${source}:${line}:${column}`;
    if (frame.functionName != null) {
      item = `${item} (${frame.functionName})`;
    }
    items.push(item);
  }
  return items.join("\n");
}

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
    env: "ASAP__BASEPATH",
    defaultValue: () => "" as AppEnv,
    type: Cmd.string,
  }),
  env: Cmd.option({
    short: "E",
    long: "env",
    description: "either 'development' or 'production' (default: 'production')",
    env: "NODE_ENV",
    defaultValue: () => "development" as AppEnv,
    type: Cmd.oneOf(["development", "production"]),
  }),
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
      type: Cmd.number,
    }),
    iface: Cmd.option({
      long: "interface",
      description: "Interface to listen on (default: 127.0.0.1)",
      defaultValue: () => "127.0.0.1",
      env: "ASAP__IFACE",
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
    serve({ projectPath, basePath, env }, { port, iface, xForwardedUser });
  },
});

let buildCmd = Cmd.command({
  name: "build",
  description: "Build application",
  args: {
    ...appConfigArgs,
  },
  handler: async ({ projectPath = process.cwd(), env }) => {
    let ok = await build({ projectPath, env });
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
