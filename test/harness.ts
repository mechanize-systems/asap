import * as path from "path";
import * as fs from "fs";
import waitPort from "wait-port";
import { default as execa, ExecaChildProcess } from "execa";

export type TestProjectSpec = {
  files: { [name: string]: string };
};

export type TestProject = {
  projectRoot: string;
  writeFile: (path: string, content: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
  exec: (cmd: string, args: string[]) => ExecaChildProcess;
  serve: (args: string[]) => Promise<{
    port: number;
    process: execa.ExecaChildProcess<string>;
  }>;
  dispose: () => Promise<void>;
};

/**
 * Create a new ASAP project and install all the dependencies.
 */
export async function createTestProject(
  spec: TestProjectSpec
): Promise<TestProject> {
  let asapRoot = path.dirname(__dirname);
  let projectRoot = await fs.promises.mkdtemp(path.join(__dirname, "test-"));

  await fs.promises.writeFile(
    path.join(projectRoot, "pnpm-workspace.yaml"),
    ""
  );

  await fs.promises.writeFile(
    path.join(projectRoot, "package.json"),
    JSON.stringify({
      name: path.basename(projectRoot),
      version: "0.1.0",
      dependencies: {
        "@mechanize/asap": `file:${asapRoot}`,
        react: "18.2.0",
        "react-dom": "18.2.0",
      },
    })
  );

  await Promise.all(
    Object.entries(spec.files).map(async ([p, contents]) => {
      p = path.join(projectRoot, p);
      await fs.promises.writeFile(p, contents);
    })
  );

  let exec: TestProject["exec"] = (cmd, args) =>
    execa(cmd, args, { cwd: projectRoot });

  let writeFile: TestProject["writeFile"] = (p: string, content: string) =>
    fs.promises.writeFile(path.join(projectRoot, p), content);

  let unlink: TestProject["unlink"] = (p: string) =>
    fs.promises.unlink(path.join(projectRoot, p));

  let dispose: TestProject["dispose"] = async () => {
    await exec("rm", ["-rf", projectRoot]);
  };

  let serve = async (args: string[]) => {
    let port = 7777;
    let p = exec("asap", ["serve", `--port=${port}`, ...args]);
    await waitPort({ port, output: "silent" });
    return { port, process: p };
  };

  await exec("pnpm", ["install"]);

  return { projectRoot, exec, serve, writeFile, unlink, dispose };
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
