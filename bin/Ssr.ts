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
  render: (
    config: ASAP.BootConfig,
    options: {
      setTitle: (title: string) => void;
      onPagesCache: ASAP.ASAPApi["onPagesCache"];
      onEndpointsCache: ASAP.ASAPApi["onEndpointsCache"];
    }
  ) => Promise<
    | {
        ReactDOMServer: typeof ReactDOMServer;
        ReactClientNode: any;
        clientComponents: Record<string, () => Promise<unknown>>;
        page: React.ReactNode | null;
      }
    | Error
  >;
  formatError: (error: unknown) => Promise<string>;
};

export let load = memoize(
  async (
    app: App.App,
    api: Api.API | null,
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
      onPagesCache,
      onEndpointsCache,
      initialPath,
    }: {
      setTitle: (title: string) => void;
      onPagesCache: ASAP.ASAPApi["onPagesCache"];
      onEndpointsCache: ASAP.ASAPApi["onEndpointsCache"];
      initialPath: string;
    }) {
      let thisModule: {
        exports: {
          ReactDOMServer: typeof ReactDOMServer;
          ReactClientNode: any;
          clientComponents: any;
          ASAP: typeof ASAP;
          config: ASAP.AppConfig;
        };
      } = { exports: {} as any };
      let thisRequire = module.createRequire(
        path.join(app.config.projectPath, "api")
      );

      let ASAPApi: ASAP.ASAPApi = {
        setTitle,
        endpoints: api?.values ?? {},
        endpointsCache: {},
        pagesCache: {},
        onPagesCache,
        onEndpointsCache,
        renderPage: (name: string, props) => {
          let ReactClientNode = context.module.exports.ReactClientNode;
          if (api != null)
            return api.renderComponent(ReactClientNode, name, props);
          else return Promise.reject("no pages bundle active") as any;
        },
      };

      let context = {
        ASAPConfig: { basePath: app.basePath },
        ASAPApi,
        module: thisModule,
        require: thisRequire,
        __webpack_require__: async (id: string) => {
          let load = context.module.exports.clientComponents[id];
          if (load == null)
            throw new Error(`missing client component in SSR bundle ${id}`);
          return load();
        },
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
      return context;
    }

    let render: SSR["render"] = async (
      boot: ASAP.BootConfig,
      { setTitle, onPagesCache, onEndpointsCache }
    ) => {
      let context = await evalBundle({
        setTitle,
        onPagesCache,
        onEndpointsCache,
        initialPath: boot.initialPath ?? "/",
      });
      if (context instanceof Error) return context;
      let { ASAP, config } = context.module.exports;
      let page = ASAP.render(config, boot);
      return {
        page,
        ReactDOMServer: context.module.exports.ReactDOMServer,
        ReactClientNode: context.module.exports.ReactClientNode,
        clientComponents: context.module.exports.clientComponents,
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
