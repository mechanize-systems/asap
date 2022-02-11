/**
 * Build service.
 *
 * This provides a wrapper on top of esbuild's incremental builds.
 */

import * as path from "path";
import tempfile from "tempfile";
import * as fs from "fs";
import * as esbuild from "esbuild";
import { deferred } from "./PromiseUtil";
import debug from "debug";
import * as Logging from "./Logging";

export type EnrtyPoints = { [name: string]: string };

export type Output<E extends EnrtyPoints> = {
  [K in keyof E]: { outputPath: string; relativeOutputPath: string };
};

export type BuildConfig<E extends EnrtyPoints> = {
  buildId: string;
  projectRoot: string;
  entryPoints: E;
  platform?: esbuild.Platform;
  external?: esbuild.BuildOptions["external"];
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
  ready: () => Promise<Output<E> | null>;
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
    config.projectRoot,
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

  let loadOutput = async () => {
    let metafile = JSON.parse(await fs.promises.readFile(metafilePath, "utf8"));
    return outputByEntryPoint(
      config.entryPoints,
      buildPath,
      config.projectRoot,
      metafile
    );
  };

  let started = false;
  let previousOutput: null | Promise<Output<E>> = null;
  let initialBuild = deferredWithCatch<esbuild.BuildIncremental>();
  let current =
    deferredWithCatch<{ build: esbuild.BuildIncremental; output: Output<E> }>();
  let currentBuildStart = performance.now();

  let onBuild = async (build: esbuild.BuildIncremental) => {
    let spent = performance.now() - currentBuildStart;
    log(`onBuild`, `${spent.toFixed(0)}ms`);
    if (build.metafile != null) {
      let metafileTempPath = tempfile(".json");
      await fs.promises.writeFile(
        metafileTempPath,
        JSON.stringify(build.metafile)
      );
      await fs.promises.rename(metafileTempPath, metafilePath);
    }
    let output = outputByEntryPoint(
      config.entryPoints,
      buildPath,
      config.projectRoot,
      build.metafile!
    );
    current.resolve({ build, output });
    if (config.onBuild != null) config.onBuild(build);
  };

  let onBuildError = (err: Error) => {
    log(`onBuildError`);
    if ("errors" in err) {
      let locs: Logging.CodeLoc[] = [];
      (err as any).errors.forEach((e: any) => {
        if (e.location != null)
          locs.push({
            message: e.text,
            path: path.join(config.projectRoot, e.location.file),
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

  let start = async () => {
    log(`start()`);
    let build: null | esbuild.BuildIncremental = null;
    started = true;
    previousOutput = null;
    currentBuildStart = performance.now();
    try {
      build = await esbuild.build({
        absWorkingDir: config.projectRoot,
        entryPoints: config.entryPoints,
        entryNames: "[dir]/[name]-[hash]",
        outdir: buildPath,
        bundle: true,
        loader: { ".js": "jsx" },
        metafile: true,
        splitting: platform === "browser",
        treeShaking: env === "production",
        incremental: true,
        format: platform === "browser" ? "esm" : "cjs",
        platform,
        external: config.external ?? [],
        minify: env === "production",
        logLevel: "silent",
        sourcemap: env === "production" ? "external" : "inline",
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
      await onBuild(build);
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
    started = false;
  };

  let rebuild = async () => {
    log(`rebuild()`);
    if (initialBuild.isResolved) {
      log(`initialBuild.isResolved`);
      let ib = initialBuild.value;
      if (!current.isCompleted) await current.promise;
      if (current.isResolved) current.value.build.stop?.();
      current = deferredWithCatch();
      currentBuildStart = performance.now();
      let build: esbuild.BuildIncremental | null = null;
      try {
        build = await ib.rebuild();
      } catch (err: any) {
        onBuildError(err);
        return;
      }
      if (build != null) {
        await onBuild(build);
      }
    } else if (initialBuild.isRejected) {
      log(`initialBuild.isRejected`);
      initialBuild = deferredWithCatch();
      current = deferredWithCatch();
      start();
    } else {
      log(`await initialBuild`);
      await initialBuild.promise;
      await rebuild();
    }
  };

  let ready = async () => {
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
        return current.value.output;
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

/**
 * Get a map from entryPoint names to output files.
 *
 * This correlates info from esbuild.Metafile to BuildConfig.entryPoints.
 * TODO: make sure this jjj
 */
function outputByEntryPoint<E extends EnrtyPoints>(
  entryPoints: E,
  buildPath: string,
  projectRoot: string,
  metafile: esbuild.Metafile
): Output<E> {
  let names: (keyof E)[] = Object.keys(entryPoints);
  let map: Output<E> = {} as any;
  let idx = 0;
  Object.entries(metafile.outputs).forEach(([outputPath, output]) => {
    let name = names[idx];
    if (name == null) return;
    if (output.entryPoint == null) return;
    idx = idx + 1;
    outputPath = path.join(projectRoot, outputPath);
    map[name] = {
      outputPath,
      relativeOutputPath: path.relative(buildPath, outputPath),
    };
  });
  return map;
}
