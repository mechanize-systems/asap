import "source-map-support/register";
import * as SourceMap from "source-map";
import * as ConvertSourceMap from "convert-source-map";
import * as ErrorStackParser from "error-stack-parser";
import * as path from "path";
import * as vm from "vm";
import * as fs from "fs";
import jsesc from "jsesc";
import * as Fastify from "fastify";
import FastifyStatic from "fastify-static";
import debug from "debug";
import * as Cmd from "cmd-ts";
import * as CmdFs from "cmd-ts/batteries/fs";
import memoize from "memoize-weak";

import * as Build from "./Build";
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
  iface?: string | undefined;

  /**
   * Port to listen to.
   *
   * Can be also specified through ASAP__PORT environment variable.
   */
  port?: number | undefined;
};

type App = {
  config: AppConfig;
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

function createApp(config: AppConfig): App {
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

  let buildApi = Build.build({
    buildId: "api",
    projectPath: config.projectPath,
    entryPoints: {
      __main__: path.join(config.projectPath, "api"),
    },
    platform: "node",
    env: config.env,
    external: ["fastify"],
    onBuild: () => info(`api build ready`),
  });

  return { buildApi, buildApp, config, basePath };
}

async function build(config: AppConfig) {
  let { projectPath, env = "development" } = config;
  info("building project");
  info("projectPath: $PWD/%s", path.relative(process.cwd(), projectPath));
  info("env: %s", env);

  let app = createApp(config);

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
  let app = createApp(config);

  info("serving project");
  info("projectPath: $PWD/%s", path.relative(process.cwd(), projectPath));
  info("env: %s", env);
  info("basePath: %s", app.basePath);

  if (env === "development") {
    let watch = new Watch.Watch();
    let clock = await watch.clock(projectPath);

    await app.buildApp.start();
    await app.buildApi.start();

    await watch.subscribe({ path: projectPath, since: clock }, () => {
      info("changes detected, rebuilding");
      app.buildApp.rebuild();
      app.buildApi.rebuild();
    });
    info("watching project for changes");
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
    await loadAPI(apiOutput);
  }

  let server = Fastify.fastify();

  server.addHook("preHandler", async (req) => {
    // For /__static/ let's wait till the current build is ready.
    if (env === "development" && req.url.startsWith("/__static/")) {
      await app.buildApp.ready();
    }
  });

  server.register(FastifyStatic, {
    prefix: `${app.basePath}/__static`,
    root: app.buildApp.buildPath,
  });

  server.get(`${app.basePath}/_api*`, serveApi(app));
  server.get(`${app.basePath}/*`, serveApp(app));

  let { iface = "10.0.88.2", port = 3001 } = serveConfig;
  server.listen(port, iface, () => {
    info("listening on http://%s:%d", iface, port);
  });
}

let serveApp =
  (app: App): Fastify.RouteHandler =>
  async (_req, res) => {
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
    res.header("Content-Type", "text/html");
    res.send(
      `
    <!doctype html>
    <html>
      <body>
        <div id="asap"></div>
        ${
          css
            ? `<link rel="stylesheet" href="${app.basePath}/__static/${css}" />`
            : ""
        }
        <script>
          window.ASAPConfig = ${config};
        </script>
        <script type="module" src="${app.basePath}/__static/${js}"></script>
      </body>
    </html>
      `
    );
  };

let serveApi =
  (app: App): Fastify.RouteHandler =>
  async (req, res) => {
    let output = await app.buildApi.ready();
    if (output == null) {
      res.statusCode = 500;
      res.send("500 INTERNAL SERVER ERROR");
      return;
    }

    let api = await loadAPI(output);
    if (api instanceof Error || api == null) {
      if (api instanceof Error) {
        console.log(api);
      }
      res.statusCode = 500;
      res.send("500 INTERNAL SERVER ERROR");
      return;
    }

    let reqPath = (req.params as { "*": string })["*"];
    for (let route of api.routes) {
      let params = Routing.matches(route, reqPath);
      if (params == null) continue;
      return await api.runRoute(route, req, res, params);
    }

    res.statusCode = 404;
    res.send("404 NOT FOUND");
  };

type LoadedAPI = {
  routes: API.Routes;
  runRoute: <P extends string>(
    route: API.Route<P>,
    req: API.Request,
    res: API.Response,
    params: API.RouteParams<P>
  ) => Promise<unknown>;
};

let loadAPI = memoize(
  async (
    output: Build.BuildOutput<{ __main__: string }>
  ): Promise<LoadedAPI | Error | null> => {
    log("loading api bundle");

    const bundlePath = output.__main__.js?.path;
    if (bundlePath == null) return new Error("no api bundle found");

    let bundle = await fs.promises.readFile(bundlePath, "utf8");

    let context = {
      module: { exports: {} as { routes?: API.Routes } },
      require,
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
      req: API.Request,
      res: API.Response,
      params: API.RouteParams<P>
    ) => {
      try {
        return await route.handle(req, res, params);
      } catch (err) {
        res.statusCode = 500;
        res.send("500 INTERNAL SERVER ERROR");
        Logging.error("while serving API request");
        console.log(
          await formatBundleErrorStackTrace(bundlePath, bundle, err as Error)
        );
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
    source = path.relative(cwd, path.resolve(bundlePath, source));
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
  handler: ({ projectPath = process.cwd(), basePath, env, port, iface }) => {
    serve({ projectPath, basePath, env }, { port, iface });
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
