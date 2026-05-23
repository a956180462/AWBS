import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthoritySessionRequest, AuthoritySessionResponse } from "./session-types.ts";

const MAX_PROOF_AGE_MS = 5 * 60 * 1000;

export function attachControllerProof(request: AuthoritySessionRequest, controllerToken: string): AuthoritySessionRequest {
  const base = proofBase(request);
  const requestHash = sha256String(canonicalJson(base));
  const nonce = randomBytes(16).toString("hex");
  const createdAt = new Date().toISOString();
  return {
    ...base,
    controllerProof: {
      algorithm: "AWBS-HMAC-SHA256-v1",
      requestHash,
      nonce,
      createdAt,
      proof: hmacProof(tokenHash(controllerToken), proofMessage(requestHash, nonce, createdAt))
    }
  };
}

export function verifyControllerProof(expectedTokenHash: string, request: AuthoritySessionRequest, usedNonces?: Set<string>): boolean {
  const proof = request.controllerProof;
  if (!proof || proof.algorithm !== "AWBS-HMAC-SHA256-v1") {
    return false;
  }
  if (!proof.nonce || usedNonces?.has(proof.nonce)) {
    return false;
  }
  const createdAtTime = Date.parse(proof.createdAt);
  if (!Number.isFinite(createdAtTime) || Math.abs(Date.now() - createdAtTime) > MAX_PROOF_AGE_MS) {
    return false;
  }
  const base = proofBase(request);
  const requestHash = sha256String(canonicalJson(base));
  if (proof.requestHash !== requestHash) {
    return false;
  }
  const expectedProof = hmacProof(expectedTokenHash, proofMessage(requestHash, proof.nonce, proof.createdAt));
  const actual = Buffer.from(proof.proof, "hex");
  const expected = Buffer.from(expectedProof, "hex");
  const ok = actual.length === expected.length && timingSafeEqual(actual, expected);
  if (ok) {
    usedNonces?.add(proof.nonce);
  }
  return ok;
}

export function attachControllerResponseProof(response: AuthoritySessionResponse, request: AuthoritySessionRequest, expectedTokenHash: string): AuthoritySessionResponse {
  const requestNonce = request.controllerProof?.nonce;
  if (!requestNonce) {
    return response;
  }
  const base = responseBase(response);
  const responseHash = sha256String(canonicalJson(base));
  return {
    ...base,
    controllerResponseProof: {
      algorithm: "AWBS-HMAC-SHA256-v1",
      requestNonce,
      responseHash,
      proof: hmacProof(expectedTokenHash, responseProofMessage(responseHash, requestNonce))
    }
  } as AuthoritySessionResponse;
}

export function verifyControllerResponseProof(controllerToken: string, request: AuthoritySessionRequest, response: AuthoritySessionResponse): boolean {
  const requestNonce = request.controllerProof?.nonce;
  const proof = response.controllerResponseProof;
  if (!requestNonce || !proof || proof.algorithm !== "AWBS-HMAC-SHA256-v1" || proof.requestNonce !== requestNonce) {
    return false;
  }
  const base = responseBase(response);
  const responseHash = sha256String(canonicalJson(base));
  if (proof.responseHash !== responseHash) {
    return false;
  }
  const expectedProof = hmacProof(tokenHash(controllerToken), responseProofMessage(responseHash, requestNonce));
  const actual = Buffer.from(proof.proof, "hex");
  const expected = Buffer.from(expectedProof, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function proofBase(request: AuthoritySessionRequest): AuthoritySessionRequest {
  const base: AuthoritySessionRequest = {
    schemaVersion: request.schemaVersion,
    method: request.method,
    root: request.root
  };
  if (request.args !== undefined) {
    base.args = request.args;
  }
  return base;
}

function responseBase(response: AuthoritySessionResponse): AuthoritySessionResponse {
  if (response.ok) {
    return { ok: true, result: response.result };
  }
  return { ok: false, error: response.error };
}

function tokenHash(controllerToken: string): string {
  return sha256String(controllerToken);
}

function proofMessage(requestHash: string, nonce: string, createdAt: string): string {
  return canonicalJson({ createdAt, nonce, requestHash });
}

function responseProofMessage(responseHash: string, requestNonce: string): string {
  return canonicalJson({ kind: "response", requestNonce, responseHash });
}

function hmacProof(tokenHashValue: string, message: string): string {
  return createHmac("sha256", Buffer.from(tokenHashValue.slice("sha256:".length), "hex")).update(message).digest("hex");
}

function sha256String(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortForCanonicalJson(value));
}

function sortForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForCanonicalJson);
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = sortForCanonicalJson((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}
