import type { AuthorityLocal, AuthorityTrustMode } from "./authority-types.ts";

export type AuthoritySessionStatus = "active" | "inactive" | "stale" | "unavailable";

export type AuthoritySessionControlInput = {
  recoverySecret: string;
  controllerToken: string;
};

export type AuthoritySessionFile = {
  schemaVersion: 1;
  repoId: string;
  trustMode: AuthorityTrustMode;
  pid: number;
  socketPath: string;
  startedAt: string;
  status: "active";
};

export type AuthoritySessionStatusReport = {
  status: AuthoritySessionStatus;
  active: boolean;
  repoId: string | null;
  pid: number | null;
  socketPath: string | null;
  startedAt: string | null;
  errors: string[];
};

export type AuthoritySessionStartResult = AuthoritySessionStatusReport & {
  recoverySealPath: string;
};

export type AuthoritySessionStopResult = {
  stopped: boolean;
  localRestored: boolean;
};

export type AuthoritySessionRecoverResult = {
  recovered: boolean;
  localPath: string;
};

export type RecoverySealEnvelope = {
  schemaVersion: 1;
  sealType: "awbs.recovery.seal.v1";
  payloadType: "authority.local";
  kdf: "scrypt-recovery-secret-v1";
  aad: {
    repoId: string;
    payloadType: "authority.local";
  };
  salt: string;
  nonce: string;
  ciphertext: string;
  tag: string;
  contentHash: string;
};

export type AuthoritySessionDaemonStartup = {
  schemaVersion: 1;
  root: string;
  repoId: string;
  local: AuthorityLocal;
  controllerTokenHash: string;
};

export type AuthoritySessionRequest = {
  schemaVersion: 1;
  method: string;
  root: string;
  controllerProof?: AuthoritySessionControllerProof;
  args?: unknown[];
};

export type AuthoritySessionControllerProof = {
  algorithm: "AWBS-HMAC-SHA256-v1";
  requestHash: string;
  nonce: string;
  createdAt: string;
  proof: string;
};

export type AuthoritySessionControllerResponseProof = {
  algorithm: "AWBS-HMAC-SHA256-v1";
  requestNonce: string;
  responseHash: string;
  proof: string;
};

export type AuthoritySessionResponse =
  | {
      ok: true;
      result: unknown;
      controllerResponseProof?: AuthoritySessionControllerResponseProof;
    }
  | {
      ok: false;
      error: string;
      controllerResponseProof?: AuthoritySessionControllerResponseProof;
    };
