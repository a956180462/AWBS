import { TRUSTED_REF } from "../domain/constants.ts";
import { AwbsError } from "../domain/errors.ts";
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
      withTrustedWorktree(deps, root, currentTrustedCommit, "awbs-ledger-", (trustedRoot) => {
        ledger = deps.authority.readLedger(trustedRoot);
      });
      const headEntry = ledger?.entries.find((entry) => entry.entryId === ledger?.headEntryId);
      if (!headEntry) {
        errors.push("Trusted ledger head entry is missing.");
      }
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
