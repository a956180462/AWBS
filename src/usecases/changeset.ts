import { randomUUID } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { VIEW_MANIFEST, TRUSTED_REF } from "../domain/constants.ts";
import { AwbsError } from "../domain/errors.ts";
import { contentHash } from "../domain/hash.ts";
import { assertSafeRelativePath, filterIgnoredStatus, fromPosixPath, isPathUnderAny, makeId, toPosixPath } from "../domain/paths.ts";
import type { ChangeKind, ChangeRecord, ChangesetManifest, ViewManifest } from "../domain/types.ts";
import type { AuthorityPort } from "../ports/authority.ts";
import type { FileDatabasePort } from "../ports/file-database.ts";
import type { GitPort } from "../ports/git.ts";
import { copyCurrentAuthorityMaterial, requireTrustedCommit, withTrustedWorktree } from "./trusted-chain.ts";

export type ChangesetUseCases = {
  collectChangeset(cwd: string, workspaceInput: string): ChangesetManifest;
  inspectChangeset(cwd: string, changesetInput: string): ChangesetManifest;
  applyChangeset(cwd: string, changesetInput: string, adapter: string): { commit: string | null; applied: number };
  formatChangesetSummary(manifest: ChangesetManifest): string;
};

export function createChangesetUseCases(deps: { files: FileDatabasePort; git: GitPort; authority: AuthorityPort }): ChangesetUseCases {
  return {
    collectChangeset(cwd: string, workspaceInput: string): ChangesetManifest {
      const workspacePath = resolve(cwd, workspaceInput);
      const root = deps.files.findProjectRoot(cwd);
      const viewManifestPath = join(workspacePath, VIEW_MANIFEST);
      if (!deps.files.pathExists(viewManifestPath)) {
        throw new AwbsError(`Workspace manifest not found: ${viewManifestPath}`);
      }

      const view = deps.files.readJson<ViewManifest>(viewManifestPath);
      const contract = deps.authority.getViewContract(root, view.viewId);
      assertWorkspaceMatchesContract(workspacePath, contract.ext.workspacePath);
      const baselineRoot = join(root, ".awbs", "views", view.viewId, "baseline");
      if (!deps.files.pathExists(baselineRoot)) {
        throw new AwbsError(`Baseline not found for view ${view.viewId}`);
      }

      const baseline = deps.files.snapshotFiles(baselineRoot, { ignoreAwbsViewManifest: false });
      const current = deps.files.snapshotFiles(workspacePath, { ignoreAwbsViewManifest: true });
      const changesetId = makeId("changeset");
      const changesetRoot = join(root, ".awbs", "changesets", changesetId);
      const filesRoot = join(changesetRoot, "files");
      deps.files.ensureDir(filesRoot);

      const changes: ChangeRecord[] = [];
      const allPaths = new Set<string>([...baseline.keys(), ...current.keys()]);
      const sortedPaths = [...allPaths].sort((a, b) => a.localeCompare(b));

      for (const relPath of sortedPaths) {
        const before = baseline.get(relPath);
        const after = current.get(relPath);
        const kind = classifyChange(Boolean(before), before?.sha256 ?? null, Boolean(after), after?.sha256 ?? null);
        if (!kind) {
          continue;
        }

        const allowed = isPathUnderAny(relPath, contract.writePaths);
        const record: ChangeRecord = {
          path: relPath,
          kind,
          allowed,
          reason: allowed ? undefined : "Path is not within writePaths."
        };

        if (after && (kind === "add" || kind === "modify")) {
          const source = join(workspacePath, fromPosixPath(relPath));
          const destination = join(filesRoot, fromPosixPath(relPath));
          deps.files.copyPath(source, destination);
          record.file = toPosixPath(relative(changesetRoot, destination));
          record.sha256 = after.sha256;
        }

        changes.push(record);
      }

      const violations = changes.filter((change) => !change.allowed);
      const manifest: ChangesetManifest = {
        schemaVersion: 1,
        changesetId,
        viewId: view.viewId,
        baseCommit: contract.baseCommit,
        createdAt: new Date().toISOString(),
        projectRoot: root,
        workspacePath,
        status: violations.length === 0 ? "valid" : "invalid",
        readPaths: contract.readPaths,
        writePaths: contract.writePaths,
        changes,
        violations,
        summary: {
          added: changes.filter((change) => change.kind === "add").length,
          modified: changes.filter((change) => change.kind === "modify").length,
          deleted: changes.filter((change) => change.kind === "delete").length,
          violations: violations.length
        }
      };

      deps.files.writeJson(join(changesetRoot, "manifest.json"), manifest);
      deps.files.writeText(join(changesetRoot, "diff.patch"), deps.git.diffNoIndex(baselineRoot, workspacePath));
      return manifest;
    },

    inspectChangeset(cwd: string, changesetInput: string): ChangesetManifest {
      const changesetRoot = resolveChangesetPath(deps.files, cwd, changesetInput);
      return deps.files.readJson<ChangesetManifest>(join(changesetRoot, "manifest.json"));
    },

    applyChangeset(cwd: string, changesetInput: string, adapter: string): { commit: string | null; applied: number } {
      if (adapter !== "same-path") {
        throw new AwbsError(`Unsupported adapter: ${adapter}. v0 only supports same-path.`);
      }

      const changesetRoot = resolveChangesetPath(deps.files, cwd, changesetInput);
      const manifest = deps.files.readJson<ChangesetManifest>(join(changesetRoot, "manifest.json"));
      const root = manifest.projectRoot;
      const contract = deps.authority.getViewContract(root, manifest.viewId);
      const authorityReport = deps.authority.verify(root);
      if (!authorityReport.ok) {
        throw new AwbsError(`Authority verification failed:\n${authorityReport.errors.join("\n")}`);
      }

      if (manifest.status !== "valid" || manifest.violations.length > 0) {
        throw new AwbsError(`Changeset ${manifest.changesetId} is invalid and cannot be applied.`);
      }
      const forbiddenChanges = manifest.changes.filter((change) => !isPathUnderAny(change.path, contract.writePaths));
      if (forbiddenChanges.length > 0) {
        throw new AwbsError(`Changeset ${manifest.changesetId} modifies read-only path(s) and cannot be applied.`);
      }

      if (manifest.baseCommit !== contract.baseCommit) {
        throw new AwbsError(`Changeset base ${manifest.baseCommit} does not match sealed view contract base ${contract.baseCommit}.`);
      }

      const currentTrustedCommit = requireTrustedCommit(deps.git, root);
      if (contract.baseCommit !== currentTrustedCommit) {
        throw new AwbsError(`Stale view. Current trusted commit is ${currentTrustedCommit}, changeset base is ${contract.baseCommit}. Create a new view from the current trusted database.`);
      }

      const workspaceRel = toPosixPath(relative(root, manifest.workspacePath));
      const dirty = filterIgnoredStatus(deps.git.statusPorcelain(root), root, [workspaceRel, ".awbs/authority"]);
      const head = deps.git.headCommit(root);
      const canApplyInPlace = head === currentTrustedCommit && dirty.trim().length === 0;
      const applyTargetRoot = canApplyInPlace ? root : null;
      const applyInTarget = (targetRoot: string): { commit: string | null; applied: number } => {
        if (targetRoot !== root) {
          copyCurrentAuthorityMaterial(root, targetRoot);
        }
        const appliedPaths = applyFilesToTarget(deps, changesetRoot, manifest, targetRoot);
        if (appliedPaths.length === 0) {
          return { commit: null, applied: 0 };
        }

        const ledgerEntry = {
          schemaVersion: 1,
          entryId: randomUUID(),
          kind: "changeset",
          parentTrustedCommit: currentTrustedCommit,
          baseCommit: contract.baseCommit,
          changesetId: manifest.changesetId,
          viewId: manifest.viewId,
          createdAt: new Date().toISOString(),
          appliedPaths,
          changesetManifestHash: contentHash(manifest),
          authorityContractHash: contentHash(contract),
          operationHash: contentHash({
            kind: "changeset",
            parentTrustedCommit: currentTrustedCommit,
            baseCommit: contract.baseCommit,
            changesetId: manifest.changesetId,
            viewId: manifest.viewId,
            appliedPaths,
            changesetManifestHash: contentHash(manifest),
            authorityContractHash: contentHash(contract)
          }),
          ext: {}
        } as const;

        deps.authority.appendLedgerEntry(targetRoot, ledgerEntry);
        deps.git.addAll(targetRoot, [...appliedPaths.map(fromPosixPath), ".awbs/authority"]);
        deps.git.commit(
          targetRoot,
          [
            `awbs: apply ${manifest.changesetId}`,
            "",
            `AWBS-Ledger-Entry: ${ledgerEntry.entryId}`,
            `AWBS-Operation-Hash: ${ledgerEntry.operationHash}`,
            `AWBS-Parent-Trusted-Commit: ${currentTrustedCommit}`
          ].join("\n")
        );
        const nextTrustedCommit = deps.git.requireHeadCommit(targetRoot);
        deps.git.updateRef(root, TRUSTED_REF, nextTrustedCommit);
        return { commit: nextTrustedCommit, applied: appliedPaths.length };
      };

      if (applyTargetRoot) {
        return applyInTarget(applyTargetRoot);
      }

      return withTrustedWorktree(deps, root, currentTrustedCommit, "awbs-apply-", applyInTarget);
    },

    formatChangesetSummary(manifest: ChangesetManifest): string {
      const lines = [
        `Changeset: ${manifest.changesetId}`,
        `Status: ${manifest.status}`,
        `View: ${manifest.viewId}`,
        `Base commit: ${manifest.baseCommit}`,
        `Added: ${manifest.summary.added}`,
        `Modified: ${manifest.summary.modified}`,
        `Deleted: ${manifest.summary.deleted}`,
        `Violations: ${manifest.summary.violations}`
      ];

      if (manifest.changes.length > 0) {
        lines.push("", "Changes:");
        for (const change of manifest.changes) {
          lines.push(`  ${change.allowed ? " " : "!"} ${change.kind.padEnd(6)} ${change.path}`);
        }
      }

      if (manifest.violations.length > 0) {
        lines.push("", "Violations:");
        for (const violation of manifest.violations) {
          lines.push(`  ${violation.path}: ${violation.reason ?? "not allowed"}`);
        }
      }

      return lines.join("\n");
    }
  };
}

function classifyChange(hasBefore: boolean, beforeSha: string | null, hasAfter: boolean, afterSha: string | null): ChangeKind | null {
  if (!hasBefore && hasAfter) {
    return "add";
  }
  if (hasBefore && !hasAfter) {
    return "delete";
  }
  if (hasBefore && hasAfter && beforeSha !== afterSha) {
    return "modify";
  }
  return null;
}

function applyFilesToTarget(
  deps: { files: FileDatabasePort },
  changesetRoot: string,
  manifest: ChangesetManifest,
  targetRoot: string
): string[] {
  const appliedPaths: string[] = [];
  for (const change of manifest.changes) {
    if (!change.allowed) {
      continue;
    }
    assertSafeRelativePath(change.path);
    const target = join(targetRoot, fromPosixPath(change.path));
    if (change.kind === "delete") {
      deps.files.removePath(target);
    } else {
      if (!change.file) {
        throw new AwbsError(`Missing file payload for ${change.path}`);
      }
      const payload = join(changesetRoot, fromPosixPath(change.file));
      deps.files.copyPath(payload, target);
    }
    appliedPaths.push(change.path);
  }
  return appliedPaths;
}

function resolveChangesetPath(files: FileDatabasePort, cwd: string, input: string): string {
  const direct = resolve(cwd, input);
  if (files.pathExists(join(direct, "manifest.json"))) {
    return direct;
  }
  const root = files.findProjectRoot(cwd);
  const byId = join(root, ".awbs", "changesets", input);
  if (files.pathExists(join(byId, "manifest.json"))) {
    return byId;
  }
  throw new AwbsError(`Changeset not found: ${input}`);
}

function assertWorkspaceMatchesContract(workspacePath: string, contractWorkspacePath: unknown): void {
  if (typeof contractWorkspacePath !== "string") {
    return;
  }
  if (resolve(contractWorkspacePath) !== workspacePath) {
    throw new AwbsError("Workspace path does not match the sealed view contract.");
  }
}
