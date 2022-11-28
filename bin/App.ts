import type * as esbuild from "esbuild";

import * as fs from "fs";
import * as path from "path";

import debug from "debug";
import escapeStringRegexp from "escape-string-regexp";

import * as Ssr from "./Ssr";
import * as Api from "./Api";
import * as Workspace from "./Workspace";
import * as Build from "./Build";

export let log = debug("asap:app");
export let info = debug("asap:info");

export type AppConfig = {
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

export type AppEnv = "development" | "production";

export type App = {
  config: AppConfig;
  workspace: Workspace.Workspace | null;
  basePath: string;
  buildApi: Build.BuildService<{ __main__: string }>;
  buildApp: Build.BuildService<{ __main__: string }>;
  buildAppForSsr: Build.BuildService<{ __main__: string }>;
};

export async function create(config: AppConfig): Promise<App> {
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
          let api = await getApi(app);
          if (api instanceof Error) return { contents: "" };
          if (api == null) return { contents: "" };
          return { contents: codegenApiSpecs(api) };
        }
      );
    },
  };

  let [appEntry, appEntryPlugin] = Build.makeEntryPlugin(
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

  let [ssrEntry, ssrEntryPlugin] = Build.makeEntryPlugin(
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

function codegenApiSpecs(api: Api.API) {
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

export let getApi = async (app: App) => {
  let build = await app.buildApi.ready();
  if (build == null) return null;
  return await Api.load(app, build);
};

export let getSsr = async (app: App) => {
  let build = await app.buildAppForSsr.ready();
  if (build == null) return new Error("SSR is not available");
  let api = await getApi(app);
  if (api instanceof Error) return api;
  return Ssr.load(app, api?.endpoints ?? {}, build);
};