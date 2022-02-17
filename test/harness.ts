import * as path from "path";
import * as fs from "fs";
import { default as execa, ExecaChildProcess } from "execa";

export type TestProjectSpec = {
  files: { [name: string]: string };
};

export type TestProject = {
  projectRoot: string;
  writeFile: (path: string, content: string) => Promise<void>;
  exec: (cmd: string, args: string[]) => ExecaChildProcess;
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
    path.join(projectRoot, "package.json"),
    JSON.stringify({
      name: path.basename(projectRoot),
      version: "0.1.0",
      dependencies: {
        "@mechanize/asap": `link:${asapRoot}`,
        react: `rc`,
        "react-dom": `rc`,
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

  let dispose: TestProject["dispose"] = async () => {
    await exec("rm", ["-rf", projectRoot]);
  };

  await exec("pnpm", ["install"]);

  return { projectRoot, exec, writeFile, dispose };
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
