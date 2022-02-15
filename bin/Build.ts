/**
 * Build service.
 *
 * This provides a wrapper on top of esbuild's incremental builds.
 */

import * as crypto from "crypto";
import * as path from "path";
import * as fs from "fs";
import * as esbuild from "esbuild";
import { deferred } from "./PromiseUtil";
import debug from "debug";
import * as Logging from "./Logging";

/** A collection of named entry points for the build. */
export type EnrtyPoints = { [name: string]: string };

/** A collection of outputs corresponding to entry points. */
export type BuildOutput<E extends EnrtyPoints> = {
  [K in keyof E]: BuildOutputItem;
};

export type BuildOutputItem = {
  js: null | BuildOutputFile;
  css: null | BuildOutputFile;
};

export type BuildOutputFile = {
  path: string;
  relativePath: string;
};

export type BuildConfig<E extends EnrtyPoints> = {
  buildId: string;
  projectPath: string;
  entryPoints: E;
  platform?: esbuild.Platform;
  external?: string[] | ((specifier: string) => boolean) | undefined;
  onBuild?: (b: esbuild.BuildIncremental) => void;
  env?: "development" | "production";
};

/**
 * BuildService exposes methods for managing a build process.
 */
export type BuildService<E extends EnrtyPoints> = {
  /** The path which hosts the output of tje build. */
  buildPath: string;
  /** Schedule a rebuild. */
  rebuild: () => Promise<void>;
  /** Start the initial build. */
  start: () => Promise<void>;
  /** Promise which resolves when the currently running build has completed. */
  ready: () => Promise<BuildOutput<E> | null>;
  /** Stop the build process. */
  stop: () => Promise<void>;
};

/** Start the build service. */
export function build<E extends EnrtyPoints>(
  config: BuildConfig<E>
): BuildService<E> {
  let log = debug(`asap:Build:${config.buildId}`);

  let platform = config.platform ?? "browser";
  let env = config.env ?? "production";

  let buildPath = path.join(
    config.projectPath,
    "node_modules",
    ".cache",
    "asap",
    "build",
    config.buildId,
    env
  );

  let metafilePath = path.join(buildPath, "metafile.json");

  let deferredWithCatch = <T>() => {
    let b = deferred<T>();
    // Suppress 'unhandledRejection' event for build.
    b.promise.catch(() => {});
    return b;
  };

  let loadOutput = async (): Promise<BuildOutput<E>> => {
    let metafileData = await fs.promises.readFile(metafilePath, "utf8");
    let metafile: esbuild.Metafile = JSON.parse(metafileData);
    return getBuildOutput(
      config.projectPath,
      config.entryPoints,
      buildPath,
      metafile.outputs
    );
  };

  let started = false;
  let currentVersion = 0;
  let previousOutput: null | Promise<BuildOutput<E>> = null;
  let initial = deferredWithCatch<esbuild.BuildIncremental>();
  let current = deferredWithCatch<{
    build: esbuild.BuildIncremental;
    output: BuildOutput<E>;
  }>();
  let currentBuildStart = performance.now();

  let onBuild = async (build: esbuild.BuildIncremental, version: number) => {
    if (version !== currentVersion) {
      log("SKIPPING");
      return;
    }
    let spent = performance.now() - currentBuildStart;
    log(`onBuild`, `${spent.toFixed(0)}ms`);
    if (build.metafile != null) {
      let metafileTempPath = path.join(
        buildPath,
        crypto.randomBytes(6).toString("hex")
      );
      await fs.promises.writeFile(
        metafileTempPath,
        JSON.stringify(build.metafile)
      );
      await fs.promises.rename(metafileTempPath, metafilePath);
    }
    let output: BuildOutput<E> = getBuildOutput(
      config.projectPath,
      config.entryPoints,
      buildPath,
      build.metafile?.outputs!
    );
    current.resolve({ build, output });
    if (config.onBuild != null) config.onBuild(build);
  };

  let onBuildError = (err: Error, version: number) => {
    if (version !== currentVersion) {
      log("SKIPPING");
      return;
    }
    log(`onBuildError`);
    if ("errors" in err) {
      let locs: Logging.CodeLoc[] = [];
      (err as any).errors.forEach((e: any) => {
        if (e.location != null)
          locs.push({
            message: e.text,
            path: path.join(config.projectPath, e.location.file),
            line: e.location.line,
            column: e.location.column,
          });
        else {
          Logging.error(e.text);
        }
      });
      if (locs.length > 0) {
        Logging.error(`building ${config.buildId}`, locs);
      }
    } else {
      Logging.error(`building ${config.buildId}: ${String(err)}`);
    }
    current.reject(err);
  };

  let plugins: esbuild.Plugin[] = [];
  if (typeof config.external === "function") {
    plugins.push({
      name: "external",
      setup(build) {
        build.onResolve({ filter: /^[^\.]/ }, (args) => {
          if (typeof config.external !== "function") return;
          if (args.kind === "entry-point") return;
          if (!config.external(args.path)) return;
          return { path: args.path, external: true };
        });
      },
    });
  }

  let start = async () => {
    log(`start()`);
    let build: null | esbuild.BuildIncremental = null;
    started = true;
    previousOutput = null;
    currentBuildStart = performance.now();
    try {
      build = await esbuild.build({
        plugins: plugins,
        absWorkingDir: config.projectPath,
        entryPoints: config.entryPoints,
        entryNames: "[dir]/[name]-[hash]",
        outdir: buildPath,
        bundle: true,
        loader: {
          ".js": "jsx",
          ".eot": "file",
          ".woff": "file",
          ".ttf": "file",
        },
        metafile: true,
        splitting: platform === "browser",
        treeShaking: env === "production",
        incremental: true,
        format: platform === "browser" ? "esm" : "cjs",
        platform,
        external:
          config.external && Array.isArray(config.external)
            ? config.external
            : [],
        minify: env === "production",
        logLevel: "silent",
        sourcemap: env === "production" ? "external" : "inline",
        define: {
          NODE_NEV: env,
        },
      });
    } catch (err: any) {
      initial.reject(err);
      onBuildError(err, 0);
      return;
    }
    if (build != null) {
      initial.resolve(build);
      await onBuild(build, 0);
    }
  };

  let stop = async () => {
    log(`stop()`);
    try {
      let b = await initial.promise;
      b.rebuild.dispose();
      b.stop?.();
    } catch (_err) {}
    try {
      let b = await initial.promise;
      b.stop?.();
    } catch (_err) {}
    started = false;
  };

  let rebuild = async (): Promise<void> => {
    log(`rebuild()`);
    if (initial.isResolved) {
      log(`initial.isResolved`);
      currentVersion += 1;
      let version = currentVersion;
      if (current.isResolved) current.value.build.stop?.();
      current = deferredWithCatch();
      currentBuildStart = performance.now();
      let build: esbuild.BuildIncremental | null = null;
      try {
        build = await initial.value.rebuild();
      } catch (err: any) {
        return await onBuildError(err, version);
      }
      return await onBuild(build, version);
    } else if (initial.isRejected) {
      log(`initial.isRejected`);
      initial = deferredWithCatch();
      current = deferredWithCatch();
      return await start();
    } else {
      log(`await initial`);
      await initial.promise;
      return await rebuild();
    }
  };

  let ready = async (): Promise<BuildOutput<E> | null> => {
    if (!started) {
      try {
        if (previousOutput == null) previousOutput = loadOutput();
        return await previousOutput;
      } catch (_err) {
        return null;
      }
    } else {
      try {
        await current.promise;
        if (current.isResolved) return current.value.output;
        else return null;
      } catch (_err) {
        return null;
      }
    }
  };

  return {
    buildPath,
    start,
    stop,
    rebuild,
    ready,
  };
}

function getBuildOutput<E extends EnrtyPoints>(
  projectPath: string,
  entryPoints: EnrtyPoints,
  buildPath: string,
  outputs: esbuild.Metafile["outputs"]
): BuildOutput<E> {
  // Pre-init empty buildOutput for entryPoints
  let buildOutput = {} as BuildOutput<E>;
  for (let k in entryPoints)
    buildOutput[k as keyof E] = { js: null, css: null };

  let makeBuildOutputFile = (p: string) => ({
    path: p,
    relativePath: path.relative(buildPath, p),
  });

  for (let p in outputs) {
    p = path.join(projectPath, p);
    let basename = path.basename(p);
    let extname = path.extname(p);
    let match = PARSE_OUTFILE_RE.exec(basename);
    if (match == null) continue;
    let [, entryPointName] = match;
    if (entryPointName == null) continue;
    let outputItem = buildOutput[entryPointName];
    if (outputItem == null) continue;
    if (extname === ".js") outputItem.js = makeBuildOutputFile(p);
    else if (extname === ".css") outputItem.css = makeBuildOutputFile(p);
  }
  return buildOutput;
}

let PARSE_OUTFILE_RE = /^([a-z0-9A-Z_]+)-[A-Z0-9]+\.(js|css)$/;
