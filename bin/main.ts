import "source-map-support/register";
import * as path from "path";
import * as vm from "vm";
import * as fs from "fs";
import * as Fastify from "fastify";
import FastifyStatic from "fastify-static";
import debug from "debug";
import * as Cmd from "cmd-ts";

import type * as types from "./types";
import * as Build from "./Build";
import * as Watch from "./Watch";
import * as Routing from "../src/Routing";
import type * as API from "../src/api";

let info = debug("asap:info");

debug.enable("asap:info");

let serveCmd = Cmd.command({
  name: "serve",
  description: "Serve application",
  args: {
    projectRoot: Cmd.positional({
      type: Cmd.optional(Cmd.string),
      displayName: "PROJECT_ROOT",
    }),
    production: Cmd.flag({
      long: "production",
      description: "Serve application in production mode",
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
  handler: ({ projectRoot, production, port, iface }) => {
    let cwd = process.cwd();
    if (projectRoot != null) {
      projectRoot = path.resolve(cwd, projectRoot);
    } else {
      projectRoot = cwd;
    }
    let mode: types.AppConfig["mode"] = production
      ? "production"
      : "development";
    main({ projectRoot, mode, port, iface });
  },
});

let buildCmd = Cmd.command({
  name: "build",
  description: "Build application",
  args: {},
  handler: () => {
    throw new Error("TODO");
  },
});

let asapCmd = Cmd.subcommands({
  name: "asap",
  cmds: { serve: serveCmd, build: buildCmd },
});

Cmd.run(asapCmd, process.argv.slice(2));

type App = {
  config: types.AppConfig;
  buildApi: Build.BuildService;
  buildApp: Build.BuildService;
};

export async function main(config: types.AppConfig) {
  let { projectRoot, mode = "development" } = config;
  info("starting project");
  info("projectRoot: $PWD/%s", path.relative(process.cwd(), projectRoot));
  info("mode: %s", mode);

  let watch: Watch.Watch | null = null;
  let clock: Watch.Clock | null = null;

  if (mode === "development") {
    watch = new Watch.Watch();
    clock = await watch.clock(config.projectRoot);
  }

  let buildApp = Build.build({
    buildId: "app",
    projectRoot: projectRoot,
    entryPoints: {
      main: path.join(projectRoot, "app"),
    },
    onBuild: () => info("app build ready"),
  });

  let buildApi = Build.build({
    buildId: "api",
    projectRoot: projectRoot,
    entryPoints: {
      main: path.join(projectRoot, "api"),
    },
    platform: "node",
    onBuild: () => info(`api build ready`),
  });

  let app: App = { buildApi, buildApp, config };

  if (watch != null) {
    await watch.subscribe({ path: projectRoot, since: clock }, () => {
      info("changes detected, rebuilding");
      buildApp.rebuild();
      buildApi.rebuild();
    });
    info("watching project for changes");
  }

  let server = Fastify.fastify({});

  server.addHook("preHandler", async (req) => {
    // For /__static/ let's wait till the current build is ready.
    if (req.url.startsWith("/__static/")) {
      await buildApp.ready;
    }
  });

  server.register(FastifyStatic, {
    prefix: "/__static",
    root: buildApp.outputPath,
  });

  server.get("/_api*", serveApi(app));
  server.get("/*", serveApp(app));

  let { iface = "10.0.88.2", port = 3001 } = config;
  server.listen(port, iface, () => {
    info("listening on http://%s:%d", iface, port);
  });
}

let serveApp =
  (_app: App): Fastify.RouteHandler =>
  (_req, res) => {
    res.statusCode = 200;
    res.header("Content-Type", "text/html");
    res.send(
      `
    <!doctype html>
    <html>
      <body>
        <div id="asap"></div>
        <script type="module" src="/__static/main.js"></script>
      </body>
    </html>
    `
    );
  };

let serveApi =
  (app: App): Fastify.RouteHandler =>
  async (req, res) => {
    if (app.config.mode === "development") {
      // Wait till the current build is ready.
      await app.buildApi.ready;
    }

    let bundlePath = path.join(app.buildApi.outputPath, "main.js");
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
