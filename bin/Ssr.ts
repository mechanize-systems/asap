import type * as ASAP from "../src/index";
import type * as ReactDOMServer from "react-dom/server";
import type * as App from "./App";
import type * as Api from "./Api";
import type * as Pages from "./Pages";

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
  render: (
    config: ASAP.BootConfig,
    options: { setTitle: (title: string) => void }
  ) => Promise<
    | {
        ReactDOMServer: typeof ReactDOMServer;
        page: React.ReactNode | null;
        endpointsCache: { [path: string]: unknown };
        pagesCache: { [path: string]: unknown };
      }
    | Error
  >;
  formatError: (error: unknown) => Promise<string>;
};

export let load = memoize(
  async (
    app: App.App,
    endpoints: Api.API["endpoints"],
    pages: Pages.Pages | null,
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

    async function evalBundle({
      setTitle,
      initialPath,
    }: {
      setTitle: (title: string) => void;
      initialPath: string;
    }) {
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

      let ASAPApi: ASAP.ASAPApi = {
        setTitle,
        endpoints,
        endpointsCache: {},
        pagesCache: {},
        renderPage: (name: string) => {
          if (pages != null) return pages.render(name);
          else return Promise.reject("no pages bundle active") as any;
        },
      };

      let context = {
        ASAPConfig: { basePath: app.basePath },
        ASAPApi,
        module: thisModule,
        require: thisRequire,
        fetch,
        TextDecoder,
        TextEncoder,
        Buffer,
        location: { pathname: initialPath },
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
      return [context, ASAPApi.endpointsCache, ASAPApi.pagesCache] as const;
    }

    let render: SSR["render"] = async (
      boot: ASAP.BootConfig,
      { setTitle }
    ) => {
      let res = await evalBundle({
        setTitle,
        initialPath: boot.initialPath ?? "/",
      });
      if (res instanceof Error) return res;
      let [context, endpointsCache, pagesCache] = res;
      let { ASAP, config } = context.module.exports;
      let page = ASAP.render(config, boot);
      return {
        page,
        endpointsCache,
        pagesCache,
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
