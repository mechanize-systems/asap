import "source-map-support/register";

import module from "module";
import type * as esbuild from "esbuild";
import escapeStringRegexp from "escape-string-regexp";
import * as SourceMap from "source-map";
import * as ConvertSourceMap from "convert-source-map";
import * as ErrorStackParser from "error-stack-parser";
import * as path from "path";
import * as tinyhttp from "@tinyhttp/app";
import * as vm from "vm";
import * as fs from "fs";
import debug from "debug";
import * as Cmd from "cmd-ts";
import * as CmdFs from "cmd-ts/batteries/fs";
import memoize from "memoize-weak";
import sirv from "sirv";
import debounce from "debounce";
import * as Refine from "@recoiljs/refine";
import type * as ReactDOMServer from "react-dom/server";
import type * as ASAP from "../src/index";

import * as Build from "./Build";
import * as Workspace from "./Workspace";
import * as Logging from "./Logging";
import * as Watch from "./Watch";
import * as Routing from "../src/Routing";
import type * as API from "../src/api";

type AppConfig = {
  /**
   * Project root.
   */
  projectPath: string;

  /**
   * What env application is running in.
   */
  env: AppEnv;

  /**
   * Base path application is mounted to.
   *
   * Can be also specified through ASAP__BASE_PATH environment variable.
   * Can be also specified dynamically via Content-Base HTTP header.
   */
  basePath?: string;

  /**
   * Page routes.
   *
   * This is mounted directly under $basePath/.
   */
};

type AppEnv = "development" | "production";

type ServeConfig = {
  /**
   * Interface to listen to.
   *
   * Can be also specified through ASAP__INTERFACE environment variable.
   */
  iface: string | undefined;

  /**
   * Port to listen to.
   *
   * Can be also specified through ASAP__PORT environment variable.
   */
  port: number | undefined;

  xForwardedUser: string | undefined;
};

type App = {
  config: AppConfig;
  workspace: Workspace.Workspace | null;
  basePath: string;
  buildApi: Build.BuildService<{ __main__: string }>;
  buildApp: Build.BuildService<{ __main__: string }>;
  buildAppForSsr: Build.BuildService<{ __main__: string }>;
};

let info = debug("asap:info");
let log = debug("asap:main");

function fatal(msg: string): never {
  Logging.error(msg);
  process.exit(1);
}

function makeEntryPlugin(
  name: string,
  path: string,
  contents: string
): readonly [string, esbuild.Plugin] {
  let entry = `__${name}__`;
  let filter = new RegExp(`^${escapeStringRegexp(entry)}\$`);
  return [
    entry,
    {
      name,
      setup(build) {
        build.onResolve({ filter }, async (args) => {
          return { namespace: name, path: args.path };
        });
        build.onLoad({ filter, namespace: name }, (_args) => {
          return { resolveDir: path, contents };
        });
      },
    },
  ] as const;
}

async function createApp(config: AppConfig): Promise<App> {
  let basePath = config.basePath ?? "";

  // Normalize basePath
  if (basePath != "") {
    if (basePath.endsWith("/")) {
      basePath = basePath.slice(0, basePath.length - 1);
    }
    if (!basePath.startsWith("/")) {
      basePath = "/" + basePath;
    }
  }

  let workspace = await Workspace.find(config.projectPath);
  if (workspace != null) {
    log("workspace", path.relative(process.cwd(), workspace.path));
  }

  let apiEntryPoint = path.join(config.projectPath, "api");

  let appApiEntryPointPlugin: esbuild.Plugin = {
    name: "app-api-entry-point",
    setup(build) {
      build.onLoad(
        {
          filter: new RegExp(
            "^" +
              escapeStringRegexp(apiEntryPoint) +
              "(.ts|.js|/index.ts|/index.js)$"
          ),
        },
        async (_args) => {
          let build = await buildApi.ready();
          if (build == null) return { contents: "" };
          let api = await loadAPI(app, build);
          if (api instanceof Error) return { contents: "" };
          return { contents: codegenApiSpecs(api) };
        }
      );
    },
  };

  let [appEntry, appEntryPlugin] = makeEntryPlugin(
    "appEntry",
    config.projectPath,
    `
    import * as ASAP from '@mechanize/asap';
    import {config} from './app';
    ASAP.boot(config);
    `
  );

  let buildApp = Build.build({
    buildId: "app",
    projectPath: config.projectPath,
    entryPoints: { __main__: appEntry },
    env: config.env,
    onBuild: () => info("app build ready"),
    plugins: [appApiEntryPointPlugin, appEntryPlugin],
  });

  let [ssrEntry, ssrEntryPlugin] = makeEntryPlugin(
    "ssrEntry",
    config.projectPath,
    `
    import {config} from './app';
    import * as ASAP from '@mechanize/asap';
    import * as ReactDOMServer from 'react-dom/server';
    export {ReactDOMServer, ASAP, config};
    `
  );

  let buildAppForSsr = Build.build({
    buildId: "app-ssr",
    platform: "node",
    projectPath: config.projectPath,
    entryPoints: { __main__: ssrEntry },
    env: config.env,
    onBuild: () => info("app-ssr build ready"),
    plugins: [appApiEntryPointPlugin, ssrEntryPlugin],
  });

  // This plugin tries to resolve an api entry point and if found nothing it
  // generates a synthetic empty module so that:
  //
  // - Such empty module is treated as absence of API
  // - In development mode esbuild is still running and thus it's possible to
  //   add api w/o reloading the asap process.
  // - The little downside is that a tiny-tiny empty bundle is still being
  //   built.
  let apiEntryPointPlugin: esbuild.Plugin = {
    name: "api-entry-point",
    setup(build) {
      build.onResolve(
        { filter: new RegExp("^" + escapeStringRegexp(apiEntryPoint) + "$") },
        async (args) => {
          let suffixes = [".ts", ".js", "/index.ts", "/index.js"];
          for (let suffix of suffixes) {
            let path = args.path + suffix;
            try {
              await fs.promises.stat(path);
              return { path };
            } catch {
              continue;
            }
          }
          return { namespace: "api", path: "synthetic-entry" };
        }
      );
      build.onLoad(
        { filter: /^synthetic-entry$/, namespace: "api" },
        (_args) => {
          return { contents: `` };
        }
      );
    },
  };

  let buildApi = Build.build({
    buildId: "api",
    projectPath: config.projectPath,
    entryPoints: {
      __main__: apiEntryPoint,
    },
    platform: "node",
    env: config.env,
    external: (importSpecifier: string) => {
      // No workspace found so every import should be treated as external.
      if (workspace == null) return true;
      // Fast check if the importSpecifier is exactly a package name from the
      // workspace (this is a common thing to for packages to have a single
      // entry point).
      if (workspace?.packageNames.has(importSpecifier)) return false;
      // Now slower check for imports of package submodules.
      for (let name of workspace.packageNames)
        if (importSpecifier.startsWith(name + "/")) return false;
      return true;
    },
    onBuild: (build) => {
      let hasApi = !("api:synthetic-entry" in (build.metafile?.inputs ?? {}));
      if (hasApi) info(`api build ready`);
    },
    plugins: [apiEntryPointPlugin],
  });

  let app: App = {
    buildApi,
    buildApp,
    buildAppForSsr,
    config,
    basePath,
    workspace,
  };
  return app;
}

type EndpointInfo<B extends {} = {}, P extends string = string> = {
  name: string;
  method: API.HTTPMethod;
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
      method: method as API.HTTPMethod,
      parseBody,
      route: Routing.route(path as string),
      handle: value as any as EndpointInfo["handle"],
    };
  }
  return null;
}

function codegenApiSpecs(api: LoadedAPI) {
  let chunks: string[] = [`import * as ASAP from '@mechanize/asap';`];
  for (let name in api.endpoints) {
    let endpoint = api.endpoints[name]!;
    let { method, route } = endpoint;
    let s = JSON.stringify;
    chunks.push(
      `export let ${endpoint.name} = (params) =>
         ASAP.UNSAFE__call(
           {name: ${s(endpoint.name)}, method: ${s(method)}, route: ${s(
        route
      )}},
           params);
       ${endpoint.name}.method = ${s(method)};
       ${endpoint.name}.route = ${s(route)};
      `
    );
  }
  return chunks.join("\n");
}

async function build(config: AppConfig) {
  let { projectPath, env = "development" } = config;
  info("building project");
  info("projectPath: $PWD/%s", path.relative(process.cwd(), projectPath));
  info("env: %s", env);

  let app = await createApp(config);

  await Promise.all([
    app.buildApp.start(),
    app.buildAppForSsr.start(),
    app.buildApi.start(),
  ]);
  let [appOk, apiOk] = await Promise.all([
    app.buildApp.ready(),
    app.buildAppForSsr.ready(),
    app.buildApi.ready(),
  ]);
  await Promise.all([
    app.buildApp.stop(),
    app.buildAppForSsr.stop(),
    app.buildApi.stop(),
  ]);
  return appOk && apiOk;
}

async function serve(config: AppConfig, serveConfig: ServeConfig) {
  let { projectPath, env = "development" } = config;
  let app = await createApp(config);

  info("serving project");
  info("projectPath: $PWD/%s", path.relative(process.cwd(), projectPath));
  info("env: %s", env);
  info("basePath: %s", app.basePath);

  if (env === "development") {
    let watch = new Watch.Watch();
    let watchPath = app.workspace?.path ?? projectPath;
    await watch.watch(watchPath);
    let clock = await watch.clock(watchPath);

    await app.buildApp.start();
    await app.buildAppForSsr.start();
    await app.buildApi.start();

    let onChange = debounce(() => {
      info("changes detected, rebuilding");
      app.buildApp.rebuild();
      app.buildAppForSsr.rebuild();
      app.buildApi.rebuild();
    }, 300);

    info("watching path: $PWD/%s", path.relative(process.cwd(), watchPath));
    await watch.subscribe({ path: watchPath, since: clock }, onChange);
  }

  if (env === "production") {
    let [appOutput, apiOutput] = await Promise.all([
      app.buildApp.ready(),
      app.buildAppForSsr.ready(),
      app.buildApi.ready(),
    ]);
    if (appOutput == null) {
      fatal("app bundle was not built");
    }
    if (apiOutput == null) {
      fatal("api bundle was not built");
    }
    // Preload API bundle at the startup so we fail early.
    try {
      let api = await loadAPI(app, apiOutput);
      if (api instanceof Error) throw api;
    } catch {
      fatal("could not initialize api bundle");
    }
  }

  let apiServer = new tinyhttp.App();
  apiServer.all("*", (req, res, next) => serveApi(app, req, res, next));

  let staticServer = sirv(app.buildApp.buildPath, {
    dev: app.config.env === "development",
    immutable: true,
    etag: true,
  });

  let server = new tinyhttp.App();
  server.use((req, _res, next) => {
    if (serveConfig.xForwardedUser != null) {
      req.headers["x-forwarded-user"] = serveConfig.xForwardedUser;
    }
    next();
  });
  server.use(async (req, res, next) => {
    let output = await app.buildApi.ready();
    if (output == null) return res.sendStatus(500);
    let api = await loadAPI(app, output);
    if (api instanceof Error) return res.sendStatus(500);

    if (api.onRequest != null) {
      return api.handle(
        api.onRequest,
        undefined,
        req as any as API.Request,
        res,
        next
      );
    } else {
      return next();
    }
  });
  server.use(`/_api`, apiServer);
  server.use(`/__static`, staticServer);
  server.get(`*`, (req, res) => serveApp(app, req, res));

  let rootServer = new tinyhttp.App({ settings: { xPoweredBy: false } });

  rootServer.use(app.basePath, server);

  rootServer.listen(
    serveConfig.port,
    () =>
      info("listening on http://%s:%d", serveConfig.iface, serveConfig.port),
    serveConfig.iface
  );
}

let serveApp = async (
  app: App,
  req: tinyhttp.Request,
  res: tinyhttp.Response
) => {
  const [out, ssr] = await Promise.all([app.buildApp.ready(), getSSR(app)]);
  if (ssr instanceof Error) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/html");
    res.end(`
      <!doctype html>
      <html>
      <h1>ERROR: SSR is not available</h1>
      </html>
    `);
    return;
  }
  let js = out?.__main__.js?.relativePath ?? "__buildError.js";
  let css = out?.__main__.css?.relativePath;
  let { page, ReactDOMServer } = await ssr.render({
    basePath: app.basePath,
    initialPath: req.path,
    js: `${app.basePath}/__static/${js}`,
    css: css != null ? `${app.basePath}/__static/${css}` : null,
  });
  if (page == null) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/html");
    res.end(`
      <!doctype html>
      <html>
      <h1>404 not found</h1>
      </html>
    `);
    return;
  }
  let didError = false;
  let stream = ReactDOMServer.renderToPipeableStream(page, {
    onShellReady() {
      res.statusCode = didError ? 500 : 200;
      res.setHeader("Content-type", "text/html");
      stream.pipe(res);
    },
    onShellError(_error: unknown) {
      res.statusCode = 500;
      res.end(`
        <!doctype html>
        <html>
        <h1>ERROR: SSR error</h1>
        </html>
      `);
    },
    onAllReady() {
      // If you don't want streaming, use this instead of onShellReady.
      // This will fire after the entire page content is ready.
      // You can use this for crawlers or static generation.
      // res.statusCode = didError ? 500 : 200;
      // res.setHeader('Content-type', 'text/html');
      // stream.pipe(res);
    },
    onError(err: unknown) {
      didError = true;
      ssr.formatError(err).then((err) => console.error(err));
    },
  });
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html");
};

let serveApi = async (
  app: App,
  req: tinyhttp.Request,
  res: tinyhttp.Response,
  next: tinyhttp.NextFunction
) => {
  let url = new URL(`proto://example${req.url}`);
  let output = await app.buildApi.ready();
  if (output == null) {
    res.statusCode = 500;
    res.end("500 INTERNAL SERVER ERROR");
    return;
  }

  let api = await loadAPI(app, output);
  if (api instanceof Error) {
    res.statusCode = 500;
    res.end("500 INTERNAL SERVER ERROR");
    return;
  }

  if (api.routes.length > 0)
    for (let route of api.routes) {
      if (route.method !== req.method) continue;
      let params = Routing.matches(route, url.pathname);
      if (params == null) continue;
      return await api.handle(route.handle, params, req, res, next);
    }

  res.statusCode = 404;
  res.end("404 NOT FOUND");
};

type APIExports = {
  routes?: API.Routes;
  onRequest?: API.Handle<void>;
  [name: string]: API.Endpoint<unknown, {}> | unknown;
};

type LoadedAPI = {
  routes: API.Routes;
  onRequest: API.Handle<void> | null;
  endpoints: { [name: string]: EndpointInfo };
  handle: <P>(
    handler: API.Handle<P>,
    params: P,
    req: API.Request<P>,
    res: API.Response,
    next: API.Next
  ) => Promise<unknown>;
};

type SSR = {
  render: (config: ASAP.BootConfig) => Promise<{
    ReactDOMServer: typeof ReactDOMServer;
    page: React.ReactNode | null;
  }>;
  formatError: (error: unknown) => Promise<string>;
};

let loadSSR = memoize(
  async (
    app: App,
    endpoints: LoadedAPI["endpoints"],
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

      let context = {
        ASAPConfig: { basePath: app.basePath },
        ASAPEndpoints: endpoints,
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
      };
      vm.createContext(context);
      try {
        script.runInContext(context);
      } catch (err: any) {
        Logging.error("while loading API code");
        console.log(
          await formatBundleErrorStackTrace(
            bundlePath!,
            bundle,
            err as Error,
            filename
          )
        );
        return new Error("error loading API bundle");
      }
      return context;
    }

    let render: SSR["render"] = async (boot: ASAP.BootConfig) => {
      let context = await evalBundle();
      if (context instanceof Error) throw context;
      let { ASAP, config } = context.module.exports;
      let page = ASAP.render(config, boot);
      return { page, ReactDOMServer: context.module.exports.ReactDOMServer };
    };

    let formatError: SSR["formatError"] = (err) => {
      return formatBundleErrorStackTrace(
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

let loadAPI = memoize(
  async (
    app: App,
    output: Build.BuildOutput<{ __main__: string }>
  ): Promise<LoadedAPI | Error> => {
    log("loading api bundle");

    const bundlePath = output.__main__.js?.path;
    if (bundlePath == null) {
      Logging.error("no api bundle found");
      return new Error("no api bundle found");
    }

    let bundle = await fs.promises.readFile(bundlePath, "utf8");

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
      Logging.error("while loading API code");
      console.log(
        await formatBundleErrorStackTrace(
          bundlePath,
          bundle,
          err as Error,
          filename
        )
      );
      return new Error("error loading API bundle");
    }

    let handleError = async (res: API.Response, err: any) => {
      res.statusCode = 500;
      res.end("500 INTERNAL SERVER ERROR");
      Logging.error("while serving API request");
      console.log(
        await formatBundleErrorStackTrace(
          bundlePath,
          bundle,
          err as Error,
          filename
        )
      );
    };

    let handle = async <P>(
      handler: API.Handle<P>,
      params: P,
      req: API.Request<P>,
      res: API.Response,
      next: API.Next
    ) => {
      try {
        // TODO: seems fishy...
        req.params = params;
        return await handler(req as API.Request<P>, res, async (err) => {
          if (err == null) return next(err);
          handleError(res, err);
        });
      } catch (err) {
        handleError(res, err);
      }
    };

    let readBody = (req: API.Request<unknown>): Promise<string> => {
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

    let routes: API.Routes = context.module.exports.routes ?? [];

    let endpoints: LoadedAPI["endpoints"] = {};
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

let getAPI = async (app: App) => {
  let build = await app.buildApi.ready();
  if (build == null) return null;
  let api = await loadAPI(app, build);
  if (api instanceof Error) throw new Error("API is not available");
  return api;
};

let getSSR = async (app: App) => {
  let build = await app.buildAppForSsr.ready();
  if (build == null) return new Error("SSR is not available");
  let api = await getAPI(app);
  return loadSSR(app, api?.endpoints ?? {}, build);
};

async function extractSourceMap(bundlePath: string, bundle: string) {
  let conv = ConvertSourceMap.fromSource(bundle);
  let rawSourceMap = conv?.toObject() as SourceMap.RawSourceMap | null;
  if (rawSourceMap != null) return rawSourceMap;
  try {
    let data = await fs.promises.readFile(bundlePath + ".map", "utf8");
    return JSON.parse(data) as SourceMap.RawSourceMap;
  } catch {
    return null;
  }
}

async function formatBundleErrorStackTrace(
  bundlePath: string,
  bundle: string,
  error: Error,
  fileName: string
): Promise<string> {
  let sourceMap = await extractSourceMap(bundlePath, bundle);
  if (sourceMap == null) return "  " + String(error.stack);
  let consumer = new SourceMap.SourceMapConsumer(sourceMap);
  let stack = ErrorStackParser.parse(error);
  let items: string[] = [`  Error: ${error.message}`];
  let cwd = process.cwd();
  for (let frame of stack) {
    if (frame.fileName !== fileName) continue;
    if (frame.lineNumber == null || frame.columnNumber == null) continue;
    let { line, column, source } = consumer.originalPositionFor({
      line: frame.lineNumber!,
      column: frame.columnNumber!,
    });
    if (line == null || column == null || source == null) continue;
    source = path.relative(
      cwd,
      path.resolve(path.dirname(bundlePath), source)
    );
    let item = `    at ${source}:${line}:${column}`;
    if (frame.functionName != null) {
      item = `${item} (${frame.functionName})`;
    }
    items.push(item);
  }
  return items.join("\n");
}

/**
 * Command Line Interface.
 */

if (!("DEBUG" in process.env)) {
  debug.enable("asap:info,asap:error");
}

let appConfigArgs = {
  projectPath: Cmd.positional({
    type: Cmd.optional(CmdFs.Directory),
    displayName: "PROJECT_PATH",
  }),
  basePath: Cmd.option({
    long: "base-path",
    description: "Base path application is running at",
    env: "ASAP__BASE_PATH",
    defaultValue: () => "" as AppEnv,
    type: Cmd.string,
  }),
  env: Cmd.option({
    short: "E",
    long: "env",
    description:
      "either 'development' or 'production' (default: 'production')",
    env: "NODE_ENV",
    defaultValue: () => "development" as AppEnv,
    type: Cmd.oneOf(["development", "production"]),
  }),
};

let portType: Cmd.Type<string, number> = {
  async from(value: string) {
    if (value.startsWith(":")) value = value.slice(1);
    if (!/^\d+$/.exec(value)) throw new Error("Not a number");
    return parseInt(value, 10);
  },
};

let serveCmd = Cmd.command({
  name: "serve",
  description: "Serve application",
  args: {
    ...appConfigArgs,
    xForwardedUser: Cmd.option({
      long: "x-forwarded-user",
      description: "Set X-Forwarded-User HTTP header",
      env: "ASAP__X_FORWARDED_USER",
      type: Cmd.optional(Cmd.string),
    }),
    port: Cmd.option({
      long: "port",
      description: "Port to listen on (default: 3001)",
      defaultValue: () => 3001,
      env: "ASAP__PORT",
      type: portType,
    }),
    iface: Cmd.option({
      long: "interface",
      description: "Interface to listen on (default: 127.0.0.1)",
      defaultValue: () => "127.0.0.1",
      env: "ASAP__INTERFACE",
      type: Cmd.string,
    }),
  },
  handler: ({
    projectPath = process.cwd(),
    basePath,
    env,
    port,
    iface,
    xForwardedUser,
  }) => {
    serve(
      { projectPath, basePath, env: env as AppEnv },
      { port, iface, xForwardedUser }
    );
  },
});

let buildCmd = Cmd.command({
  name: "build",
  description: "Build application",
  args: {
    ...appConfigArgs,
  },
  handler: async ({ projectPath = process.cwd(), env }) => {
    let ok = await build({ projectPath, env: env as AppEnv });
    if (!ok) process.exit(1);
  },
});

let asapCmd = Cmd.subcommands({
  name: "asap",
  version: require("../package.json").version,
  cmds: {
    serve: serveCmd,
    build: buildCmd,
  },
});

Cmd.run(asapCmd, process.argv.slice(2));
