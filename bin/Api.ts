import type * as APITypes from "../src/api";
import type * as App from "./App";

import * as React from "react";
// @ts-ignore
import * as ReactServerNode from "react-server-dom-webpack/server.node";
import * as url from "url";
import * as fs from "fs";
import module from "module";
import * as path from "path";
import * as vm from "vm";
import memoize from "memoize-weak";
import debug from "debug";
import stream from "stream";
import * as Refine from "@recoiljs/refine";
import { deferred } from "@mechanize-systems/base/Promise";

import * as Build from "./Build";
import * as Logging from "./Logging";
import * as Routing from "../src/Routing";

export let log = debug("asap:api");

export type API = {
  routes: APITypes.Routes;
  onRequest: APITypes.Handle<void> | null;
  onWebSocket: APITypes.OnWebSocket | null;
  onCleanup: APITypes.OnCleanup | null;
  values: { [name: string]: EndpointInfo | ComponentInfo };
  handleEndpoint: <P>(
    handler: APITypes.Handle<P>,
    params: P,
    req: APITypes.Request<P>,
    res: APITypes.Response,
    next: APITypes.Next
  ) => Promise<unknown>;
  handleComponent: <P>(
    req: APITypes.Request<P>,
    res: APITypes.Response,
    next: APITypes.Next
  ) => Promise<unknown>;
  renderComponent: (
    ReactClientNode: any,
    name: string,
    props: unknown
  ) => { element: Promise<JSX.Element>; data: Promise<string> } | null;
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

    let handleEndpoint = async <P>(
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

    let bundleMap = await readBundleMap(app);

    let getComponent = (name: string): ComponentInfo | null => {
      let C = values[name];
      if (C == null) return null;
      if (C.type !== "ComponentInfo") return null;
      return C;
    };

    let renderToStream = (
      C: ComponentInfo,
      props: unknown
    ): stream.Readable => {
      let element = React.createElement(C.render as any, props as any);
      return ReactServerNode.renderToPipeableStream(element, bundleMap);
    };

    let handleComponent = async <P>(
      req: APITypes.Request<P>,
      res: APITypes.Response,
      _next: APITypes.Next
    ) => {
      try {
        let url = new URL(`http://example.com${req.url!}`);
        let name = url.searchParams.get("name");
        if (name == null) {
          res.statusCode = 400;
          res.end(`400 BAD REQUEST: Missing "name" parameter`);
          return;
        }
        let c = getComponent(name);
        if (c == null) {
          res.statusCode = 400;
          res.end(`400 BAD REQUEST: No component "${name}" found`);
          return;
        }
        let p = await c.parseParams(req);
        let s = renderToStream(c, p);
        res.statusCode = 200;
        s.pipe(res);
        return;
      } catch (err) {
        handleError(res, err);
      }
    };

    let renderComponent = (
      ReactClientNode: any,
      name: string,
      props: unknown
    ) => {
      let c = getComponent(name);
      if (c == null) return null;
      let s = renderToStream(c, props);

      // need PassThrough here as createFromNodeStream doesn't accept what's
      // being returned from renderToPipeableStream...
      let p = new stream.PassThrough();
      s.pipe(p);

      let data = deferred<string>();
      {
        let chunks: Buffer[] = [];
        p.on("data", (chunk) => {
          chunks.push(chunk);
        });
        p.on("end", () => {
          data.resolve(Buffer.concat(chunks).toString());
        });
        p.on("error", (err) => {
          console.log("error", err);
        });
      }
      return {
        element: ReactClientNode.createFromNodeStream(p),
        data: data.promise,
      };
    };

    let routes: APITypes.Routes = context.module.exports.routes ?? [];

    let values: API["values"] = {};
    for (let name in context.module.exports) {
      const value = inspectValue(name, context.module.exports[name]);
      if (value == null) continue;
      values[name] = value;
      if (value.type === "EndpointInfo")
        routes.push({
          ...value.route,
          method: value.method,
          handle: (req, res) => handleEndpoint0(value, req, res),
        });
    }

    return {
      routes,
      values,
      handleEndpoint,
      handleComponent,
      renderComponent,
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

async function handleEndpoint0<B extends {}, P extends string>(
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
  type: "EndpointInfo";
  name: string;
  method: APITypes.HTTPMethod;
  route: Routing.Route<P>;
  parseParams: (req: APITypes.Request<unknown>) => Promise<B>;
  handle: (params: Routing.RouteParams<P> & B) => Promise<unknown>;
};

type ComponentInfo<P extends {} = {}> = {
  type: "ComponentInfo";
  name: string;
  parseParams: (req: APITypes.Request<unknown>) => Promise<P>;
  render: APITypes.Component<P>;
};

function inspectValue(
  name: string,
  value: APITypes.Endpoint<unknown, any> | unknown
): EndpointInfo | ComponentInfo | null {
  if (typeof value !== "function") return null;
  if (!("$$asapType" in value)) return null;
  if (value.$$asapType === "endpoint") {
    let endpoint = value as APITypes.Endpoint<any, any>;
    let { method, path } = endpoint;
    path = path ?? `/${name}`;
    let parseParams: EndpointInfo<{}, string>["parseParams"] = (_req) =>
      Promise.resolve({});
    if (endpoint.params != null) {
      let checker = Refine.object(
        endpoint.params as Readonly<{}>
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
    let route = Routing.route(path as string);

    // as RSC can pass them from inside the module...
    (endpoint as any).$$typeof = Symbol.for("react.server.reference");
    (endpoint as any).$$id = {
      name,
      method,
      route: { path: route.path, params: route.params },
    };

    return {
      type: "EndpointInfo",
      name,
      method: method as APITypes.HTTPMethod,
      parseParams,
      route,
      handle: value as any as EndpointInfo["handle"],
    };
  } else if (value.$$asapType === "component") {
    let component = value as APITypes.Component<any>;
    let checker = Refine.object(
      component.params as Readonly<{}>
    ) as Refine.Checker<{}>;
    let parseBody = Refine.jsonParserEnforced(checker);
    let parseParams = async (req: APITypes.Request<unknown>) => {
      let body = await readBody(req);
      return parseBody(body);
    };

    // as RSC can pass them from inside the module...
    (component as any).$$typeof = Symbol.for("react.server.reference");
    (component as any).$$id = name;

    let render = component.render as APITypes.Component<any>;

    return {
      type: "ComponentInfo",
      name,
      parseParams,
      render,
    };
  }
  return null;
}

export async function readBundleMap(app: App.App) {
  let data = await fs.promises.readFile(
    path.join(app.buildApi.buildPath, "bundleMap.json"),
    "utf8"
  );
  return JSON.parse(data);
}

export async function writeBundleMap(app: App.App, data: any) {
  await fs.promises.writeFile(
    path.join(app.buildApi.buildPath, "bundleMap.json"),
    JSON.stringify(data, null, 2)
  );
}
