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

  let bundleMap: Record<
    string,
    {
      id: string;
      chunks: string[];
      name: "default" | string;
      async: boolean;
    }
  > = {};

  let clientReferences: { [id: string]: { id: string; path: string } } = {};

  let [crf, crfPlugin] = Build.makeEntryPlugin(
    "crf",
    config.projectPath,
    async () => {
      await getApi(app);
      let s = JSON.stringify;
      let lines: string[] = [];
      for (let id in clientReferences)
        lines.push(`${s(id)}: () => import(${s(clientReferences[id]!.path)})`);
      return `
        export let clientComponents = {
          ${lines.join(",\n")}
        }
      `;
    }
  );

  let findClientImports: esbuild.Plugin = {
    name: "app-server-client-import",
    setup(build) {
      build.onLoad(
        {
          filter: new RegExp(
            "^" + escapeStringRegexp(appEntryPoint) + ".+(.ts|.tsx|.js|.jsx)$"
          ),
        },
        async (args) => {
          let id = path.relative(config.projectPath, args.path);
          let contents = `
                export default {
                  '$$typeof': Symbol.for("react.client.reference"),
                  '$$id': ${JSON.stringify(id)}
                }
              `;
          clientReferences[id] = { id, path: args.path };
          bundleMap[id] = {
            id,
            chunks: [],
            name: "default",
            async: true,
          };
          return { contents };
        }
      );
      build.onEnd(async (_result) => {
        await Api.writeBundleMap(app, bundleMap);
      });
    },
  };

  let apiEntryPoint = path.join(config.projectPath, "api");
  let appEntryPoint = path.join(config.projectPath, "app");

  let appApiEntryPointPlugin: esbuild.Plugin = {
    name: "app-api-entry-point",
    setup(build) {
      build.onLoad(
        {
          filter: new RegExp(
            "^" +
              escapeStringRegexp(apiEntryPoint) +
              "(.ts|.tsx|.js|.jsx|/index.ts|/index.tsx|/index.js|/index.jsx)$"
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
    import {clientComponents} from '${crf}';
    ASAP.boot(config, clientComponents);
    `
  );

  let buildApp = Build.build({
    buildId: "app",
    projectPath: config.projectPath,
    entryPoints: { __main__: appEntry },
    env: config.env,
    onBuild: () => info("app build ready"),
    plugins: [appApiEntryPointPlugin, appEntryPlugin, crfPlugin],
  });

  let [ssrEntry, ssrEntryPlugin] = Build.makeEntryPlugin(
    "ssrEntry",
    config.projectPath,
    `
    import {config} from './app';
    import * as ASAP from '@mechanize/asap';
    import * as ReactDOMServer from 'react-dom/server';
    import * as ReactClientNode from "react-server-dom-webpack/client.node";
    import {clientComponents} from '${crf}';
    export {ReactDOMServer, ReactClientNode, clientComponents, ASAP, config};
    `
  );

  let buildAppForSsr = Build.build({
    buildId: "app-ssr",
    platform: "node",
    projectPath: config.projectPath,
    entryPoints: { __main__: ssrEntry },
    env: config.env,
    onBuild: () => info("app-ssr build ready"),
    plugins: [appApiEntryPointPlugin, ssrEntryPlugin, crfPlugin],
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
          let suffixes = [
            ".ts",
            ".tsx",
            ".js",
            ".jsx",
            "/index.ts",
            "/index.tsx",
            "/index.js",
            "/index.jsx",
          ];
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
    plugins: [apiEntryPointPlugin, findClientImports],
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
  for (let name in api.values) {
    let s = JSON.stringify;
    let v = api.values[name]!;
    if (v.type === "EndpointInfo") {
      let { method, route } = v;
      chunks.push(
        `let ${name}__spec = {
           name: ${s(name)},
           method: ${s(method)},
           route: ${s(route)}
         };
         export let ${name} = (params) =>
           ASAP.UNSAFE__call(${name}__spec, params);
         ${name}.method = ${name}__spec.method;
         ${name}.route = ${name}__spec.route;
         ${name}.$$typeof = Symbol.for("react.server.reference");
         ${name}.$$id = ${name}__spec;
        `
      );
    } else if (v.type === "ComponentInfo") {
      chunks.push(
        `export let ${name} = ASAP.UNSAFE__callComponent(${s(name)});`
      );
    }
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
  return Ssr.load(app, api, build);
};
