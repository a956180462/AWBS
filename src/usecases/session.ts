import type { AuthoritySessionControlInput, AuthoritySessionRecoverResult, AuthoritySessionStartResult, AuthoritySessionStatusReport, AuthoritySessionStopResult } from "../domain/session-types.ts";
import type { AuthoritySessionPort } from "../ports/authority-session.ts";

export type AuthoritySessionUseCases = {
  startSession(cwd: string, input: AuthoritySessionControlInput): Promise<AuthoritySessionStartResult>;
  statusSession(cwd: string): AuthoritySessionStatusReport;
  stopSession(cwd: string, controllerToken: string): AuthoritySessionStopResult;
  recoverSession(cwd: string, recoverySecret: string): AuthoritySessionRecoverResult;
  formatStatus(report: AuthoritySessionStatusReport): string;
};

export function createAuthoritySessionUseCases(deps: { session: AuthoritySessionPort }): AuthoritySessionUseCases {
  return {
    startSession(cwd: string, input: AuthoritySessionControlInput): Promise<AuthoritySessionStartResult> {
      return deps.session.start(cwd, input);
    },

    statusSession(cwd: string): AuthoritySessionStatusReport {
      return deps.session.status(cwd);
    },

    stopSession(cwd: string, controllerToken: string): AuthoritySessionStopResult {
      return deps.session.stop(cwd, controllerToken);
    },

    recoverSession(cwd: string, recoverySecret: string): AuthoritySessionRecoverResult {
      return deps.session.recover(cwd, recoverySecret);
    },

    formatStatus(report: AuthoritySessionStatusReport): string {
      const lines = [
        `Authority session: ${report.status}`,
        `Active: ${report.active ? "yes" : "no"}`,
        `Repo: ${report.repoId ?? "(none)"}`,
        `PID: ${report.pid ?? "(none)"}`,
        `Endpoint: ${report.socketPath ?? "(none)"}`,
        `Started: ${report.startedAt ?? "(none)"}`
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
