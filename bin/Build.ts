/**
 * Build service.
 *
 * This provides a wrapper on top of esbuild's incremental builds.
 */

import * as path from "path";
import * as esbuild from "esbuild";
import { deferred } from "./PromiseUtil";
import debug from "debug";

export type BuildConfig = {
  buildId: string;
  projectRoot: string;
  entryPoints: { [out: string]: string };
};

/**
 * BuildService exposes methods for managing a build process.
 */
export type BuildService = {
  /** The path which hosts the output of tje build. */
  outputPath: string;
  /** Schedule a rebuild. */
  rebuild: () => Promise<void>;
  /** Promise which resolves when the currently running build has completed. */
  ready: () => Promise<void>;
  /** Stop the build process. */
  stop: () => Promise<void>;
};

/** Start the build service. */
export function build(config: BuildConfig): BuildService {
  let log = debug(`asap:Build:${config.buildId}`);

  let outputPath = path.join(
    config.projectRoot,
    "node_modules",
    ".cache",
    "asap",
    "build",
    config.buildId
  );

  let initialBuild = deferred<esbuild.BuildIncremental>();
  let currentBuild = deferred<esbuild.BuildIncremental>();
  let currentBuildStart = performance.now();

  let onBuild = (b: esbuild.BuildIncremental) => {
    let spent = performance.now() - currentBuildStart;
    log(`built in %sms`, spent.toFixed(0));
    currentBuild.resolve(b);
  };

  log(`starting initial build`);
  esbuild
    .build({
      absWorkingDir: config.projectRoot,
      entryPoints: config.entryPoints,
      outdir: outputPath,
      bundle: true,
      loader: { ".js": "jsx" },
      metafile: true,
      splitting: true,
      incremental: true,
      format: "esm",
    })
    .then((build) => {
      initialBuild.resolve(build);
      onBuild(build);
    });

  return {
    outputPath,
    async stop() {
      let [ib, cb] = await Promise.all([
        initialBuild.promise,
        currentBuild.promise,
      ]);
      ib.stop?.();
      cb.stop?.();
    },
    async ready() {
      await currentBuild.promise;
    },
    async rebuild() {
      log(`rebuilding`);
      if (!currentBuild.isCompleted) {
        await currentBuild.promise;
      }
      currentBuild.value.stop?.();
      currentBuild = deferred();
      currentBuildStart = performance.now();
      onBuild(await (await initialBuild.promise).rebuild());
    },
  };
}
