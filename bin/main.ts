import "source-map-support/register";
import * as path from "path";
import * as vm from "vm";
import * as fs from "fs";
import * as Fastify from "fastify";
import FastifyStatic from "fastify-static";
import debug from "debug";
import * as Cmd from "cmd-ts";
import * as CmdFs from "cmd-ts/batteries/fs";

import * as Build from "./Build";
import * as Watch from "./Watch";
import * as Routing from "../src/Routing";
import type * as API from "../src/api";

type AppConfig = {
  /**
   * Project root.
   */
  projectRoot: string;

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
  buildApi: Build.BuildService<{ main: string }>;
  buildApp: Build.BuildService<{ main: string }>;
};

let info = debug("asap:info");

function createApp(config: AppConfig): App {
  let buildApp = Build.build({
    buildId: "app",
    projectRoot: config.projectRoot,
    entryPoints: {
      main: path.join(config.projectRoot, "app"),
    },
    env: config.env,
    onBuild: () => info("app build ready"),
  });

  let buildApi = Build.build({
    buildId: "api",
    projectRoot: config.projectRoot,
    entryPoints: {
      main: path.join(config.projectRoot, "api"),
    },
    platform: "node",
    env: config.env,
    onBuild: () => info(`api build ready`),
  });
  return { buildApi, buildApp, config };
}

async function build(config: AppConfig) {
  let { projectRoot, env = "development" } = config;
  info("building project");
  info("projectRoot: $PWD/%s", path.relative(process.cwd(), projectRoot));
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
  let { projectRoot, env = "development" } = config;
  info("serving project");
  info("projectRoot: $PWD/%s", path.relative(process.cwd(), projectRoot));
  info("env: %s", env);

  let app = createApp(config);

  if (env === "development") {
    let watch = new Watch.Watch();
    let clock = await watch.clock(projectRoot);

    await app.buildApp.start();
    await app.buildApi.start();

    await watch.subscribe({ path: projectRoot, since: clock }, () => {
      info("changes detected, rebuilding");
      app.buildApp.rebuild();
      app.buildApi.rebuild();
    });
    info("watching project for changes");
  }

  let server = Fastify.fastify({});

  server.addHook("preHandler", async (req) => {
    // For /__static/ let's wait till the current build is ready.
    if (env === "development" && req.url.startsWith("/__static/")) {
      await app.buildApp.ready();
    }
  });

  server.register(FastifyStatic, {
    prefix: "/__static",
    root: app.buildApp.buildPath,
  });

  server.get("/_api*", serveApi(app));
  server.get("/*", serveApp(app));

  let { iface = "10.0.88.2", port = 3001 } = serveConfig;
  server.listen(port, iface, () => {
    info("listening on http://%s:%d", iface, port);
  });
}

let serveApp =
  (app: App): Fastify.RouteHandler =>
  async (_req, res) => {
    let outs = await app.buildApp.ready();
    let bundleName = outs?.main.relativeOutputPath ?? "__buildError.js";
    res.statusCode = 200;
    res.header("Content-Type", "text/html");
    res.send(
      `
      <!doctype html>
      <html>
        <body>
          <div id="asap"></div>
          <script type="module" src="/__static/${bundleName}"></script>
        </body>
      </html>
      `
    );
  };

let serveApi =
  (app: App): Fastify.RouteHandler =>
  async (req, res) => {
    let outs = await app.buildApi.ready();
    let bundlePath = outs?.main.outputPath;
    if (bundlePath == null) {
      res.statusCode = 500;
      res.send("500 INTERNAL SERVER ERROR");
      return;
    }

    // TODO we should cache the eval'ed bundle if not in development
    let bundle = await fs.promises.readFile(bundlePath, "utf8");

    let context = vm.createContext({});
    let mod = new vm.SourceTextModule(bundle, { context });
    await mod.link((specifier, _referencingModule) => {
      let msg =
        `Error while importing "${specifier}" from api bundle: ` +
        "imports outside of the bundle are not allowed";
      throw new Error(msg);
    });
    await mod.evaluate();

    let routes = (mod.namespace as { routes: API.Route<string>[] }).routes;
    if (routes == null) {
      res.statusCode = 404;
      res.send("404 NOT FOUND");
      return;
    }

    let reqPath = (req.params as { "*": string })["*"];
    for (let route of Object.values(routes)) {
      let params = Routing.matches(route, reqPath);
      if (params == null) continue;
      return route.handle(req, res, params);
    }

    res.statusCode = 404;
    res.send("404 NOT FOUND");
  };

/**
 * Command Line Interface.
 */

if (!("DEBUG" in process.env)) {
  debug.enable("asap:info,asap:error");
}

let appConfigArgs = {
  projectRoot: Cmd.positional({
    type: Cmd.optional(CmdFs.Directory),
    displayName: "PROJECT_ROOT",
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
  handler: ({ projectRoot = process.cwd(), env, port, iface }) => {
    serve({ projectRoot, env }, { port, iface });
  },
});

let buildCmd = Cmd.command({
  name: "build",
  description: "Build application",
  args: {
    ...appConfigArgs,
  },
  handler: async ({ projectRoot = process.cwd(), env }) => {
    let ok = await build({ projectRoot, env });
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
