import "source-map-support/register";
import * as path from "path";
import * as Fastify from "fastify";
import FastifyStatic from "fastify-static";
import debug from "debug";
import * as Cmd from "cmd-ts";

import type * as types from "./types";
import * as Build from "./Build";
import * as Watch from "./Watch";

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

  let build = Build.build({
    buildId: "app",
    projectRoot: projectRoot,
    entryPoints: {
      main: path.join(projectRoot, "app"),
    },
  });

  await watch.subscribe({ path: projectRoot, since: clock }, () => {
    build.rebuild();
  });

  let app = Fastify.fastify();

  app.addHook("preHandler", async (req) => {
    // For /__static/ let's wait till the current build is ready.
    if (req.url.startsWith("/__static/")) {
      await build.ready;
    }
  });

  app.register(FastifyStatic, {
    prefix: "/__static",
    root: build.outputPath,
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
