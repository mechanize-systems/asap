import type * as ASAP from "../src/index";
import type * as ReactDOMServer from "react-dom/server";
import type * as App from "./App";
import type * as Api from "./Api";

import * as fs from "fs";
import * as vm from "vm";
import * as path from "path";
import module from "module";
import debug from "debug";
import memoize from "memoize-weak";
import * as Build from "./Build";
import * as Logging from "./Logging";

export let log = debug("asap:ssr");

type SSR = {
  render: (config: ASAP.BootConfig) => Promise<
    | {
        ReactDOMServer: typeof ReactDOMServer;
        page: React.ReactNode | null;
        endpointsCache: { [path: string]: unknown };
      }
    | Error
  >;
  formatError: (error: unknown) => Promise<string>;
};

export let load = memoize(
  async (
    app: App.App,
    endpoints: Api.API["endpoints"],
    output: Build.BuildOutput<{ __main__: string }>
  ): Promise<SSR | Error> => {
    log("loading app-ssr bundle");

    const bundlePath = output.__main__.js?.path;
    if (bundlePath == null) {
      Logging.error("no app-ssr bundle found");
      return new Error("no app-ssr bundle found");
    }

    let bundle = await fs.promises.readFile(bundlePath, "utf8");
    let filename = "asap://app-ssr";
    let script = new vm.Script(bundle, { filename });

    async function evalBundle() {
      let thisModule: {
        exports: {
          ReactDOMServer: typeof ReactDOMServer;
          ASAP: typeof ASAP;
          config: ASAP.AppConfig;
        };
      } = { exports: {} as any };
      let thisRequire = module.createRequire(
        path.join(app.config.projectPath, "api")
      );

      let endpointsCache: { [name: string]: unknown } = {};

      let context = {
        ASAPConfig: { basePath: app.basePath },
        ASAPEndpoints: endpoints,
        ASAPEndpointsCache: endpointsCache,
        module: thisModule,
        require: thisRequire,
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
        URLSearchParams,
      };
      vm.createContext(context);
      try {
        script.runInContext(context);
      } catch (err: any) {
        Logging.error("while loading API code");
        console.log(
          await Build.formatBundleErrorStackTrace(
            bundlePath!,
            bundle,
            err as Error,
            filename
          )
        );
        return new Error("error loading SSR bundle");
      }
      return [context, endpointsCache] as const;
    }

    let render: SSR["render"] = async (boot: ASAP.BootConfig) => {
      let res = await evalBundle();
      if (res instanceof Error) return res;
      let [context, endpointsCache] = res;
      let { ASAP, config } = context.module.exports;
      let page = ASAP.render(config, boot);
      return {
        page,
        endpointsCache,
        ReactDOMServer: context.module.exports.ReactDOMServer,
      };
    };

    let formatError: SSR["formatError"] = (err) => {
      return Build.formatBundleErrorStackTrace(
        bundlePath,
        bundle,
        err as Error,
        filename
      );
    };

    return {
      render,
      formatError,
    };
  }
);
