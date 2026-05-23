import { TRUSTED_REF } from "../domain/constants.ts";
import { AwbsError } from "../domain/errors.ts";
import { contentHash } from "../domain/hash.ts";
import type { AuthorityLedger, AuthorityLedgerInspectReport } from "../domain/authority-types.ts";
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
      deps.git.commit(root, `awbs: bootstrap trusted chain\n\nAWBS-Ledger-Entry: ${ledger.headEntryId ?? ""}`);
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

function ledgerEntryHash(entry: AuthorityLedger["entries"][number]): string {
  const { entryHash: _entryHash, ...hashable } = entry;
  return contentHash(hashable);
}
