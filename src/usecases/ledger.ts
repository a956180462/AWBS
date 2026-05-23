import { TRUSTED_REF } from "../domain/constants.ts";
import { AwbsError } from "../domain/errors.ts";
import { contentHash } from "../domain/hash.ts";
import type { AuthorityLedger, AuthorityLedgerEntry, AuthorityLedgerInspectReport } from "../domain/authority-types.ts";
import { filterIgnoredStatus } from "../domain/paths.ts";
import type { AuthorityPort } from "../ports/authority.ts";
import type { FileDatabasePort } from "../ports/file-database.ts";
import type { GitPort } from "../ports/git.ts";
import { withTrustedWorktree } from "./trusted-chain.ts";

export type LedgerBootstrapResult = {
  parentTrustedCommit: string;
  currentTrustedCommit: string;
  headEntryId: string | null;
};

export type LedgerUseCases = {
  bootstrapLedger(cwd: string): LedgerBootstrapResult;
  inspectLedger(cwd: string): AuthorityLedgerInspectReport;
  verifyLedger(cwd: string): AuthorityLedgerInspectReport;
  formatLedgerReport(report: AuthorityLedgerInspectReport): string;
};

export function createLedgerUseCases(deps: { files: FileDatabasePort; git: GitPort; authority: AuthorityPort }): LedgerUseCases {
  return {
    bootstrapLedger(cwd: string): LedgerBootstrapResult {
      const root = deps.files.findProjectRoot(cwd);
      deps.authority.ensureInitialized(root);
      if (deps.git.refCommit(root, TRUSTED_REF) || deps.authority.hasLedger(root)) {
        throw new AwbsError("AWBS trusted chain is already bootstrapped.");
      }

      const parentTrustedCommit = deps.git.requireHeadCommit(root);
      const dirtyBefore = filterIgnoredStatus(deps.git.statusPorcelain(root), root, [".awbs/authority/catalog.mirror.json"]);
      if (dirtyBefore.trim().length > 0) {
        throw new AwbsError(`Working tree must be clean before bootstrapping the trusted chain:\n${dirtyBefore}`);
      }

      const ledger = deps.authority.bootstrapLedger(root, parentTrustedCommit);
      deps.git.addAll(root, [".awbs/authority"]);
      const headEntry = ledger.entries.find((entry) => entry.entryId === ledger.headEntryId);
      deps.git.commit(
        root,
        [
          "awbs: bootstrap trusted chain",
          "",
          `AWBS-Ledger-Entry: ${headEntry?.entryId ?? ""}`,
          `AWBS-Operation-Hash: ${headEntry?.operationHash ?? ""}`,
          `AWBS-Parent-Trusted-Commit: ${parentTrustedCommit}`
        ].join("\n")
      );
      const currentTrustedCommit = deps.git.requireHeadCommit(root);
      deps.git.updateRef(root, TRUSTED_REF, currentTrustedCommit);
      return {
        parentTrustedCommit,
        currentTrustedCommit,
        headEntryId: ledger.headEntryId
      };
    },

    inspectLedger(cwd: string): AuthorityLedgerInspectReport {
      const root = deps.files.findProjectRoot(cwd);
      return inspectTrustedLedger(deps, root);
    },

    verifyLedger(cwd: string): AuthorityLedgerInspectReport {
      const root = deps.files.findProjectRoot(cwd);
      return inspectTrustedLedger(deps, root);
    },

    formatLedgerReport(report: AuthorityLedgerInspectReport): string {
      const lines = [
        `Trusted chain: ${report.ok ? "ok" : "failed"}`,
        `Current trusted commit: ${report.currentTrustedCommit ?? "(none)"}`,
        `Head entry: ${report.headEntryId ?? "(none)"}`,
        `Entries: ${report.entries}`
      ];
      if (report.errors.length > 0) {
        lines.push("", "Errors:");
        for (const error of report.errors) {
          lines.push(`  ${error}`);
        }
      }
      return lines.join("\n");
    }
  };
}

export function inspectTrustedLedger(
  deps: { files: FileDatabasePort; git: GitPort; authority: AuthorityPort },
  root: string
): AuthorityLedgerInspectReport {
  const errors: string[] = [];
  const currentTrustedCommit = deps.git.refCommit(root, TRUSTED_REF);
  let ledger: AuthorityLedger | null = null;

  if (!currentTrustedCommit) {
    errors.push("AWBS trusted chain is not bootstrapped.");
  } else {
    try {
      ledger = withTrustedWorktree(deps, root, currentTrustedCommit, "awbs-ledger-", (trustedRoot) =>
        deps.authority.readLedger(trustedRoot)
      );
      const headEntry = ledger.entries.find((entry) => entry.entryId === ledger?.headEntryId);
      if (!headEntry) {
        errors.push("Trusted ledger head entry is missing.");
      } else {
        errors.push(...verifyTrustedCommitBinding(deps.git, root, currentTrustedCommit, headEntry));
      }
      errors.push(...verifyLedgerHashChain(ledger));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    ok: errors.length === 0,
    currentTrustedCommit,
    headEntryId: ledger?.headEntryId ?? null,
    entries: ledger?.entries.length ?? 0,
    errors,
    ledger
  };
}

export function requireVerifiedTrustedCommit(
  deps: { files: FileDatabasePort; git: GitPort; authority: AuthorityPort },
  root: string
): string {
  const report = inspectTrustedLedger(deps, root);
  if (!report.ok || !report.currentTrustedCommit) {
    throw new AwbsError(`AWBS trusted chain verification failed:\n${report.errors.join("\n")}`);
  }
  return report.currentTrustedCommit;
}

function verifyLedgerHashChain(ledger: AuthorityLedger): string[] {
  const errors: string[] = [];
  let previousHash: string | null = null;
  const seen = new Set<string>();

  for (const entry of ledger.entries) {
    if (seen.has(entry.entryId)) {
      errors.push(`Duplicate ledger entry id: ${entry.entryId}`);
    }
    seen.add(entry.entryId);

    if (entry.previousEntryHash !== previousHash) {
      errors.push(`Ledger entry ${entry.entryId} does not link to the previous entry hash.`);
    }
    if (entry.entryHash !== ledgerEntryHash(entry)) {
      errors.push(`Ledger entry ${entry.entryId} hash mismatch.`);
    }
    previousHash = entry.entryHash;
  }

  const last = ledger.entries.at(-1);
  if (last && ledger.headEntryId !== last.entryId) {
    errors.push("Trusted ledger head entry is not the latest ledger entry.");
  }
  return errors;
}

function verifyTrustedCommitBinding(git: GitPort, root: string, currentTrustedCommit: string, headEntry: AuthorityLedgerEntry): string[] {
  const errors: string[] = [];
  const parents = git.commitParents(root, currentTrustedCommit);
  if (parents.length !== 1 || parents[0] !== headEntry.parentTrustedCommit) {
    errors.push(`Trusted commit parent does not match ledger parentTrustedCommit for entry ${headEntry.entryId}.`);
  }

  const message = git.commitMessage(root, currentTrustedCommit);
  if (!message.includes(`AWBS-Ledger-Entry: ${headEntry.entryId}`)) {
    errors.push(`Trusted commit message does not reference ledger entry ${headEntry.entryId}.`);
  }
  if (!message.includes(`AWBS-Operation-Hash: ${headEntry.operationHash}`)) {
    errors.push(`Trusted commit message does not reference operation hash for entry ${headEntry.entryId}.`);
  }
  if (!message.includes(`AWBS-Parent-Trusted-Commit: ${headEntry.parentTrustedCommit}`)) {
    errors.push(`Trusted commit message does not reference parent trusted commit for entry ${headEntry.entryId}.`);
  }

  const changedPaths = git.diffNameOnly(root, headEntry.parentTrustedCommit, currentTrustedCommit).map(normalizeGitPath);
  const allowedDataPaths = new Set(headEntry.appliedPaths.map(normalizeGitPath));
  for (const changedPath of changedPaths) {
    if (isAuthorityPath(changedPath)) {
      continue;
    }
    if (!allowedDataPaths.has(changedPath)) {
      errors.push(`Trusted commit changes path not declared by ledger entry ${headEntry.entryId}: ${changedPath}`);
    }
  }

  const statePaths = headEntry.appliedPathStates.map((state) => normalizeGitPath(state.path)).sort();
  const appliedPaths = [...allowedDataPaths].sort();
  if (JSON.stringify(statePaths) !== JSON.stringify(appliedPaths)) {
    errors.push(`Ledger entry ${headEntry.entryId} appliedPathStates do not match appliedPaths.`);
  }

  for (const state of headEntry.appliedPathStates) {
    const path = normalizeGitPath(state.path);
    if (state.kind === "deleted") {
      if (git.pathExistsAtCommit(root, currentTrustedCommit, path)) {
        errors.push(`Trusted commit still contains deleted path from ledger entry ${headEntry.entryId}: ${path}`);
      }
      continue;
    }
    if (!git.pathExistsAtCommit(root, currentTrustedCommit, path)) {
      errors.push(`Trusted commit is missing applied path from ledger entry ${headEntry.entryId}: ${path}`);
      continue;
    }
    const actualSha = git.fileSha256AtCommit(root, currentTrustedCommit, path);
    if (actualSha !== state.sha256) {
      errors.push(`Trusted commit content hash mismatch for ${path} in ledger entry ${headEntry.entryId}.`);
    }
  }

  return errors;
}

function ledgerEntryHash(entry: AuthorityLedger["entries"][number]): string {
  const { entryHash: _entryHash, ...hashable } = entry;
  return contentHash(hashable);
}

function normalizeGitPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isAuthorityPath(path: string): boolean {
  return path === ".awbs/authority" || path.startsWith(".awbs/authority/");
}
