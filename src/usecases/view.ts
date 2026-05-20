import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { VIEW_MANIFEST } from "../domain/constants.ts";
import { AwbsError } from "../domain/errors.ts";
import { fromPosixPath, normalizeUserPaths } from "../domain/paths.ts";
import type { AuthorityCatalogView, AuthorityViewContract, AuthorityViewSource } from "../domain/authority-types.ts";
import type { IndexKind, ViewManifest } from "../domain/types.ts";
import type { AuthorityPort } from "../ports/authority.ts";
import type { FileDatabasePort } from "../ports/file-database.ts";
import type { GitPort } from "../ports/git.ts";

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
      const baseCommit = deps.git.requireHeadCommit(root);
      const workspacePath = resolve(root, args.out);
      deps.files.assertSafeOutputDirectory(workspacePath);

      const readPaths = normalizeUserPaths(args.readPaths);
      const writePaths = normalizeUserPaths(args.writePaths);
      if (readPaths.length === 0 && writePaths.length === 0) {
        throw new AwbsError("view create requires at least one --read or --write path.");
      }

      const selectedPaths = uniquePaths([...readPaths, ...writePaths]);
      for (const relPath of selectedPaths) {
        assertNotPrivateAuthorityMaterial(relPath);
        const absPath = join(root, fromPosixPath(relPath));
        if (!deps.files.pathExists(absPath)) {
          throw new AwbsError(`Selected path does not exist: ${relPath}`);
        }
      }

      const viewId = randomUUID();
      const baselineRoot = join(root, ".awbs", "views", viewId, "baseline");
      const sources: ViewManifest["sources"] = [];
      const contractSources: AuthorityViewSource[] = [];

      deps.files.ensureDir(workspacePath);
      deps.files.ensureDir(baselineRoot);

      for (const relPath of selectedPaths) {
        const sourceAbs = join(root, fromPosixPath(relPath));
        const workspaceAbs = join(workspacePath, fromPosixPath(relPath));
        const baselineAbs = join(baselineRoot, fromPosixPath(relPath));
        deps.files.copyPath(sourceAbs, workspaceAbs);
        deps.files.copyPath(sourceAbs, baselineAbs);
        const kind: IndexKind = deps.files.isDirectory(sourceAbs) ? "directory" : "file";
        sources.push({
          path: relPath,
          sourcePath: sourceAbs,
          workspacePath: workspaceAbs,
          baselinePath: baselineAbs,
          kind,
          sha256: kind === "file" ? deps.files.sha256File(sourceAbs) : null
        });
        contractSources.push({
          path: relPath,
          sourcePath: sourceAbs,
          workspacePath: workspaceAbs,
          baselinePath: baselineAbs,
          kind,
          sha256: kind === "file" ? deps.files.sha256File(sourceAbs) : null,
          mode: writePaths.includes(relPath) ? "write" : "read",
          ext: {}
        });
      }

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
      deps.authority.createViewContract(root, contract);

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

function assertNotPrivateAuthorityMaterial(path: string): void {
  if (path === ".awbs/private" || path.startsWith(".awbs/private/")) {
    throw new AwbsError(".awbs/private is authority material and cannot be projected into a workspace.");
  }
}
