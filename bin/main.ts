import "source-map-support/register";
import * as path from "path";
import * as Fastify from "fastify";
import FastifyStatic from "fastify-static";
import debug from "debug";
import type * as types from "./types";
import * as Build from "./Build";
import * as Watch from "./Watch";

let log = debug("asap:main");

export async function main(config: types.AppConfig) {
  log("starting app");
  let watch = new Watch.Watch();
  let clock = await watch.clock(config.projectRoot);

  let build = Build.build({
    buildId: "pages",
    entryPoints: {
      main: path.join(config.projectRoot, "app"),
    },
  });

  await watch.subscribe({ path: config.projectRoot, since: clock }, () => {
    build.rebuild();
  });

  let app = Fastify.fastify();

  app.addHook("preHandler", async (req) => {
    // For /_js/ let's wait till the current build is ready.
    if (req.url.startsWith("/_js/")) {
      await build.ready;
    }
  });

  app.register(FastifyStatic, {
    prefix: "/_js",
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
    <script type="module" src="/_js/main.js"></script>
  </body>
</html>
    `;
  });

  let { iface = "10.0.88.2", port = 3001 } = config;
  app.listen(port, iface, () => {
    log("listening on %s:%d", iface, port);
  });
}

main({
  projectRoot: path.join(process.cwd(), "example", "basic"),
});
