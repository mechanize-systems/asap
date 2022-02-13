import findWorkspaceDir from "@pnpm/find-workspace-dir";
import findWorkspacePackages from "@pnpm/find-workspace-packages";

export type Workspace = {
  kind: "pnpm";
  path: string;
  packageNames: Set<string>;
};

/**
 * Find if there's active workspace at the specified path.
 *
 * For now only `pnpm` workspaces are supported but in the future we might get
 * support for npm, yarn workspaces as well.
 */
export async function find(cwd: string): Promise<Workspace | null> {
  let workspaceDir = await findWorkspaceDir(cwd);
  if (workspaceDir == null) return null;
  let workspacePackages = await findWorkspacePackages(workspaceDir);
  let workspace: Workspace = {
    kind: "pnpm",
    path: workspaceDir,
    packageNames: new Set(),
  };
  for (let p of workspacePackages) {
    if (p.manifest.name == null) continue;
    workspace.packageNames.add(p.manifest.name);
  }
  return workspace;
}
