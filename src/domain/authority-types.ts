import type { IndexKind } from "./types.ts";

export type AuthorityViewStatus = "active" | "revoked";
export type AuthorityTrustMode = "repo-local-sealed-key-v1" | "ephemeral-local-key-v1";
export type AuthorityEventType =
  | "AUTHORITY_INITIALIZED"
  | "VIEW_CREATED"
  | "VIEW_REVOKED"
  | "CATALOG_RESEALED"
  | "MIRROR_REBUILT"
  | "LEDGER_BOOTSTRAPPED"
  | "LEDGER_ENTRY_APPENDED";
export type AuthorityPayloadType = "authority.catalog" | "authority.viewContract" | "authority.ledger" | "authority.changesetReceipt";

export type AuthorityRepo = {
  schemaVersion: 1;
  repoId: string;
  authoritySalt: string;
  algorithm: "AWBS-AES-256-GCM-v1";
  kdf: "scrypt-repo-local-runtime-v1";
  trustMode?: AuthorityTrustMode;
  createdAt: string;
};

export type AuthorityLocal = {
  schemaVersion: 1;
  installationId: string;
  localSealSeed: string;
  createdAt: string;
};

export type AuthorityResource = {
  resourceId: string;
  path: string;
  kind: IndexKind;
  parent: string | null;
  defaultMode: "read";
  ext: Record<string, unknown>;
};

export type AuthorityCatalogView = {
  viewId: string;
  status: AuthorityViewStatus;
  baseCommit: string;
  readPaths: string[];
  writePaths: string[];
  createdAt: string;
  revokedAt?: string;
  ext: Record<string, unknown>;
};

export type AuthorityCatalog = {
  schemaVersion: 1;
  repoId: string;
  catalogVersion: number;
  createdAt: string;
  updatedAt: string;
  resources: AuthorityResource[];
  views: AuthorityCatalogView[];
  ext: Record<string, unknown>;
};

export type AuthorityViewSource = {
  path: string;
  sourcePath: string;
  workspacePath: string;
  baselinePath: string;
  kind: IndexKind;
  sha256: string | null;
  mode: "read" | "write";
  ext: Record<string, unknown>;
};

export type AuthorityViewContract = {
  schemaVersion: 1;
  viewId: string;
  baseCommit: string;
  createdAt: string;
  readPaths: string[];
  writePaths: string[];
  sources: AuthorityViewSource[];
  ext: Record<string, unknown>;
};

export type SealEnvelope = {
  schemaVersion: 1;
  sealType: "awbs.seal.v1";
  payloadType: AuthorityPayloadType;
  aad: Record<string, unknown>;
  nonce: string;
  ciphertext: string;
  tag: string;
  contentHash: string;
};

export type AuthorityReceipt = {
  schemaVersion: 1;
  viewId: string;
  payloadType: "authority.viewContract";
  algorithm: "AWBS-AES-256-GCM-v1";
  contentHash: string;
  createdAt: string;
  ext: Record<string, unknown>;
};

export type AuthorityChangesetReceipt = {
  schemaVersion: 1;
  changesetId: string;
  viewId: string;
  baseCommit: string;
  createdAt: string;
  payloadHash: string;
  operationHash: string;
  manifestHash: string;
  ext: Record<string, unknown>;
};

export type AuthorityEvent = {
  schemaVersion: 1;
  event: AuthorityEventType;
  eventId: string;
  createdAt: string;
  viewId?: string;
  details?: Record<string, unknown>;
};

export type AuthorityVerifyReport = {
  ok: boolean;
  mirrorMismatches: string[];
  errors: string[];
  catalog: {
    views: number;
    resources: number;
  };
};

export type AuthorityRepairReport = {
  repairedMirrors: string[];
};

export type AuthorityLedgerEntryKind = "bootstrap" | "changeset";

export type AuthorityChangesetApplyOperation = {
  schemaVersion: 1;
  parentTrustedCommit: string;
  baseCommit: string;
  changesetId: string;
  viewId: string;
  appliedPaths: string[];
  appliedPathStates: AuthorityAppliedPathState[];
  changesetManifestHash: string;
  changesetPayloadHash: string;
  authorityContractHash: string;
  createdAt?: string;
  ext: Record<string, unknown>;
};

export type AuthorityAppliedPathState = {
  path: string;
  kind: "file" | "deleted";
  sha256: string | null;
};

export type AuthorityLedgerEntry = {
  schemaVersion: 1;
  entryId: string;
  kind: AuthorityLedgerEntryKind;
  previousEntryHash: string | null;
  entryHash: string;
  parentTrustedCommit: string;
  baseCommit: string;
  changesetId: string | null;
  viewId: string | null;
  createdAt: string;
  appliedPaths: string[];
  appliedPathStates: AuthorityAppliedPathState[];
  changesetManifestHash: string | null;
  changesetPayloadHash: string | null;
  authorityContractHash: string | null;
  operationHash: string;
  ext: Record<string, unknown>;
};

export type AuthorityLedger = {
  schemaVersion: 1;
  repoId: string;
  ledgerVersion: number;
  createdAt: string;
  updatedAt: string;
  headEntryId: string | null;
  entries: AuthorityLedgerEntry[];
  ext: Record<string, unknown>;
};

export type AuthorityLedgerInspectReport = {
  ok: boolean;
  currentTrustedCommit: string | null;
  headEntryId: string | null;
  entries: number;
  errors: string[];
  ledger: AuthorityLedger | null;
};
