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

let log = debug("asap:main");

let devCmd = Cmd.command({
  name: "dev",
  description: "Start application in development mode",
  args: {
    projectRoot: Cmd.positional({
      type: Cmd.string,
      displayName: "PROJECT",
    }),
  },
  handler: ({ projectRoot }) => {
    let cwd = process.cwd();
    projectRoot = path.resolve(cwd, projectRoot);
    main({ projectRoot });
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

let startCmd = Cmd.command({
  name: "start",
  description: "Start application in production mode",
  args: {},
  handler: () => {
    throw new Error("TODO");
  },
});

let asapCmd = Cmd.subcommands({
  name: "asap",
  cmds: { dev: devCmd, start: startCmd, build: buildCmd },
});

Cmd.run(asapCmd, process.argv.slice(2));

export async function main(config: types.AppConfig) {
  let { projectRoot, mode = "development" } = config;
  log("starting app");
  log("projectRoot: $PWD/%s", path.relative(process.cwd(), projectRoot));
  log("mode: %s", mode);

  let watch = new Watch.Watch();
  let clock = await watch.clock(config.projectRoot);

  let buildApp = Build.build({
    buildId: "app",
    projectRoot: projectRoot,
    entryPoints: {
      main: path.join(projectRoot, "app"),
    },
  });

  let buildApi = Build.build({
    buildId: "api",
    projectRoot: projectRoot,
    entryPoints: {
      main: path.join(projectRoot, "api"),
    },
    platform: "node",
  });

  await watch.subscribe({ path: projectRoot, since: clock }, () => {
    buildApp.rebuild();
    buildApi.rebuild();
  });

  let app = Fastify.fastify({});

  app.addHook("preHandler", async (req) => {
    // For /__static/ let's wait till the current build is ready.
    if (req.url.startsWith("/__static/")) {
      await buildApp.ready;
    }
  });

  app.register(FastifyStatic, {
    prefix: "/__static",
    root: buildApp.outputPath,
  });

  app.get("/_api*", async (req, res) => {
    await buildApi.ready;
    let apiBundlePath = path.join(buildApi.outputPath, "main.js");
    let apiBundle = await fs.promises.readFile(apiBundlePath, "utf8");
    let context = vm.createContext({});
    let mod = new vm.SourceTextModule(apiBundle, { context });
    await mod.link((specifier, _referencingModule) => {
      throw new Error(`ERROR LINKING ${specifier}`);
    });
    await mod.evaluate();
    let routes = (mod.namespace as { routes: API.Route<string>[] }).routes;
    if (routes == null) throw new Error("api: routes are not defined");

    let reqPath = (req.params as { "*": string })["*"];
    for (let route of Object.values(routes)) {
      let params = Routing.matches(route, reqPath);
      if (params == null) continue;
      return route.handle(req, res, params);
    }

    res.statusCode = 404;
    return "404 NOT FOUND";
  });

  app.get("/*", async (_req, res) => {
    res.statusCode = 200;
    res.header("Content-Type", "text/html");
    return `
<!doctype html>
<html>
  <body>
    <div id="asap"></div>
    <script type="module" src="/__static/main.js"></script>
  </body>
</html>
    `;
  });

  let { iface = "10.0.88.2", port = 3001 } = config;
  app.listen(port, iface, () => {
    log("listening on %s:%d", iface, port);
  });
}
