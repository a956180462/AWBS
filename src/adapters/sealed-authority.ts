import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { join, resolve } from "node:path";
import { AwbsError } from "../domain/errors.ts";
import type {
  AuthorityCatalog,
  AuthorityChangesetApplyOperation,
  AuthorityChangesetReceipt,
  AuthorityEvent,
  AuthorityLedger,
  AuthorityLedgerEntry,
  AuthorityLocal,
  AuthorityPayloadType,
  AuthorityReceipt,
  AuthorityRepairReport,
  AuthorityRepo,
  AuthorityResource,
  AuthorityVerifyReport,
  AuthorityViewContract,
  AuthorityViewSource,
  SealEnvelope
} from "../domain/authority-types.ts";
import type { FileDatabasePort } from "../ports/file-database.ts";
import type { AuthorityPort } from "../ports/authority.ts";
import type { ChangesetManifest } from "../domain/types.ts";

const RUNTIME_PEPPER = "awbs-authority-runtime-context-v1";

export class SealedAuthorityAdapter implements AuthorityPort {
  private readonly files: FileDatabasePort;
  private readonly memoryLocal: AuthorityLocal | null;

  constructor(files: FileDatabasePort, options: { memoryLocal?: AuthorityLocal } = {}) {
    this.files = files;
    this.memoryLocal = options.memoryLocal ?? null;
  }

  ensureInitialized(root: string): void {
    this.files.ensureDir(join(root, ".awbs", "authority", "views"));
    this.files.ensureDir(join(root, ".awbs", "private"));

    const repoPath = this.repoPath(root);
    const localPath = this.localPath(root);
    const eventsPath = this.eventsPath(root);
    const ledgerEventsPath = this.ledgerEventsPath(root);

    if (!this.files.pathExists(repoPath)) {
      const repo: AuthorityRepo = {
        schemaVersion: 1,
        repoId: randomUUID(),
        authoritySalt: randomBytes(24).toString("base64"),
        algorithm: "AWBS-AES-256-GCM-v1",
        kdf: "scrypt-repo-local-runtime-v1",
        trustMode: "ephemeral-local-key-v1",
        createdAt: new Date().toISOString()
      };
      this.files.writeJson(repoPath, repo);
    } else {
      this.assertRepoTrustMode(root);
    }

    if (!this.memoryLocal && !this.files.pathExists(localPath)) {
      const local: AuthorityLocal = {
        schemaVersion: 1,
        installationId: randomUUID(),
        localSealSeed: randomBytes(32).toString("base64"),
        createdAt: new Date().toISOString()
      };
      this.files.writeJson(localPath, local);
    }

    if (!this.files.pathExists(eventsPath)) {
      this.files.writeText(eventsPath, "");
    }
    if (!this.files.pathExists(ledgerEventsPath)) {
      this.files.writeText(ledgerEventsPath, "");
    }

    const catalogSealPath = this.catalogSealPath(root);
    if (!this.files.pathExists(catalogSealPath)) {
      const now = new Date().toISOString();
      const repo = this.readRepo(root);
      const catalog: AuthorityCatalog = {
        schemaVersion: 1,
        repoId: repo.repoId,
        catalogVersion: 1,
        createdAt: now,
        updatedAt: now,
        resources: [],
        views: [],
        ext: {}
      };
      this.writeCatalog(root, catalog);
      this.appendEvent(root, {
        schemaVersion: 1,
        event: "AUTHORITY_INITIALIZED",
        eventId: randomUUID(),
        createdAt: now,
        details: { repoId: repo.repoId }
      });
    } else {
      this.readCatalog(root);
    }
  }

  createView(root: string, contract: AuthorityViewContract): AuthorityViewContract {
    this.ensureInitialized(root);
    const viewDir = this.viewDir(root, contract.viewId);
    if (this.files.pathExists(join(viewDir, "contract.seal.json"))) {
      throw new AwbsError(`View already exists: ${contract.viewId}`);
    }

    this.files.ensureDir(viewDir);
    this.writeViewContract(root, contract);

    const catalog = this.readCatalog(root);
    const nextCatalog: AuthorityCatalog = {
      ...catalog,
      catalogVersion: catalog.catalogVersion + 1,
      updatedAt: new Date().toISOString(),
      resources: mergeResources(catalog.resources, contract.sources),
      views: [
        ...catalog.views,
        {
          viewId: contract.viewId,
          status: "active",
          baseCommit: contract.baseCommit,
          readPaths: contract.readPaths,
          writePaths: contract.writePaths,
          createdAt: contract.createdAt,
          ext: {}
        }
      ]
    };
    this.writeCatalog(root, nextCatalog);
    this.appendEvent(root, {
      schemaVersion: 1,
      event: "VIEW_CREATED",
      eventId: randomUUID(),
      createdAt: new Date().toISOString(),
      viewId: contract.viewId,
      details: { readPaths: contract.readPaths, writePaths: contract.writePaths }
    });
    return contract;
  }

  getViewContract(root: string, viewId: string, options: { allowRevoked?: boolean } = {}): AuthorityViewContract {
    this.ensureInitialized(root);
    const catalog = this.readCatalog(root);
    const catalogView = catalog.views.find((view) => view.viewId === viewId);
    if (!catalogView) {
      throw new AwbsError(`View is not registered in authority catalog: ${viewId}`);
    }
    if (catalogView.status === "revoked" && !options.allowRevoked) {
      throw new AwbsError(`View has been revoked: ${viewId}`);
    }

    const contract = this.openViewContract(root, viewId);
    if (contract.viewId !== viewId) {
      throw new AwbsError(`View contract id mismatch for ${viewId}`);
    }
    return contract;
  }

  revokeView(root: string, viewId: string): AuthorityViewContract {
    const contract = this.getViewContract(root, viewId, { allowRevoked: true });
    const catalog = this.readCatalog(root);
    const existing = catalog.views.find((view) => view.viewId === viewId);
    if (!existing) {
      throw new AwbsError(`View is not registered in authority catalog: ${viewId}`);
    }
    if (existing.status === "revoked") {
      return contract;
    }

    const now = new Date().toISOString();
    const nextCatalog: AuthorityCatalog = {
      ...catalog,
      catalogVersion: catalog.catalogVersion + 1,
      updatedAt: now,
      views: catalog.views.map((view) => (view.viewId === viewId ? { ...view, status: "revoked", revokedAt: now } : view))
    };
    this.writeCatalog(root, nextCatalog);
    this.appendEvent(root, {
      schemaVersion: 1,
      event: "VIEW_REVOKED",
      eventId: randomUUID(),
      createdAt: now,
      viewId
    });
    return contract;
  }

  verify(root: string): AuthorityVerifyReport {
    const errors: string[] = [];
    const mirrorMismatches: string[] = [];
    let catalog: AuthorityCatalog | null = null;

    try {
      this.ensureInitializedNoCatalogRead(root);
      catalog = this.openSeal<AuthorityCatalog>(root, this.catalogSealPath(root), "authority.catalog");
      if (this.readOptionalText(this.catalogMirrorPath(root)) !== mirrorText(catalog)) {
        mirrorMismatches.push("catalog.mirror.json");
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    if (catalog) {
      for (const view of catalog.views) {
        try {
          const contract = this.openSeal<AuthorityViewContract>(root, this.viewSealPath(root, view.viewId), "authority.viewContract");
          if (this.readOptionalText(this.viewMirrorPath(root, view.viewId)) !== mirrorText(contract)) {
            mirrorMismatches.push(`views/${view.viewId}/mirror.json`);
          }
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }

    if (this.hasLedger(root)) {
      try {
        const ledger = this.openSeal<AuthorityLedger>(root, this.ledgerSealPath(root), "authority.ledger");
        if (this.readOptionalText(this.ledgerMirrorPath(root)) !== mirrorText(ledger)) {
          mirrorMismatches.push("ledger.mirror.json");
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    return {
      ok: errors.length === 0 && mirrorMismatches.length === 0,
      mirrorMismatches,
      errors,
      catalog: {
        views: catalog?.views.length ?? 0,
        resources: catalog?.resources.length ?? 0
      }
    };
  }

  repairMirrors(root: string): AuthorityRepairReport {
    this.ensureInitialized(root);
    const repairedMirrors: string[] = [];

    const catalogBefore = this.readOptionalText(this.catalogMirrorPath(root));
    const catalog = this.openSeal<AuthorityCatalog>(root, this.catalogSealPath(root), "authority.catalog");
    this.writeMirror(this.catalogMirrorPath(root), catalog);
    if (catalogBefore !== this.readOptionalText(this.catalogMirrorPath(root))) {
      repairedMirrors.push("catalog.mirror.json");
    }

    for (const view of catalog.views) {
      const mirrorPath = this.viewMirrorPath(root, view.viewId);
      const before = this.readOptionalText(mirrorPath);
      const contract = this.openSeal<AuthorityViewContract>(root, this.viewSealPath(root, view.viewId), "authority.viewContract");
      this.writeMirror(mirrorPath, contract);
      if (before !== this.readOptionalText(mirrorPath)) {
        repairedMirrors.push(`views/${view.viewId}/mirror.json`);
      }
    }

    if (this.hasLedger(root)) {
      const ledgerBefore = this.readOptionalText(this.ledgerMirrorPath(root));
      const ledger = this.openSeal<AuthorityLedger>(root, this.ledgerSealPath(root), "authority.ledger");
      this.writeMirror(this.ledgerMirrorPath(root), ledger);
      if (ledgerBefore !== this.readOptionalText(this.ledgerMirrorPath(root))) {
        repairedMirrors.push("ledger.mirror.json");
      }
    }

    if (repairedMirrors.length > 0) {
      this.appendEvent(root, {
        schemaVersion: 1,
        event: "MIRROR_REBUILT",
        eventId: randomUUID(),
        createdAt: new Date().toISOString(),
        details: { repairedMirrors }
      });
    }

    return { repairedMirrors };
  }

  readCatalog(root: string): AuthorityCatalog {
    this.ensureInitializedNoCatalogRead(root);
    return this.openSeal<AuthorityCatalog>(root, this.catalogSealPath(root), "authority.catalog");
  }

  hasLedger(root: string): boolean {
    return this.files.pathExists(this.ledgerSealPath(root));
  }

  bootstrapLedger(root: string, parentTrustedCommit: string): AuthorityLedger {
    this.ensureInitialized(root);
    if (this.hasLedger(root)) {
      throw new AwbsError("Trusted ledger is already bootstrapped.");
    }
    const now = new Date().toISOString();
    const repo = this.readRepo(root);
    const entryBase: Omit<AuthorityLedgerEntry, "entryHash"> = {
      schemaVersion: 1,
      entryId: randomUUID(),
      kind: "bootstrap",
      previousEntryHash: null,
      parentTrustedCommit,
      baseCommit: parentTrustedCommit,
      changesetId: null,
      viewId: null,
      createdAt: now,
      appliedPaths: [],
      changesetManifestHash: null,
      changesetPayloadHash: null,
      authorityContractHash: null,
      operationHash: contentHash({
        kind: "bootstrap",
        parentTrustedCommit,
        repoId: repo.repoId,
        createdAt: now
      }),
      ext: {}
    };
    const entry: AuthorityLedgerEntry = {
      ...entryBase,
      entryHash: ledgerEntryHash(entryBase)
    };
    const ledger: AuthorityLedger = {
      schemaVersion: 1,
      repoId: repo.repoId,
      ledgerVersion: 1,
      createdAt: now,
      updatedAt: now,
      headEntryId: entry.entryId,
      entries: [entry],
      ext: {}
    };
    this.writeLedger(root, ledger);
    this.appendLedgerEvent(root, {
      schemaVersion: 1,
      event: "LEDGER_BOOTSTRAPPED",
      eventId: randomUUID(),
      createdAt: now,
      details: { parentTrustedCommit, entryId: entry.entryId }
    });
    return ledger;
  }

  readLedger(root: string): AuthorityLedger {
    this.ensureInitializedNoCatalogRead(root);
    return this.openSeal<AuthorityLedger>(root, this.ledgerSealPath(root), "authority.ledger");
  }

  recordChangesetApply(root: string, operation: AuthorityChangesetApplyOperation): AuthorityLedgerEntry {
    const ledger = this.readLedger(root);
    if (operation.schemaVersion !== 1) {
      throw new AwbsError("Invalid changeset apply operation schema.");
    }
    const entryId = randomUUID();
    const createdAt = operation.createdAt ?? new Date().toISOString();
    const headEntry = ledger.entries.find((existing) => existing.entryId === ledger.headEntryId);
    if (!headEntry) {
      throw new AwbsError("Trusted ledger head entry is missing.");
    }
    const entryBase: Omit<AuthorityLedgerEntry, "entryHash"> = {
      schemaVersion: 1,
      entryId,
      kind: "changeset",
      previousEntryHash: headEntry.entryHash,
      parentTrustedCommit: operation.parentTrustedCommit,
      baseCommit: operation.baseCommit,
      changesetId: operation.changesetId,
      viewId: operation.viewId,
      createdAt,
      appliedPaths: operation.appliedPaths,
      changesetManifestHash: operation.changesetManifestHash,
      changesetPayloadHash: operation.changesetPayloadHash,
      authorityContractHash: operation.authorityContractHash,
      operationHash: contentHash({
        kind: "changeset",
        parentTrustedCommit: operation.parentTrustedCommit,
        baseCommit: operation.baseCommit,
        changesetId: operation.changesetId,
        viewId: operation.viewId,
        appliedPaths: operation.appliedPaths,
        changesetManifestHash: operation.changesetManifestHash,
        changesetPayloadHash: operation.changesetPayloadHash,
        authorityContractHash: operation.authorityContractHash
      }),
      ext: operation.ext
    };
    const entry: AuthorityLedgerEntry = {
      ...entryBase,
      entryHash: ledgerEntryHash(entryBase)
    };
    const now = new Date().toISOString();
    const nextLedger: AuthorityLedger = {
      ...ledger,
      ledgerVersion: ledger.ledgerVersion + 1,
      updatedAt: now,
      headEntryId: entry.entryId,
      entries: [...ledger.entries, entry]
    };
    this.writeLedger(root, nextLedger);
    this.appendLedgerEvent(root, {
      schemaVersion: 1,
      event: "LEDGER_ENTRY_APPENDED",
      eventId: randomUUID(),
      createdAt: now,
      viewId: entry.viewId ?? undefined,
      details: {
        entryId: entry.entryId,
        changesetId: entry.changesetId,
        parentTrustedCommit: entry.parentTrustedCommit
      }
    });
    return entry;
  }

  sealChangesetReceipt(root: string, changesetRoot: string, receipt: AuthorityChangesetReceipt): AuthorityChangesetReceipt {
    this.ensureInitializedNoCatalogRead(root);
    this.assertChangesetReceiptScope(root, changesetRoot, receipt);
    const receiptPath = this.changesetReceiptPath(changesetRoot);
    this.writeSeal(root, receiptPath, "authority.changesetReceipt", receipt, {
      changesetId: receipt.changesetId,
      viewId: receipt.viewId,
      baseCommit: receipt.baseCommit
    });
    return receipt;
  }

  openChangesetReceipt(root: string, changesetRoot: string): AuthorityChangesetReceipt {
    this.ensureInitializedNoCatalogRead(root);
    const manifest = this.files.readJson<ChangesetManifest>(join(changesetRoot, "manifest.json"));
    const receipt = this.openSeal<AuthorityChangesetReceipt>(root, this.changesetReceiptPath(changesetRoot), "authority.changesetReceipt");
    this.assertChangesetReceiptScope(root, changesetRoot, receipt, manifest);
    return receipt;
  }

  private ensureInitializedNoCatalogRead(root: string): void {
    this.files.ensureDir(join(root, ".awbs", "authority", "views"));
    this.files.ensureDir(join(root, ".awbs", "private"));
    if (!this.files.pathExists(this.repoPath(root))) {
      throw new AwbsError("Authority repo is not initialized. Run `awbs init` first.");
    }
    if (!this.hasLocalMaterial(root)) {
      throw new AwbsError("Authority local material is missing. Run `awbs init` or restore .awbs/private/local.json.");
    }
  }

  private writeCatalog(root: string, catalog: AuthorityCatalog): void {
    this.writeSeal(root, this.catalogSealPath(root), "authority.catalog", catalog, {
      repoId: catalog.repoId,
      schemaVersion: catalog.schemaVersion,
      catalogVersion: catalog.catalogVersion
    });
    this.writeMirror(this.catalogMirrorPath(root), catalog);
  }

  private writeLedger(root: string, ledger: AuthorityLedger): void {
    this.writeSeal(root, this.ledgerSealPath(root), "authority.ledger", ledger, {
      repoId: ledger.repoId,
      schemaVersion: ledger.schemaVersion,
      ledgerVersion: ledger.ledgerVersion,
      headEntryId: ledger.headEntryId
    });
    this.writeMirror(this.ledgerMirrorPath(root), ledger);
  }

  private writeViewContract(root: string, contract: AuthorityViewContract): void {
    this.writeSeal(root, this.viewSealPath(root, contract.viewId), "authority.viewContract", contract, {
      viewId: contract.viewId,
      schemaVersion: contract.schemaVersion,
      baseCommit: contract.baseCommit
    });
    this.writeMirror(this.viewMirrorPath(root, contract.viewId), contract);
    this.files.writeJson(this.viewReceiptPath(root, contract.viewId), {
      schemaVersion: 1,
      viewId: contract.viewId,
      payloadType: "authority.viewContract",
      algorithm: "AWBS-AES-256-GCM-v1",
      contentHash: contentHash(contract),
      createdAt: contract.createdAt,
      ext: {}
    } satisfies AuthorityReceipt);
  }

  private openViewContract(root: string, viewId: string): AuthorityViewContract {
    return this.openSeal<AuthorityViewContract>(root, this.viewSealPath(root, viewId), "authority.viewContract");
  }

  private writeSeal(root: string, path: string, payloadType: "authority.catalog", payload: AuthorityCatalog, aad: Record<string, unknown>): void;
  private writeSeal(root: string, path: string, payloadType: "authority.viewContract", payload: AuthorityViewContract, aad: Record<string, unknown>): void;
  private writeSeal(root: string, path: string, payloadType: "authority.ledger", payload: AuthorityLedger, aad: Record<string, unknown>): void;
  private writeSeal(root: string, path: string, payloadType: "authority.changesetReceipt", payload: AuthorityChangesetReceipt, aad: Record<string, unknown>): void;
  private writeSeal(
    root: string,
    path: string,
    payloadType: AuthorityPayloadType,
    payload: AuthorityCatalog | AuthorityViewContract | AuthorityLedger | AuthorityChangesetReceipt,
    aad: Record<string, unknown>
  ): void {
    const key = this.deriveKey(root);
    const nonce = randomBytes(12);
    const plaintext = Buffer.from(canonicalJson(payload), "utf8");
    const aadText = canonicalJson({ payloadType, ...aad });
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(aadText, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope: SealEnvelope = {
      schemaVersion: 1,
      sealType: "awbs.seal.v1",
      payloadType,
      aad: { payloadType, ...aad },
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      contentHash: sha256String(plaintext.toString("utf8"))
    };
    this.files.writeJson(path, envelope);
  }

  private openSeal<T>(root: string, path: string, expectedPayloadType: AuthorityPayloadType): T {
    if (!this.files.pathExists(path)) {
      throw new AwbsError(`Sealed authority payload not found: ${path}`);
    }
    const envelope = this.files.readJson<SealEnvelope>(path);
    if (envelope.sealType !== "awbs.seal.v1" || envelope.payloadType !== expectedPayloadType) {
      throw new AwbsError(`Invalid authority seal envelope: ${path}`);
    }

    try {
      const key = this.deriveKey(root);
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64"));
      decipher.setAAD(Buffer.from(canonicalJson(envelope.aad), "utf8"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8");
      if (sha256String(plaintext) !== envelope.contentHash) {
        throw new AwbsError(`Authority content hash mismatch: ${path}`);
      }
      return JSON.parse(plaintext) as T;
    } catch (error) {
      if (error instanceof AwbsError) {
        throw error;
      }
      throw new AwbsError(`Failed to open sealed authority payload: ${path}`);
    }
  }

  private deriveKey(root: string): Buffer {
    const repo = this.readRepo(root);
    const local = this.readLocal(root);
    const password = `${local.localSealSeed}:${local.installationId}:${repo.repoId}:${RUNTIME_PEPPER}`;
    return scryptSync(password, Buffer.from(repo.authoritySalt, "base64"), 32, { N: 16384, r: 8, p: 1 });
  }

  private readRepo(root: string): AuthorityRepo {
    return this.files.readJson<AuthorityRepo>(this.repoPath(root));
  }

  private assertRepoTrustMode(root: string): void {
    const repo = this.readRepo(root);
    if (repo.trustMode !== "ephemeral-local-key-v1") {
      throw new AwbsError("Authority repo trustMode is not ephemeral-local-key-v1. Reinitialize this development database with the current AWBS version.");
    }
  }

  private readLocal(root: string): AuthorityLocal {
    if (this.memoryLocal) {
      return this.memoryLocal;
    }
    return this.files.readJson<AuthorityLocal>(this.localPath(root));
  }

  private hasLocalMaterial(root: string): boolean {
    return Boolean(this.memoryLocal) || this.files.pathExists(this.localPath(root));
  }

  private appendEvent(root: string, event: AuthorityEvent): void {
    const path = this.eventsPath(root);
    const existing = this.files.pathExists(path) ? this.files.readText(path) : "";
    this.files.writeText(path, `${existing}${JSON.stringify(event)}\n`);
  }

  private appendLedgerEvent(root: string, event: AuthorityEvent): void {
    const path = this.ledgerEventsPath(root);
    const existing = this.files.pathExists(path) ? this.files.readText(path) : "";
    this.files.writeText(path, `${existing}${JSON.stringify(event)}\n`);
  }

  private writeMirror(path: string, value: unknown): void {
    this.files.writeJson(path, value);
  }

  private readOptionalText(path: string): string | null {
    return this.files.pathExists(path) ? this.files.readText(path) : null;
  }

  private repoPath(root: string): string {
    return join(root, ".awbs", "authority", "repo.json");
  }

  private localPath(root: string): string {
    return join(root, ".awbs", "private", "local.json");
  }

  private eventsPath(root: string): string {
    return join(root, ".awbs", "authority", "view-events.jsonl");
  }

  private ledgerEventsPath(root: string): string {
    return join(root, ".awbs", "authority", "ledger-events.jsonl");
  }

  private catalogSealPath(root: string): string {
    return join(root, ".awbs", "authority", "catalog.seal.json");
  }

  private catalogMirrorPath(root: string): string {
    return join(root, ".awbs", "authority", "catalog.mirror.json");
  }

  private ledgerSealPath(root: string): string {
    return join(root, ".awbs", "authority", "ledger.seal.json");
  }

  private ledgerMirrorPath(root: string): string {
    return join(root, ".awbs", "authority", "ledger.mirror.json");
  }

  private viewDir(root: string, viewId: string): string {
    return join(root, ".awbs", "authority", "views", viewId);
  }

  private viewSealPath(root: string, viewId: string): string {
    return join(this.viewDir(root, viewId), "contract.seal.json");
  }

  private viewMirrorPath(root: string, viewId: string): string {
    return join(this.viewDir(root, viewId), "mirror.json");
  }

  private viewReceiptPath(root: string, viewId: string): string {
    return join(this.viewDir(root, viewId), "receipt.json");
  }

  private changesetReceiptPath(changesetRoot: string): string {
    return join(changesetRoot, "receipt.seal.json");
  }

  private assertChangesetReceiptScope(root: string, changesetRoot: string, receipt: AuthorityChangesetReceipt, manifest?: ChangesetManifest): void {
    const expectedRoot = resolve(root, ".awbs", "changesets", receipt.changesetId);
    if (resolve(changesetRoot) !== expectedRoot) {
      throw new AwbsError(`Changeset receipt path does not match changeset id: ${receipt.changesetId}`);
    }
    const actualManifest = manifest ?? this.files.readJson<ChangesetManifest>(join(changesetRoot, "manifest.json"));
    if (
      actualManifest.changesetId !== receipt.changesetId ||
      actualManifest.viewId !== receipt.viewId ||
      actualManifest.baseCommit !== receipt.baseCommit ||
      actualManifest.payloadHash !== receipt.payloadHash ||
      actualManifest.operationHash !== receipt.operationHash ||
      contentHash(actualManifest) !== receipt.manifestHash
    ) {
      throw new AwbsError(`Changeset receipt does not match manifest: ${receipt.changesetId}`);
    }
  }
}

function mergeResources(existing: AuthorityResource[], sources: AuthorityViewSource[]): AuthorityResource[] {
  const byPath = new Map(existing.map((resource) => [resource.path, resource]));
  for (const source of sources) {
    if (!byPath.has(source.path)) {
      byPath.set(source.path, {
        resourceId: `res_${sha256String(source.path).slice("sha256:".length, "sha256:".length + 12)}`,
        path: source.path,
        kind: source.kind,
        parent: parentPath(source.path),
        defaultMode: "read",
        ext: {}
      });
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function parentPath(path: string): string | null {
  const index = path.lastIndexOf("/");
  return index <= 0 ? null : path.slice(0, index);
}

function contentHash(value: unknown): string {
  return sha256String(canonicalJson(value));
}

function ledgerEntryHash(entry: AuthorityLedgerEntry | Omit<AuthorityLedgerEntry, "entryHash">): string {
  const { entryHash: _entryHash, ...hashable } = entry as AuthorityLedgerEntry;
  return contentHash(hashable);
}

function mirrorText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
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
