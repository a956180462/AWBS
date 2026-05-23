import { randomUUID } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { VIEW_MANIFEST } from "../domain/constants.ts";
import { AwbsError } from "../domain/errors.ts";
import { assertUserDataPaths } from "../domain/path-policy.ts";
import { fromPosixPath, normalizeUserPaths } from "../domain/paths.ts";
import type { AuthorityCatalogView, AuthorityViewContract, AuthorityViewSource } from "../domain/authority-types.ts";
import type { IndexKind, ViewManifest } from "../domain/types.ts";
import type { AuthorityPort } from "../ports/authority.ts";
import type { FileDatabasePort } from "../ports/file-database.ts";
import type { GitPort } from "../ports/git.ts";
import { requireTrustedCommit, withTrustedWorktree } from "./trusted-chain.ts";

export type ViewUseCases = {
  createView(cwd: string, args: { out: string; readPaths: string[]; writePaths: string[] }): ViewManifest;
  inspectView(cwd: string, viewId: string): { contract: AuthorityViewContract; catalogView: AuthorityCatalogView };
  revokeView(cwd: string, viewId: string): AuthorityViewContract;
};

export function createViewUseCases(deps: { files: FileDatabasePort; git: GitPort; authority: AuthorityPort }): ViewUseCases {
  return {
    createView(cwd: string, args: { out: string; readPaths: string[]; writePaths: string[] }): ViewManifest {
      const root = deps.files.findProjectRoot(cwd);
      deps.authority.ensureInitialized(root);
      const baseCommit = requireTrustedCommit(deps.git, root);
      const workspacePath = resolve(root, args.out);
      assertWorkspaceOutputPath(root, workspacePath);
      deps.files.assertSafeOutputDirectory(workspacePath);

      const readPaths = normalizeUserPaths(args.readPaths);
      const writePaths = normalizeUserPaths(args.writePaths);
      if (readPaths.length === 0 && writePaths.length === 0) {
        throw new AwbsError("view create requires at least one --read or --write path.");
      }
      assertUserDataPaths(readPaths, "project");
      assertUserDataPaths(writePaths, "project");

      const selectedPaths = uniquePaths([...readPaths, ...writePaths]);

      const viewId = randomUUID();
      const baselineRoot = join(root, ".awbs", "views", viewId, "baseline");
      const sources: ViewManifest["sources"] = [];
      const contractSources: AuthorityViewSource[] = [];

      deps.files.ensureDir(workspacePath);
      deps.files.ensureDir(baselineRoot);

      withTrustedWorktree(deps, root, baseCommit, "awbs-view-", (trustedRoot) => {
        for (const relPath of selectedPaths) {
          const trustedSourceAbs = join(trustedRoot, fromPosixPath(relPath));
          if (!deps.files.pathExists(trustedSourceAbs)) {
            throw new AwbsError(`Selected path does not exist in trusted database: ${relPath}`);
          }
          const sourceAbs = join(root, fromPosixPath(relPath));
          const workspaceAbs = join(workspacePath, fromPosixPath(relPath));
          const baselineAbs = join(baselineRoot, fromPosixPath(relPath));
          deps.files.copyPath(trustedSourceAbs, workspaceAbs);
          deps.files.copyPath(trustedSourceAbs, baselineAbs);
          const kind: IndexKind = deps.files.isDirectory(trustedSourceAbs) ? "directory" : "file";
          const sha256 = kind === "file" ? deps.files.sha256File(trustedSourceAbs) : null;
          sources.push({
            path: relPath,
            sourcePath: sourceAbs,
            workspacePath: workspaceAbs,
            baselinePath: baselineAbs,
            kind,
            sha256
          });
          contractSources.push({
            path: relPath,
            sourcePath: sourceAbs,
            workspacePath: workspaceAbs,
            baselinePath: baselineAbs,
            kind,
            sha256,
            mode: writePaths.includes(relPath) ? "write" : "read",
            ext: {}
          });
        }
      });

      const createdAt = new Date().toISOString();
      const contract: AuthorityViewContract = {
        schemaVersion: 1,
        viewId,
        baseCommit,
        createdAt,
        readPaths,
        writePaths,
        sources: contractSources,
        ext: { workspacePath }
      };
      deps.authority.createView(root, contract);

      const manifest: ViewManifest = {
        schemaVersion: 1,
        viewId,
        projectRoot: root,
        workspacePath,
        baseCommit,
        createdAt,
        readPaths,
        writePaths,
        sources
      };

      deps.files.writeJson(join(workspacePath, VIEW_MANIFEST), manifest);
      deps.files.writeJson(join(root, ".awbs", "views", viewId, "manifest.json"), manifest);
      return manifest;
    },

    inspectView(cwd: string, viewId: string): { contract: AuthorityViewContract; catalogView: AuthorityCatalogView } {
      const root = deps.files.findProjectRoot(cwd);
      const contract = deps.authority.getViewContract(root, viewId, { allowRevoked: true });
      const catalog = deps.authority.readCatalog(root);
      const catalogView = catalog.views.find((view) => view.viewId === viewId);
      if (!catalogView) {
        throw new AwbsError(`View is not registered in authority catalog: ${viewId}`);
      }
      return { contract, catalogView };
    },

    revokeView(cwd: string, viewId: string): AuthorityViewContract {
      const root = deps.files.findProjectRoot(cwd);
      return deps.authority.revokeView(root, viewId);
    }
  };
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    if (!seen.has(path)) {
      seen.add(path);
      result.push(path);
    }
  }
  return result;
}

function assertWorkspaceOutputPath(root: string, workspacePath: string): void {
  const rootPath = resolve(root);
  const outputPath = resolve(workspacePath);
  if (outputPath === rootPath) {
    throw new AwbsError("Workspace output cannot be the database root.");
  }

  for (const reserved of [".awbs", ".git"]) {
    const reservedPath = resolve(rootPath, reserved);
    if (isSameOrInside(reservedPath, outputPath)) {
      throw new AwbsError(`Workspace output cannot be inside AWBS reserved directory: ${reserved}`);
    }
  }
}

function isSameOrInside(parent: string, child: string): boolean {
  const parentPath = pathKey(resolve(parent));
  const childPath = pathKey(resolve(child));
  const rel = relative(parentPath, childPath);
  return childPath === parentPath || (!rel.startsWith("..") && !rel.includes(":"));
}

function pathKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}
