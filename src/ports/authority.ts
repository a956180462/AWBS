import type { AuthorityCatalog, AuthorityRepairReport, AuthorityVerifyReport, AuthorityViewContract } from "../domain/authority-types.ts";

export interface AuthorityPort {
  ensureInitialized(root: string): void;
  createViewContract(root: string, contract: AuthorityViewContract): AuthorityViewContract;
  getViewContract(root: string, viewId: string, options?: { allowRevoked?: boolean }): AuthorityViewContract;
  revokeView(root: string, viewId: string): AuthorityViewContract;
  verify(root: string): AuthorityVerifyReport;
  repairMirrors(root: string): AuthorityRepairReport;
  readCatalog(root: string): AuthorityCatalog;
}
