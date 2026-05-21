import { cpSync, existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { TRUSTED_REF } from "../domain/constants.ts";
import { AwbsError } from "../domain/errors.ts";
import type { AuthorityPort } from "../ports/authority.ts";
import type { FileDatabasePort } from "../ports/file-database.ts";
import type { GitPort } from "../ports/git.ts";
import { inspectTrustedLedger } from "./ledger.ts";
import { requireTrustedCommit } from "./trusted-chain.ts";

export type DbAuditReport = {
  ok: boolean;
  root: string;
  headCommit: string | null;
  currentTrustedCommit: string | null;
  headMatchesTrusted: boolean;
  trustedIsAncestorOfHead: boolean | null;
  externalCommits: string[];
  workingTreeDirty: boolean;
  workingTreeStatus: string;
  authorityOk: boolean;
  errors: string[];
};

export type DbCleanRebuildReport = {
  trustedCommit: string;
  backupPath: string;
  cleanPath: string;
  restoredPath: string;
  swapped: boolean;
};

export type DbUseCases = {
  auditDatabase(cwd: string): DbAuditReport;
  cleanRebuild(cwd: string): DbCleanRebuildReport;
  listBackups(cwd: string): string[];
  formatAuditReport(report: DbAuditReport): string;
  formatCleanRebuildReport(report: DbCleanRebuildReport): string;
};

export function createDbUseCases(deps: { files: FileDatabasePort; git: GitPort; authority: AuthorityPort }): DbUseCases {
  return {
    auditDatabase(cwd: string): DbAuditReport {
      const root = deps.files.findProjectRoot(cwd);
      const headCommit = deps.git.headCommit(root);
      const currentTrustedCommit = deps.git.refCommit(root, TRUSTED_REF);
      const ledgerReport = inspectTrustedLedger(deps, root);
      const errors = [...ledgerReport.errors];
      const workingTreeStatus = deps.git.statusPorcelain(root);

      let trustedIsAncestorOfHead: boolean | null = null;
      let externalCommits: string[] = [];
      if (headCommit && currentTrustedCommit && headCommit !== currentTrustedCommit) {
        trustedIsAncestorOfHead = deps.git.isAncestor(root, currentTrustedCommit, headCommit);
        if (trustedIsAncestorOfHead) {
          externalCommits = deps.git.revList(root, `${currentTrustedCommit}..${headCommit}`);
        } else {
          externalCommits = [headCommit];
          errors.push("Git HEAD is not on top of the AWBS trusted chain.");
        }
      } else if (headCommit && currentTrustedCommit) {
        trustedIsAncestorOfHead = true;
      }

      const report: DbAuditReport = {
        ok: ledgerReport.ok && headCommit === currentTrustedCommit && workingTreeStatus.trim().length === 0,
        root,
        headCommit,
        currentTrustedCommit,
        headMatchesTrusted: Boolean(headCommit && currentTrustedCommit && headCommit === currentTrustedCommit),
        trustedIsAncestorOfHead,
        externalCommits,
        workingTreeDirty: workingTreeStatus.trim().length > 0,
        workingTreeStatus,
        authorityOk: ledgerReport.ok,
        errors
      };
      return report;
    },

    cleanRebuild(cwd: string): DbCleanRebuildReport {
      const root = deps.files.findProjectRoot(cwd);
      const trustedCommit = requireTrustedCommit(deps.git, root);
      const parent = dirname(root);
      const name = basename(root);
      const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
      const cleanPath = join(parent, `${name}.clean-${stamp}`);
      const backupPath = join(parent, `${name}.backup-${stamp}`);

      if (existsSync(cleanPath) || existsSync(backupPath)) {
        throw new AwbsError("Clean rebuild target already exists. Try again later.");
      }

      deps.git.cloneAtCommit(root, cleanPath, trustedCommit);
      copyPrivateMaterial(root, cleanPath);
      deps.git.updateRef(cleanPath, TRUSTED_REF, trustedCommit);
      const authorityReport = deps.authority.verify(cleanPath);
      if (!authorityReport.ok) {
        rmSync(cleanPath, { recursive: true, force: true });
        throw new AwbsError(`Clean clone authority verification failed:\n${authorityReport.errors.join("\n")}`);
      }

      const originalCwd = process.cwd();
      if (isInsideOrEqual(root, originalCwd)) {
        process.chdir(parent);
      }

      try {
        renameSync(root, backupPath);
        try {
          renameSync(cleanPath, root);
        } catch (error) {
          renameSync(backupPath, root);
          throw error;
        }
      } catch (error) {
        throw new AwbsError(
          `Clean rebuild swap failed. Clean clone remains at ${cleanPath}, planned backup path was ${backupPath}.\n${error instanceof Error ? error.message : String(error)}`
        );
      }

      return {
        trustedCommit,
        backupPath,
        cleanPath,
        restoredPath: root,
        swapped: true
      };
    },

    listBackups(cwd: string): string[] {
      const root = deps.files.findProjectRoot(cwd);
      const parent = dirname(root);
      const name = basename(root);
      const prefix = `${name}.backup-`;
      return readdirSync(parent)
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => join(parent, entry))
        .sort((a, b) => a.localeCompare(b));
    },

    formatAuditReport(report: DbAuditReport): string {
      const lines = [
        `Database audit: ${report.ok ? "ok" : "attention required"}`,
        `Root: ${report.root}`,
        `HEAD: ${report.headCommit ?? "(none)"}`,
        `Trusted: ${report.currentTrustedCommit ?? "(none)"}`,
        `HEAD matches trusted: ${report.headMatchesTrusted ? "yes" : "no"}`,
        `Working tree dirty: ${report.workingTreeDirty ? "yes" : "no"}`,
        `External commits: ${report.externalCommits.length}`
      ];
      if (report.externalCommits.length > 0) {
        lines.push("", "External commits:");
        for (const commit of report.externalCommits) {
          lines.push(`  ${commit}`);
        }
      }
      if (report.workingTreeStatus.trim().length > 0) {
        lines.push("", "Working tree status:", report.workingTreeStatus.trimEnd());
      }
      if (report.errors.length > 0) {
        lines.push("", "Errors:");
        for (const error of report.errors) {
          lines.push(`  ${error}`);
        }
      }
      return lines.join("\n");
    },

    formatCleanRebuildReport(report: DbCleanRebuildReport): string {
      return [
        "Database rebuilt from AWBS trusted chain.",
        `Trusted commit: ${report.trustedCommit}`,
        `Backup: ${report.backupPath}`,
        `Restored: ${report.restoredPath}`
      ].join("\n");
    }
  };
}

function copyPrivateMaterial(root: string, cleanPath: string): void {
  const source = join(root, ".awbs", "private");
  const destination = join(cleanPath, ".awbs", "private");
  if (existsSync(source)) {
    cpSync(source, destination, { recursive: true, force: true });
  }
}

function isInsideOrEqual(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !rel.includes(":"));
}
