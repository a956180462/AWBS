import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { join } from "node:path";
import { AwbsError } from "../domain/errors.ts";
import type {
  AuthorityCatalog,
  AuthorityEvent,
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

const RUNTIME_PEPPER = "awbs-authority-runtime-context-v1";

export class SealedAuthorityAdapter implements AuthorityPort {
  private readonly files: FileDatabasePort;

  constructor(files: FileDatabasePort) {
    this.files = files;
  }

  ensureInitialized(root: string): void {
    this.files.ensureDir(join(root, ".awbs", "authority", "views"));
    this.files.ensureDir(join(root, ".awbs", "private"));

    const repoPath = this.repoPath(root);
    const localPath = this.localPath(root);
    const eventsPath = this.eventsPath(root);

    if (!this.files.pathExists(repoPath)) {
      const repo: AuthorityRepo = {
        schemaVersion: 1,
        repoId: randomUUID(),
        authoritySalt: randomBytes(24).toString("base64"),
        algorithm: "AWBS-AES-256-GCM-v1",
        kdf: "scrypt-repo-local-runtime-v1",
        createdAt: new Date().toISOString()
      };
      this.files.writeJson(repoPath, repo);
    }

    if (!this.files.pathExists(localPath)) {
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

  createViewContract(root: string, contract: AuthorityViewContract): AuthorityViewContract {
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
    const repairedMirrors: string[] = [];
    let catalog: AuthorityCatalog | null = null;
    const catalogMirrorBefore = this.readOptionalText(this.catalogMirrorPath(root));

    try {
      this.ensureInitialized(root);
      catalog = this.readCatalog(root);
      if (catalogMirrorBefore !== this.readOptionalText(this.catalogMirrorPath(root))) {
        repairedMirrors.push("catalog.mirror.json");
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    if (catalog) {
      for (const view of catalog.views) {
        try {
          const before = this.readOptionalText(this.viewMirrorPath(root, view.viewId));
          this.openViewContract(root, view.viewId);
          const after = this.readOptionalText(this.viewMirrorPath(root, view.viewId));
          if (before !== after) {
            repairedMirrors.push(`views/${view.viewId}/mirror.json`);
          }
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }

    return {
      ok: errors.length === 0,
      repairedMirrors,
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
    const catalog = this.openSeal<AuthorityCatalog>(root, this.catalogSealPath(root), "authority.catalog");
    this.writeMirror(this.catalogMirrorPath(root), catalog);
    return catalog;
  }

  private ensureInitializedNoCatalogRead(root: string): void {
    this.files.ensureDir(join(root, ".awbs", "authority", "views"));
    this.files.ensureDir(join(root, ".awbs", "private"));
    if (!this.files.pathExists(this.repoPath(root))) {
      throw new AwbsError("Authority repo is not initialized. Run `awbs init` first.");
    }
    if (!this.files.pathExists(this.localPath(root))) {
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
    const contract = this.openSeal<AuthorityViewContract>(root, this.viewSealPath(root, viewId), "authority.viewContract");
    this.writeMirror(this.viewMirrorPath(root, viewId), contract);
    return contract;
  }

  private writeSeal(root: string, path: string, payloadType: "authority.catalog", payload: AuthorityCatalog, aad: Record<string, unknown>): void;
  private writeSeal(root: string, path: string, payloadType: "authority.viewContract", payload: AuthorityViewContract, aad: Record<string, unknown>): void;
  private writeSeal(root: string, path: string, payloadType: AuthorityPayloadType, payload: AuthorityCatalog | AuthorityViewContract, aad: Record<string, unknown>): void {
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
    const local = this.files.readJson<AuthorityLocal>(this.localPath(root));
    const password = `${local.localSealSeed}:${local.installationId}:${repo.repoId}:${RUNTIME_PEPPER}`;
    return scryptSync(password, Buffer.from(repo.authoritySalt, "base64"), 32, { N: 16384, r: 8, p: 1 });
  }

  private readRepo(root: string): AuthorityRepo {
    return this.files.readJson<AuthorityRepo>(this.repoPath(root));
  }

  private appendEvent(root: string, event: AuthorityEvent): void {
    const path = this.eventsPath(root);
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

  private catalogSealPath(root: string): string {
    return join(root, ".awbs", "authority", "catalog.seal.json");
  }

  private catalogMirrorPath(root: string): string {
    return join(root, ".awbs", "authority", "catalog.mirror.json");
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
