import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { AwbsError } from "../domain/errors.ts";
import { attachControllerProof, verifyControllerResponseProof } from "../domain/session-proof.ts";
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
import type { AuthoritySessionRequest, AuthoritySessionResponse } from "../domain/session-types.ts";
import type { AuthorityPort } from "../ports/authority.ts";
import type { FileDatabasePort } from "../ports/file-database.ts";
import { SealedAuthorityAdapter } from "./sealed-authority.ts";

export class SessionAuthorityClientAdapter implements AuthorityPort {
  private readonly cliPath: string;
  private readonly controllerToken: string | null;

  constructor(cliPath: string, options: { controllerToken?: string } = {}) {
    this.cliPath = cliPath;
    this.controllerToken = options.controllerToken ?? null;
  }

  ensureInitialized(root: string): void {
    this.request(root, "ensureInitialized");
  }

  createView(root: string, contract: AuthorityViewContract): AuthorityViewContract {
    return this.request<AuthorityViewContract>(root, "createView", [contract]);
  }

  getViewContract(root: string, viewId: string, options?: { allowRevoked?: boolean }): AuthorityViewContract {
    return this.request<AuthorityViewContract>(root, "getViewContract", [viewId, options]);
  }

  revokeView(root: string, viewId: string): AuthorityViewContract {
    return this.request<AuthorityViewContract>(root, "revokeView", [viewId]);
  }

  verify(root: string): AuthorityVerifyReport {
    return this.request<AuthorityVerifyReport>(root, "verify");
  }

  repairMirrors(root: string): AuthorityRepairReport {
    return this.request<AuthorityRepairReport>(root, "repairMirrors");
  }

  readCatalog(root: string): AuthorityCatalog {
    return this.request<AuthorityCatalog>(root, "readCatalog");
  }

  hasLedger(root: string): boolean {
    return this.request<boolean>(root, "hasLedger");
  }

  bootstrapLedger(root: string, parentTrustedCommit: string): AuthorityLedger {
    return this.request<AuthorityLedger>(root, "bootstrapLedger", [parentTrustedCommit]);
  }

  readLedger(root: string): AuthorityLedger {
    return this.request<AuthorityLedger>(root, "readLedger");
  }

  recordChangesetApply(root: string, operation: AuthorityChangesetApplyOperation): AuthorityLedgerEntry {
    return this.request<AuthorityLedgerEntry>(root, "recordChangesetApply", [operation]);
  }

  sealChangesetReceipt(root: string, changesetRoot: string, receipt: AuthorityChangesetReceipt): AuthorityChangesetReceipt {
    return this.request<AuthorityChangesetReceipt>(root, "sealChangesetReceipt", [changesetRoot, receipt]);
  }

  openChangesetReceipt(root: string, changesetRoot: string): AuthorityChangesetReceipt {
    return this.request<AuthorityChangesetReceipt>(root, "openChangesetReceipt", [changesetRoot]);
  }

  private request<T = unknown>(root: string, method: string, args: unknown[] = []): T {
    const baseRequest: AuthoritySessionRequest = {
      schemaVersion: 1,
      method,
      root,
      args
    };
    const request = this.controllerToken ? attachControllerProof(baseRequest, this.controllerToken) : baseRequest;
    const stdout = execFileSync(process.execPath, [this.cliPath, "__session-request"], {
      cwd: root,
      input: JSON.stringify({ root, request }),
      encoding: "utf8",
      windowsHide: true
    });
    const response = JSON.parse(stdout) as AuthoritySessionResponse;
    if (!response.ok) {
      throw new AwbsError(response.error);
    }
    if (this.controllerToken && !verifyControllerResponseProof(this.controllerToken, request, response)) {
      throw new AwbsError("Authority session response proof is invalid.");
    }
    return response.result as T;
  }
}

export class AutoAuthorityAdapter implements AuthorityPort {
  private readonly files: FileDatabasePort;
  private readonly local: SealedAuthorityAdapter;
  private readonly session: SessionAuthorityClientAdapter;

  constructor(files: FileDatabasePort, cliPath: string) {
    this.files = files;
    this.local = new SealedAuthorityAdapter(files);
    this.session = new SessionAuthorityClientAdapter(cliPath);
  }

  ensureInitialized(root: string): void {
    this.activeAuthority(root).ensureInitialized(root);
  }

  createView(root: string, contract: AuthorityViewContract): AuthorityViewContract {
    return this.activeAuthority(root).createView(root, contract);
  }

  getViewContract(root: string, viewId: string, options?: { allowRevoked?: boolean }): AuthorityViewContract {
    return this.activeAuthority(root).getViewContract(root, viewId, options);
  }

  revokeView(root: string, viewId: string): AuthorityViewContract {
    return this.activeAuthority(root).revokeView(root, viewId);
  }

  verify(root: string): AuthorityVerifyReport {
    return this.activeAuthority(root).verify(root);
  }

  repairMirrors(root: string): AuthorityRepairReport {
    return this.activeAuthority(root).repairMirrors(root);
  }

  readCatalog(root: string): AuthorityCatalog {
    return this.activeAuthority(root).readCatalog(root);
  }

  hasLedger(root: string): boolean {
    return this.activeAuthority(root).hasLedger(root);
  }

  bootstrapLedger(root: string, parentTrustedCommit: string): AuthorityLedger {
    return this.activeAuthority(root).bootstrapLedger(root, parentTrustedCommit);
  }

  readLedger(root: string): AuthorityLedger {
    return this.activeAuthority(root).readLedger(root);
  }

  recordChangesetApply(root: string, operation: AuthorityChangesetApplyOperation): AuthorityLedgerEntry {
    return this.activeAuthority(root).recordChangesetApply(root, operation);
  }

  sealChangesetReceipt(root: string, changesetRoot: string, receipt: AuthorityChangesetReceipt): AuthorityChangesetReceipt {
    return this.activeAuthority(root).sealChangesetReceipt(root, changesetRoot, receipt);
  }

  openChangesetReceipt(root: string, changesetRoot: string): AuthorityChangesetReceipt {
    return this.activeAuthority(root).openChangesetReceipt(root, changesetRoot);
  }

  private activeAuthority(root: string): AuthorityPort {
    const sessionPath = join(root, ".awbs", "private", "session.json");
    if (this.files.pathExists(sessionPath)) {
      return this.session;
    }
    return this.local;
  }
}
