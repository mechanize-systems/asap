import type * as APITypes from "../src/api";
import type * as App from "./App";

import * as fs from "fs";
import module from "module";
import * as path from "path";
import * as vm from "vm";
import memoize from "memoize-weak";
import debug from "debug";
import * as Refine from "@recoiljs/refine";

import * as Build from "./Build";
import * as Logging from "./Logging";
import * as Routing from "../src/Routing";

export let log = debug("asap:api");

export type API = {
  routes: APITypes.Routes;
  onRequest: APITypes.Handle<void> | null;
  endpoints: { [name: string]: EndpointInfo };
  handle: <P>(
    handler: APITypes.Handle<P>,
    params: P,
    req: APITypes.Request<P>,
    res: APITypes.Response,
    next: APITypes.Next
  ) => Promise<unknown>;
};

export let load = memoize(
  async (
    app: App.App,
    output: Build.BuildOutput<{ __main__: string }>
  ): Promise<API | Error> => {
    log("loading api bundle");

    const bundlePath = output.__main__.js?.path;
    if (bundlePath == null) {
      Logging.error("no api bundle found");
      return new Error("no api bundle found");
    }

    let bundle = await fs.promises.readFile(bundlePath, "utf8");

    type APIExports = {
      routes?: APITypes.Routes;
      onRequest?: APITypes.Handle<void>;
      [name: string]: APITypes.Endpoint<unknown, {}> | unknown;
    };

    let apiModule: { exports: APIExports } = {
      exports: {},
    };

    let apiRequire = module.createRequire(
      path.join(app.config.projectPath, "api")
    );

    let context = {
      ASAPConfig: { basePath: app.basePath },
      module: apiModule,
      require: apiRequire,
      Buffer,
      process: {
        ...process,
        env: {
          ...process.env,
          ASAP__BASE_PATH: app.basePath,
        },
      },
      console,
      setTimeout,
      setInterval,
      setImmediate,
      clearTimeout,
      clearInterval,
      clearImmediate,
    };
    vm.createContext(context);
    let filename = "asap://api";
    try {
      let script = new vm.Script(bundle, { filename });
      script.runInContext(context);
    } catch (err: any) {
      Logging.error("while loading APITypes code");
      console.log(
        await Build.formatBundleErrorStackTrace(
          bundlePath,
          bundle,
          err as Error,
          filename
        )
      );
      return new Error("error loading APITypes bundle");
    }

    let handleError = async (res: APITypes.Response, err: any) => {
      res.statusCode = 500;
      res.end("500 INTERNAL SERVER ERROR");
      Logging.error("while serving APITypes request");
      console.log(
        await Build.formatBundleErrorStackTrace(
          bundlePath,
          bundle,
          err as Error,
          filename
        )
      );
    };

    let handle = async <P>(
      handler: APITypes.Handle<P>,
      params: P,
      req: APITypes.Request<P>,
      res: APITypes.Response,
      next: APITypes.Next
    ) => {
      try {
        // TODO: seems fishy...
        req.params = params;
        return await handler(req as APITypes.Request<P>, res, async (err) => {
          if (err == null) return next(err);
          handleError(res, err);
        });
      } catch (err) {
        handleError(res, err);
      }
    };

    let readBody = (req: APITypes.Request<unknown>): Promise<string> => {
      return new Promise((resolve, reject) => {
        let chunks: string[] = [];
        let seenError = false;
        req.on("data", (chunk) => {
          chunks.push(chunk);
        });
        req.on("error", (err) => {
          seenError = true;
          reject(err);
        });
        req.on("end", () => {
          if (!seenError) resolve(chunks.join(""));
        });
      });
    };

    let routes: APITypes.Routes = context.module.exports.routes ?? [];

    let endpoints: API["endpoints"] = {};
    for (let name in context.module.exports) {
      const endpoint = getEndpointInfo(name, context.module.exports[name]);
      if (endpoint == null) continue;
      endpoints[name] = endpoint;
      routes.push({
        ...endpoint.route,
        method: endpoint.method,
        async handle(req, res) {
          let data = await readBody(req);
          let body = endpoint.parseBody(data);
          let out =
            (await endpoint.handle({ ...req.params, ...body })) ?? null;
          res.setHeader("Content-Type", "application/json");
          res.send(JSON.stringify(out ?? null));
        },
      });
    }

    return {
      routes,
      endpoints,
      handle,
      onRequest: context.module.exports.onRequest ?? null,
    };
  }
);

type EndpointInfo<B extends {} = {}, P extends string = string> = {
  name: string;
  method: APITypes.HTTPMethod;
  route: Routing.Route<P>;
  parseBody: (req: string) => B;
  handle: (params: Routing.RouteParams<P> & B) => Promise<unknown>;
};

function getEndpointInfo(name: string, value: unknown): EndpointInfo | null {
  if (
    typeof value === "function" &&
    value != null &&
    "type" in value &&
    "method" in value &&
    "path" in value &&
    "body" in value
  ) {
    let { method, path } = value;
    path = path ?? `/${name}`;
    let parseBody: EndpointInfo<{}, string>["parseBody"] = (_req) => ({});
    if (value.body != null) {
      let checker = Refine.object(
        value.body as Readonly<{}>
      ) as Refine.Checker<{}>;
      parseBody = Refine.jsonParserEnforced(checker);
    }
    return {
      name,
      method: method as APITypes.HTTPMethod,
      parseBody,
      route: Routing.route(path as string),
      handle: value as any as EndpointInfo["handle"],
    };
  }
  return null;
}
