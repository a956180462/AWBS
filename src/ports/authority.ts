import type {
  AuthorityCatalog,
  AuthorityChangesetApplyOperation,
  AuthorityChangesetReceipt,
  AuthorityLedger,
  AuthorityLedgerEntry,
  AuthorityRepairReport,
  AuthorityVerifyReport,
  AuthorityViewContract
} from "../domain/authority-types.ts";

export interface AuthorityPort {
  ensureInitialized(root: string): void;
  createView(root: string, contract: AuthorityViewContract): AuthorityViewContract;
  getViewContract(root: string, viewId: string, options?: { allowRevoked?: boolean }): AuthorityViewContract;
  revokeView(root: string, viewId: string): AuthorityViewContract;
  verify(root: string): AuthorityVerifyReport;
  repairMirrors(root: string): AuthorityRepairReport;
  readCatalog(root: string): AuthorityCatalog;
  hasLedger(root: string): boolean;
  bootstrapLedger(root: string, parentTrustedCommit: string): AuthorityLedger;
  readLedger(root: string): AuthorityLedger;
  recordChangesetApply(root: string, operation: AuthorityChangesetApplyOperation): AuthorityLedgerEntry;
  sealChangesetReceipt(root: string, changesetRoot: string, receipt: AuthorityChangesetReceipt): AuthorityChangesetReceipt;
  openChangesetReceipt(root: string, changesetRoot: string): AuthorityChangesetReceipt;
}
