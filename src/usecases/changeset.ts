import { join, relative, resolve } from "node:path";
import { VIEW_MANIFEST, TRUSTED_REF } from "../domain/constants.ts";
import { AwbsError } from "../domain/errors.ts";
import { contentHash } from "../domain/hash.ts";
import { assertUserDataPath, isPathAllowedByWritePaths } from "../domain/path-policy.ts";
import { assertSafeRelativePath, filterIgnoredStatus, fromPosixPath, isPathUnderAny, makeId, toPosixPath } from "../domain/paths.ts";
import type { ChangeKind, ChangeRecord, ChangesetManifest, ViewManifest } from "../domain/types.ts";
import type { AuthorityAppliedPathState, AuthorityCatalog, AuthorityChangesetReceipt } from "../domain/authority-types.ts";
import type { AuthorityPort } from "../ports/authority.ts";
import type { FileDatabasePort } from "../ports/file-database.ts";
import type { GitPort } from "../ports/git.ts";
import { requireVerifiedTrustedCommit } from "./ledger.ts";
import { withTrustedWorktree } from "./trusted-chain.ts";

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

        const policyError = dataPathPolicyError(relPath);
        const allowed = !policyError && isPathUnderAny(relPath, contract.writePaths);
        const record: ChangeRecord = {
          path: relPath,
          kind,
          allowed,
          reason: allowed ? undefined : policyError ?? "Path is not within writePaths."
        };

        if (after && (kind === "add" || kind === "modify")) {
          record.sha256 = after.sha256;
          if (allowed) {
            const source = join(workspacePath, fromPosixPath(relPath));
            const destination = join(filesRoot, fromPosixPath(relPath));
            deps.files.copyPath(source, destination);
            record.file = toPosixPath(relative(changesetRoot, destination));
          }
        }

        changes.push(record);
      }

      const violations = changes.filter((change) => !change.allowed);
      const payloadHash = computeChangesetPayloadHash(deps.files, changesetRoot, changes);
      const manifestBase = {
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
        },
        payloadHash
      } satisfies Omit<ChangesetManifest, "operationHash">;
      const manifest: ChangesetManifest = {
        ...manifestBase,
        operationHash: computeChangesetOperationHash(manifestBase)
      };

      deps.files.writeJson(join(changesetRoot, "manifest.json"), manifest);
      deps.files.writeText(join(changesetRoot, "diff.patch"), deps.git.diffNoIndex(baselineRoot, workspacePath));
      deps.authority.sealChangesetReceipt(root, changesetRoot, createChangesetReceipt(manifest));
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
      assertChangesetIntegrity(deps.files, changesetRoot, manifest);
      const root = manifest.projectRoot;
      assertChangesetReceipt(deps.authority.openChangesetReceipt(root, changesetRoot), manifest);
      const contract = deps.authority.getViewContract(root, manifest.viewId);
      const authorityReport = deps.authority.verify(root);
      if (authorityReport.errors.length > 0) {
        throw new AwbsError(`Authority verification failed:\n${authorityReport.errors.join("\n")}`);
      }

      if (manifest.status !== "valid" || manifest.violations.length > 0) {
        throw new AwbsError(`Changeset ${manifest.changesetId} is invalid and cannot be applied.`);
      }
      const forbiddenChanges = manifest.changes.filter((change) => !isPathAllowedByWritePaths(change.path, contract.writePaths));
      if (forbiddenChanges.length > 0) {
        throw new AwbsError(`Changeset ${manifest.changesetId} modifies read-only path(s) and cannot be applied.`);
      }

      if (manifest.baseCommit !== contract.baseCommit) {
        throw new AwbsError(`Changeset base ${manifest.baseCommit} does not match sealed view contract base ${contract.baseCommit}.`);
      }

      const currentTrustedCommit = requireVerifiedTrustedCommit(deps, root);
      if (contract.baseCommit !== currentTrustedCommit) {
        throw new AwbsError(`Stale view. Current trusted commit is ${currentTrustedCommit}, changeset base is ${contract.baseCommit}. Create a new view from the current trusted database.`);
      }

      const workspaceRel = toPosixPath(relative(root, manifest.workspacePath));
      const dirty = filterIgnoredStatus(deps.git.statusPorcelain(root), root, [workspaceRel, ...preApplyAuthorityPaths(deps, root)]);
      const head = deps.git.headCommit(root);
      const canApplyInPlace = head === currentTrustedCommit && dirty.trim().length === 0;
      const applyTargetRoot = canApplyInPlace ? root : null;
      const applyInTarget = (targetRoot: string): { commit: string | null; applied: number } => {
        if (targetRoot !== root) {
          copyPreApplyAuthorityMaterial(deps, root, targetRoot);
        }
        const appliedPaths = applyFilesToTarget(deps, changesetRoot, manifest, targetRoot);
        if (appliedPaths.length === 0) {
          return { commit: null, applied: 0 };
        }
        deps.git.addAll(targetRoot, appliedPaths.map(fromPosixPath));
        const appliedPathStates = computeAppliedPathStates(deps.git, targetRoot, manifest);

        const changesetManifestHash = contentHash(manifest);
        const authorityContractHash = contentHash(contract);
        const ledgerEntry = deps.authority.recordChangesetApply(targetRoot, {
          schemaVersion: 1,
          parentTrustedCommit: currentTrustedCommit,
          baseCommit: contract.baseCommit,
          changesetId: manifest.changesetId,
          viewId: manifest.viewId,
          appliedPaths,
          appliedPathStates,
          changesetManifestHash,
          changesetPayloadHash: manifest.payloadHash,
          authorityContractHash,
          ext: {}
        });
        deps.authority.repairMirrors(targetRoot);
        deps.git.addAll(targetRoot, authorityCommitPaths(deps, targetRoot));
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
  for (const change of manifest.changes) {
    if (!change.allowed) {
      continue;
    }
    assertUserDataPath(change.path, "apply changes to");
    if (change.kind !== "delete") {
      assertPayloadRecord(deps.files, changesetRoot, change);
    }
  }

  const appliedPaths: string[] = [];
  for (const change of manifest.changes) {
    if (!change.allowed) {
      continue;
    }
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

function computeAppliedPathStates(git: GitPort, targetRoot: string, manifest: ChangesetManifest): AuthorityAppliedPathState[] {
  const states: AuthorityAppliedPathState[] = [];
  for (const change of manifest.changes.filter((item) => item.allowed)) {
    assertUserDataPath(change.path, "record trusted state for");
    if (change.kind === "delete") {
      states.push({ path: change.path, kind: "deleted", sha256: null });
      continue;
    }
    if (!git.pathExistsInIndex(targetRoot, change.path)) {
      throw new AwbsError(`Applied path is not staged for commit: ${change.path}`);
    }
    states.push({ path: change.path, kind: "file", sha256: git.fileSha256InIndex(targetRoot, change.path) });
  }
  return states.sort((a, b) => a.path.localeCompare(b.path));
}

function dataPathPolicyError(path: string): string | null {
  try {
    assertUserDataPath(path, "include in a changeset");
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function assertChangesetIntegrity(files: FileDatabasePort, changesetRoot: string, manifest: ChangesetManifest): void {
  for (const change of manifest.changes) {
    assertUserDataPath(change.path, "apply changes to");
    if (change.kind !== "delete" && change.allowed) {
      assertPayloadRecord(files, changesetRoot, change);
    }
  }

  const payloadHash = computeChangesetPayloadHash(files, changesetRoot, manifest.changes);
  if (payloadHash !== manifest.payloadHash) {
    throw new AwbsError(`Changeset payload hash mismatch for ${manifest.changesetId}.`);
  }

  const operationHash = computeChangesetOperationHash({
    ...manifest,
    operationHash: undefined
  });
  if (operationHash !== manifest.operationHash) {
    throw new AwbsError(`Changeset operation hash mismatch for ${manifest.changesetId}.`);
  }
}

function assertPayloadRecord(files: FileDatabasePort, changesetRoot: string, change: ChangeRecord): void {
  if (!change.file) {
    throw new AwbsError(`Missing file payload for ${change.path}`);
  }
  assertSafeRelativePath(change.file);
  if (!change.file.startsWith("files/")) {
    throw new AwbsError(`Invalid file payload path for ${change.path}`);
  }
  const payload = join(changesetRoot, fromPosixPath(change.file));
  if (!files.pathExists(payload)) {
    throw new AwbsError(`Missing file payload for ${change.path}`);
  }
  const actualSha = files.sha256File(payload);
  if (actualSha !== change.sha256) {
    throw new AwbsError(`Changeset payload sha256 mismatch for ${change.path}.`);
  }
}

function computeChangesetPayloadHash(files: FileDatabasePort, changesetRoot: string, changes: ChangeRecord[]): string {
  const payloads = changes
    .filter((change) => change.allowed && change.kind !== "delete")
    .map((change) => {
      assertPayloadRecord(files, changesetRoot, change);
      return {
        path: change.path,
        kind: change.kind,
        file: change.file,
        sha256: change.sha256
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  return contentHash(payloads);
}

function computeChangesetOperationHash(manifest: Omit<ChangesetManifest, "operationHash"> | (ChangesetManifest & { operationHash?: string | undefined })): string {
  const { operationHash: _operationHash, ...operation } = manifest as ChangesetManifest & { operationHash?: string };
  return contentHash(operation);
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

function createChangesetReceipt(manifest: ChangesetManifest): AuthorityChangesetReceipt {
  return {
    schemaVersion: 1,
    changesetId: manifest.changesetId,
    viewId: manifest.viewId,
    baseCommit: manifest.baseCommit,
    createdAt: new Date().toISOString(),
    payloadHash: manifest.payloadHash,
    operationHash: manifest.operationHash,
    manifestHash: contentHash(manifest),
    ext: {}
  };
}

function assertChangesetReceipt(receipt: AuthorityChangesetReceipt, manifest: ChangesetManifest): void {
  if (receipt.changesetId !== manifest.changesetId || receipt.viewId !== manifest.viewId || receipt.baseCommit !== manifest.baseCommit) {
    throw new AwbsError(`Changeset receipt identity mismatch for ${manifest.changesetId}.`);
  }
  if (receipt.payloadHash !== manifest.payloadHash) {
    throw new AwbsError(`Changeset receipt payload hash mismatch for ${manifest.changesetId}.`);
  }
  if (receipt.operationHash !== manifest.operationHash) {
    throw new AwbsError(`Changeset receipt operation hash mismatch for ${manifest.changesetId}.`);
  }
  if (receipt.manifestHash !== contentHash(manifest)) {
    throw new AwbsError(`Changeset receipt manifest hash mismatch for ${manifest.changesetId}.`);
  }
}

function assertWorkspaceMatchesContract(workspacePath: string, contractWorkspacePath: unknown): void {
  if (typeof contractWorkspacePath !== "string") {
    return;
  }
  if (resolve(contractWorkspacePath) !== workspacePath) {
    throw new AwbsError("Workspace path does not match the sealed view contract.");
  }
}

function authorityCommitPaths(deps: { files: FileDatabasePort; authority: AuthorityPort }, root: string): string[] {
  const catalog = deps.authority.readCatalog(root);
  const candidates = [
    ".awbs/authority/catalog.seal.json",
    ".awbs/authority/catalog.mirror.json",
    ".awbs/authority/view-events.jsonl",
    ".awbs/authority/ledger-events.jsonl",
    ".awbs/authority/ledger.seal.json",
    ".awbs/authority/ledger.mirror.json",
    ...viewAuthorityPaths(catalog)
  ];
  return candidates.filter((path) => deps.files.pathExists(join(root, fromPosixPath(path))));
}

function preApplyAuthorityPaths(deps: { files: FileDatabasePort; authority: AuthorityPort }, root: string): string[] {
  const catalog = deps.authority.readCatalog(root);
  const candidates = [".awbs/authority/catalog.seal.json", ".awbs/authority/catalog.mirror.json", ".awbs/authority/view-events.jsonl", ...viewAuthorityPaths(catalog)];
  return candidates.filter((path) => deps.files.pathExists(join(root, fromPosixPath(path))));
}

function copyPreApplyAuthorityMaterial(deps: { files: FileDatabasePort; authority: AuthorityPort }, root: string, targetRoot: string): void {
  for (const path of preApplyAuthorityPaths(deps, root)) {
    deps.files.copyPath(join(root, fromPosixPath(path)), join(targetRoot, fromPosixPath(path)));
  }
}

function viewAuthorityPaths(catalog: AuthorityCatalog): string[] {
  return catalog.views.flatMap((view) => [
    `.awbs/authority/views/${view.viewId}/contract.seal.json`,
    `.awbs/authority/views/${view.viewId}/mirror.json`,
    `.awbs/authority/views/${view.viewId}/receipt.json`
  ]);
}
