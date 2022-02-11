/**
 * Build service.
 *
 * This provides a wrapper on top of esbuild's incremental builds.
 */

import * as path from "path";
import * as esbuild from "esbuild";
import { deferred } from "./PromiseUtil";
import debug from "debug";
import * as Logging from "./Logging";

export type BuildConfig = {
  buildId: string;
  projectRoot: string;
  entryPoints: { [out: string]: string };
  platform?: esbuild.Platform;
  external?: esbuild.BuildOptions["external"];
  onBuild?: (b: esbuild.BuildIncremental) => void;
  env?: "development" | "production";
};

/**
 * BuildService exposes methods for managing a build process.
 */
export type BuildService = {
  /** The path which hosts the output of tje build. */
  outputPath: string;
  /** Schedule a rebuild. */
  rebuild: () => Promise<void>;
  /** Start the initial build. */
  start: () => Promise<void>;
  /** Promise which resolves when the currently running build has completed. */
  ready: () => Promise<boolean>;
  /** Stop the build process. */
  stop: () => Promise<void>;
};

/** Start the build service. */
export function build(config: BuildConfig): BuildService {
  let log = debug(`asap:Build:${config.buildId}`);

  let platform = config.platform ?? "browser";
  let env = config.env ?? "production";

  let outputPath = path.join(
    config.projectRoot,
    "node_modules",
    ".cache",
    "asap",
    "build",
    config.buildId,
    env
  );

  let makeDeferredBuild = () => {
    let b = deferred<esbuild.BuildIncremental>();
    // Suppress 'unhandledRejection' event for build.
    b.promise.catch(() => {});
    return b;
  };

  let initialBuild = makeDeferredBuild();
  let currentBuild = makeDeferredBuild();
  let currentBuildStart = performance.now();

  let onBuild = (b: esbuild.BuildIncremental) => {
    let spent = performance.now() - currentBuildStart;
    log(`onBuild`, `${spent.toFixed(0)}ms`);
    currentBuild.resolve(b);
    if (config.onBuild != null) config.onBuild(b);
  };

  let onBuildError = (err: Error) => {
    log(`onBuildError`);
    if ("errors" in err) {
      Logging.error(
        `building ${config.buildId}`,
        (err as any).errors.map(
          (e: any): Logging.CodeLoc => ({
            message: e.text,
            path: path.join(config.projectRoot, e.location.file),
            line: e.location.line,
            column: e.location.column,
          })
        )
      );
    } else {
      Logging.error(`building ${config.buildId}: ${String(err)}`);
    }
    currentBuild.reject(err);
  };

  let start = async () => {
    log(`start()`);
    let build: null | esbuild.BuildIncremental = null;
    currentBuildStart = performance.now();
    try {
      build = await esbuild.build({
        absWorkingDir: config.projectRoot,
        entryPoints: config.entryPoints,
        outdir: outputPath,
        bundle: true,
        loader: { ".js": "jsx" },
        metafile: true,
        splitting: platform === "browser",
        treeShaking: env === "production",
        incremental: true,
        format: "esm",
        platform,
        external: config.external ?? [],
        minify: env === "production",
        logLevel: "silent",
        define: {
          NODE_NEV: env,
        },
      });
    } catch (err: any) {
      initialBuild.reject(err);
      onBuildError(err);
      return;
    }
    if (build != null) {
      initialBuild.resolve(build);
      onBuild(build);
    }
  };

  let stop = async () => {
    log(`stop()`);
    try {
      let b = await initialBuild.promise;
      b.rebuild.dispose();
      b.stop?.();
    } catch (_err) {}
    try {
      let b = await initialBuild.promise;
      b.stop?.();
    } catch (_err) {}
  };

  let rebuild = async () => {
    log(`rebuild()`);
    if (initialBuild.isResolved) {
      log(`initialBuild.isResolved`);
      let ib = initialBuild.value;
      if (!currentBuild.isCompleted) await currentBuild.promise;
      if (currentBuild.isResolved) currentBuild.value.stop?.();
      currentBuild = makeDeferredBuild();
      currentBuildStart = performance.now();
      let build: esbuild.BuildIncremental | null = null;
      try {
        build = await ib.rebuild();
      } catch (err: any) {
        onBuildError(err);
        return;
      }
      if (build != null) {
        onBuild(build);
      }
    } else if (initialBuild.isRejected) {
      log(`initialBuild.isRejected`);
      initialBuild = makeDeferredBuild();
      currentBuild = makeDeferredBuild();
      start();
    } else {
      log(`await initialBuild`);
      await initialBuild.promise;
      await rebuild();
    }
  };

  return {
    outputPath,
    start,
    stop,
    rebuild,
    async ready() {
      try {
        await currentBuild.promise;
        return true;
      } catch (_err) {
        return false;
      }
    },
  };
}
