import type { AuthorityRepairReport, AuthorityVerifyReport } from "../domain/authority-types.ts";
import type { AuthorityPort } from "../ports/authority.ts";
import type { FileDatabasePort } from "../ports/file-database.ts";

export type AuthorityUseCases = {
  verifyAuthority(cwd: string): AuthorityVerifyReport;
  repairMirrors(cwd: string): AuthorityRepairReport;
  formatVerifyReport(report: AuthorityVerifyReport): string;
  formatRepairReport(report: AuthorityRepairReport): string;
};

export function createAuthorityUseCases(deps: { files: FileDatabasePort; authority: AuthorityPort }): AuthorityUseCases {
  return {
    verifyAuthority(cwd: string): AuthorityVerifyReport {
      const root = deps.files.findProjectRoot(cwd);
      return deps.authority.verify(root);
    },

    repairMirrors(cwd: string): AuthorityRepairReport {
      const root = deps.files.findProjectRoot(cwd);
      return deps.authority.repairMirrors(root);
    },

    formatVerifyReport(report: AuthorityVerifyReport): string {
      const lines = [
        `Authority: ${report.ok ? "ok" : "failed"}`,
        `Views: ${report.catalog.views}`,
        `Resources: ${report.catalog.resources}`,
        `Mirror mismatches: ${report.mirrorMismatches.length}`
      ];
      if (report.mirrorMismatches.length > 0) {
        lines.push("", "Mismatched mirrors:");
        for (const mirror of report.mirrorMismatches) {
          lines.push(`  ${mirror}`);
        }
      }
      if (report.errors.length > 0) {
        lines.push("", "Errors:");
        for (const error of report.errors) {
          lines.push(`  ${error}`);
        }
      }
      return lines.join("\n");
    },

    formatRepairReport(report: AuthorityRepairReport): string {
      if (report.repairedMirrors.length === 0) {
        return "Authority mirrors are already in sync.";
      }
      return [`Repaired ${report.repairedMirrors.length} mirror(s):`, ...report.repairedMirrors.map((mirror) => `  ${mirror}`)].join("\n");
    }
  };
}
