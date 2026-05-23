import type { AuthoritySessionControlInput, AuthoritySessionRecoverResult, AuthoritySessionStartResult, AuthoritySessionStatusReport, AuthoritySessionStopResult } from "../domain/session-types.ts";

export interface AuthoritySessionPort {
  start(cwd: string, input: AuthoritySessionControlInput): Promise<AuthoritySessionStartResult>;
  status(cwd: string): AuthoritySessionStatusReport;
  stop(cwd: string, controllerToken: string): AuthoritySessionStopResult;
  recover(cwd: string, recoverySecret: string): AuthoritySessionRecoverResult;
}
