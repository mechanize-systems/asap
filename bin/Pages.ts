import type * as App from "./App";

import * as React from "react";
// @ts-ignore
import * as ReactServerDom from "react-server-dom-webpack/server.node";
// @ts-ignore
import * as ReactClientDom from "react-server-dom-webpack/client.node";
// @ts-ignore
import * as ReactClientBrowser from "react-server-dom-webpack/client.browser";
import type * as http from "http";
import * as fs from "fs";
import module from "module";
import * as path from "path";
import * as vm from "vm";
import memoize from "memoize-weak";
import debug from "debug";
import stream from "stream";
import { deferred } from "@mechanize-systems/base/Promise";

import * as Build from "./Build";
import * as Logging from "./Logging";

export let log = debug("asap:api");

type OnCleanup = () => void;

export type Request<Params = void> = http.IncomingMessage & {
  params: Params;
};
export type Response = http.ServerResponse & {
  send(body: unknown): void;
};
export type Next = (err?: any) => void;
export type HTTPMethod = "GET" | "POST";

export type Pages = {
  onCleanup: OnCleanup | null;
  handle: <P>(req: Request<P>, res: Response, next: Next) => Promise<unknown>;
  render: (
    name: string
  ) => { element: Promise<JSX.Element>; data: Promise<string> } | null;
};

export let load = memoize(
  async (
    app: App.App,
    output: Build.BuildOutput<{ __main__: string }>
  ): Promise<Pages | Error> => {
    log("loading pages bundle");

    const bundlePath = output.__main__.js?.path;
    if (bundlePath == null) {
      Logging.error("no api bundle found");
      return new Error("no api bundle found");
    }

    let bundle = await fs.promises.readFile(bundlePath, "utf8");

    let apiModule: {
      exports: { onCleanup: OnCleanup } & Record<string, any>;
    } = {
      exports: {},
    } as any;
    let apiRequire = module.createRequire(
      path.join(app.config.projectPath, "server")
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
    let filename = "asap://pages";
    try {
      let script = new vm.Script(bundle, { filename });
      script.runInContext(context);
    } catch (err: any) {
      Logging.error("while loading pages code");
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

    let handleError = async (res: Response, err: any) => {
      res.statusCode = 500;
      res.end("500 INTERNAL SERVER ERROR");
      Logging.error("while serving pages request");
      console.log(
        await Build.formatBundleErrorStackTrace(
          bundlePath,
          bundle,
          err as Error,
          filename
        )
      );
    };

    let renderToStream = (name: string): stream.Readable | null => {
      let C = apiModule.exports[name];
      if (C == null) return null;
      let element = React.createElement(C, {});
      return ReactServerDom.renderToPipeableStream(element, {});
    };

    let handle = async <P>(req: Request<P>, res: Response, _next: Next) => {
      try {
        let url = new URL(`http://example.com${req.url!}`);
        let name = url.searchParams.get("name");
        if (name == null) {
          res.statusCode = 400;
          res.end(`400 BAD REQUEST: Missing "name" parameter`);
          return;
        }
        let s = renderToStream(name);
        if (s == null) {
          res.statusCode = 400;
          res.end(`400 BAD REQUEST: No component "${name}" found`);
          return;
        }
        res.statusCode = 200;
        s.pipe(res);
        return;
      } catch (err) {
        handleError(res, err);
      }
    };

    let render = (name: string) => {
      let s = renderToStream(name);
      if (s == null) {
        return null;
      }

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
      }
      return {
        element: ReactClientDom.createFromNodeStream(p, {}),
        data: data.promise,
      };
    };

    return {
      handle,
      render,
      onCleanup: context.module.exports.onCleanup ?? null,
    };
  }
);
