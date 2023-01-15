import type * as APITypes from "../src/api";
import type * as App from "./App";

import * as url from "url";
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
  onWebSocket: APITypes.OnWebSocket | null;
  onCleanup: APITypes.OnCleanup | null;
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
      onWebSocket?: APITypes.OnWebSocket;
      onCleanup?: APITypes.OnCleanup;
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
      __dirname: app.config.projectPath,
      console,
      setTimeout,
      setInterval,
      setImmediate,
      clearTimeout,
      clearInterval,
      clearImmediate,
      URLSearchParams,
    };
    vm.createContext(context);
    let filename = "asap://api";
    try {
      let script = new vm.Script(bundle, { filename });
      script.runInContext(context);
    } catch (err: any) {
      Logging.error("while loading API code");
      console.log(
        await Build.formatBundleErrorStackTrace(
          bundlePath,
          bundle,
          err as Error,
          filename
        )
      );
      return new Error("error loading API bundle");
    }

    let handleError = async (res: APITypes.Response, err: any) => {
      res.statusCode = 500;
      res.end("500 INTERNAL SERVER ERROR");
      Logging.error("while serving API request");
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

    let routes: APITypes.Routes = context.module.exports.routes ?? [];

    let endpoints: API["endpoints"] = {};
    for (let name in context.module.exports) {
      const endpoint = getEndpointInfo(name, context.module.exports[name]);
      if (endpoint == null) continue;
      endpoints[name] = endpoint;
      routes.push({
        ...endpoint.route,
        method: endpoint.method,
        handle: (req, res) => handleEndpoint(endpoint, req, res),
      });
    }

    return {
      routes,
      endpoints,
      handle,
      onWebSocket: context.module.exports.onWebSocket ?? null,
      onRequest: context.module.exports.onRequest ?? null,
      onCleanup: context.module.exports.onCleanup ?? null,
    };
  }
);

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

async function handleEndpoint<B extends {}, P extends string>(
  endpoint: EndpointInfo<B, P>,
  req: APITypes.Request<Routing.RouteParams<P>>,
  res: APITypes.Response
) {
  let body = await endpoint.parseParams(req);
  let out = await endpoint.handle({ ...req.params, ...body });
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(out ?? null));
}

type EndpointInfo<B extends {} = {}, P extends string = string> = {
  name: string;
  method: APITypes.HTTPMethod;
  route: Routing.Route<P>;
  parseParams: (req: APITypes.Request<unknown>) => Promise<B>;
  handle: (params: Routing.RouteParams<P> & B) => Promise<unknown>;
};

function getEndpointInfo(name: string, value: unknown): EndpointInfo | null {
  if (
    typeof value === "function" &&
    value != null &&
    "type" in value &&
    "method" in value &&
    "path" in value &&
    "params" in value
  ) {
    let { method, path } = value;
    path = path ?? `/${name}`;
    let parseParams: EndpointInfo<{}, string>["parseParams"] = (_req) =>
      Promise.resolve({});
    if (value.params != null) {
      let checker = Refine.object(
        value.params as Readonly<{}>
      ) as Refine.Checker<{}>;
      if (method === "GET") {
        let assertion = Refine.assertion(checker);
        parseParams = async (req: APITypes.Request<unknown>) => {
          let qs = url.parse(req.url ?? "/", true).query;
          qs = { ...qs }; // otherwise it got null prototype and doesn't pass into refine
          return assertion(qs);
        };
      } else if (method === "POST") {
        let parseBody = Refine.jsonParserEnforced(checker);
        parseParams = async (req: APITypes.Request<unknown>) => {
          let body = await readBody(req);
          return parseBody(body);
        };
      }
    }
    return {
      name,
      method: method as APITypes.HTTPMethod,
      parseParams,
      route: Routing.route(path as string),
      handle: value as any as EndpointInfo["handle"],
    };
  }
  return null;
}
