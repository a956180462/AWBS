import { execFileSync, spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { createServer, connect } from "node:net";
import { join, resolve } from "node:path";
import { platform } from "node:os";
import { AwbsError } from "../domain/errors.ts";
import { attachControllerProof, attachControllerResponseProof, verifyControllerProof } from "../domain/session-proof.ts";
import type { AuthorityLocal, AuthorityRepo } from "../domain/authority-types.ts";
import type {
  AuthoritySessionControlInput,
  AuthoritySessionDaemonStartup,
  AuthoritySessionFile,
  AuthoritySessionRecoverResult,
  AuthoritySessionRequest,
  AuthoritySessionResponse,
  AuthoritySessionStartResult,
  AuthoritySessionStatusReport,
  AuthoritySessionStopResult,
  RecoverySealEnvelope
} from "../domain/session-types.ts";
import type { AuthoritySessionPort } from "../ports/authority-session.ts";
import type { FileDatabasePort } from "../ports/file-database.ts";
import { LocalFileDatabaseAdapter } from "./local-file-database.ts";
import { SealedAuthorityAdapter } from "./sealed-authority.ts";

const RECOVERY_PEPPER = "awbs-recovery-secret-context-v1";

export class LocalAuthoritySessionAdapter implements AuthoritySessionPort {
  private readonly files: FileDatabasePort;
  private readonly cliPath: string;

  constructor(files: FileDatabasePort, cliPath: string) {
    this.files = files;
    this.cliPath = cliPath;
  }

  async start(cwd: string, input: AuthoritySessionControlInput): Promise<AuthoritySessionStartResult> {
    const root = this.files.findProjectRoot(cwd);
    assertControlInput(input);

    const currentStatus = this.status(root);
    if (currentStatus.active) {
      throw new AwbsError("Authority session is already active.");
    }

    const repo = this.readRepo(root);
    if (repo.trustMode !== "ephemeral-local-key-v1") {
      throw new AwbsError("Authority repo trustMode is not ephemeral-local-key-v1. Reinitialize this development database with the current AWBS version.");
    }

    const localPath = this.localPath(root);
    if (!this.files.pathExists(localPath)) {
      throw new AwbsError("Authority local material is missing. Run authority session recover with a recovery secret.");
    }
    const local = this.files.readJson<AuthorityLocal>(localPath);
    const recoverySealPath = this.recoverySealPath(root);
    this.files.writeJson(recoverySealPath, sealRecoveryLocal(repo.repoId, local, input.recoverySecret));

    const startup: AuthoritySessionDaemonStartup = {
      schemaVersion: 1,
      root,
      repoId: repo.repoId,
      local,
      controllerTokenHash: sha256String(input.controllerToken)
    };

    const startupPath = join(root, ".awbs", "private", `session-startup-${randomBytes(8).toString("hex")}.json`);
    this.files.writeJson(startupPath, startup);
    const child = spawn(process.execPath, [this.cliPath, "__session-daemon", "--startup-file", startupPath], {
      cwd: root,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();

    const ready = await this.waitForActive(root, 5000);
    if (!ready.active) {
      try {
        child.kill();
      } catch {
        // Best-effort cleanup; startup failure is reported below.
      }
      this.files.removePath(recoverySealPath);
      this.files.removePath(this.sessionPath(root));
      this.files.removePath(startupPath);
      throw new AwbsError(`Authority session did not become active: ${ready.errors.join("; ") || ready.status}`);
    }

    this.files.removePath(localPath);
    return {
      ...ready,
      recoverySealPath
    };
  }

  status(cwd: string): AuthoritySessionStatusReport {
    const root = this.files.findProjectRoot(cwd);
    const sessionPath = this.sessionPath(root);
    if (!this.files.pathExists(sessionPath)) {
      return inactiveStatus();
    }

    let session: AuthoritySessionFile;
    try {
      session = this.files.readJson<AuthoritySessionFile>(sessionPath);
    } catch (error) {
      return staleStatus([error instanceof Error ? error.message : String(error)]);
    }

    try {
      const response = requestAuthoritySession(this.cliPath, root, { schemaVersion: 1, method: "status", root });
      if (!response.ok) {
        return staleStatus([response.error], session);
      }
      const active = response.result as AuthoritySessionStatusReport;
      return active;
    } catch (error) {
      return staleStatus([error instanceof Error ? error.message : String(error)], session);
    }
  }

  stop(cwd: string, controllerToken: string): AuthoritySessionStopResult {
    const root = this.files.findProjectRoot(cwd);
    assertSecret("controllerToken", controllerToken);
    const response = requestAuthoritySession(this.cliPath, root, attachControllerProof({
      schemaVersion: 1,
      method: "stop",
      root
    }, controllerToken));
    if (!response.ok) {
      throw new AwbsError(response.error);
    }
    return response.result as AuthoritySessionStopResult;
  }

  recover(cwd: string, recoverySecret: string): AuthoritySessionRecoverResult {
    const root = this.files.findProjectRoot(cwd);
    assertSecret("recoverySecret", recoverySecret);
    const currentStatus = this.status(root);
    if (currentStatus.active) {
      throw new AwbsError("Authority session is active. Stop it before recovering local material.");
    }

    const localPath = this.localPath(root);
    if (this.files.pathExists(localPath)) {
      return { recovered: false, localPath };
    }

    const repo = this.readRepo(root);
    const recoverySealPath = this.recoverySealPath(root);
    if (!this.files.pathExists(recoverySealPath)) {
      throw new AwbsError("Authority recovery seal is missing.");
    }

    const envelope = this.files.readJson<RecoverySealEnvelope>(recoverySealPath);
    const local = openRecoveryLocal(repo.repoId, envelope, recoverySecret);
    this.files.writeJson(localPath, local);
    this.files.removePath(recoverySealPath);
    this.files.removePath(this.sessionPath(root));
    return { recovered: true, localPath };
  }

  private async waitForActive(root: string, timeoutMs: number): Promise<AuthoritySessionStatusReport> {
    const start = Date.now();
    let last = inactiveStatus();
    while (Date.now() - start < timeoutMs) {
      last = this.status(root);
      if (last.active) {
        return last;
      }
      await sleep(50);
    }
    return last;
  }

  private readRepo(root: string): AuthorityRepo {
    return this.files.readJson<AuthorityRepo>(this.repoPath(root));
  }

  private repoPath(root: string): string {
    return join(root, ".awbs", "authority", "repo.json");
  }

  private localPath(root: string): string {
    return join(root, ".awbs", "private", "local.json");
  }

  private sessionPath(root: string): string {
    return join(root, ".awbs", "private", "session.json");
  }

  private recoverySealPath(root: string): string {
    return join(root, ".awbs", "private", "recovery.seal.json");
  }
}

export async function runAuthoritySessionDaemon(): Promise<void> {
  const startup = readDaemonStartup(process.argv.slice(3));
  const files = new LocalFileDatabaseAdapter();
  const authority = new SealedAuthorityAdapter(files, { memoryLocal: startup.local });
  const root = resolve(startup.root);
  const boundStartup: AuthoritySessionDaemonStartup = { ...startup, root };
  const usedControllerNonces = new Set<string>();
  const repo = files.readJson<AuthorityRepo>(join(root, ".awbs", "authority", "repo.json"));
  if (repo.repoId !== startup.repoId) {
    throw new AwbsError("Authority session repo id mismatch.");
  }

  const server = createServer((socket) => {
    let body = "";
    let handled = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      body += chunk;
      if (handled || !body.includes("\n")) {
        return;
      }
      handled = true;
      body = body.slice(0, body.indexOf("\n"));
      let method = "";
      try {
        method = (JSON.parse(body) as AuthoritySessionRequest).method;
      } catch {
        method = "";
      }
      void handleSessionRequest(body, boundStartup, authority, files, server, usedControllerNonces)
        .then((response) => {
          socket.end(JSON.stringify(response), () => {
            if (method === "stop" && response.ok) {
              server.close(() => process.exit(0));
            }
          });
        })
        .catch((error) => {
          socket.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies AuthoritySessionResponse));
        });
    });
  });
  server.on("error", (error) => {
    console.error(`authority session server error: ${error.message}`);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new AwbsError("Authority session failed to bind a local endpoint.");
  }

  const session: AuthoritySessionFile = {
    schemaVersion: 1,
    repoId: boundStartup.repoId,
    trustMode: "ephemeral-local-key-v1",
    pid: process.pid,
    socketPath: `tcp://127.0.0.1:${address.port}`,
    startedAt: new Date().toISOString(),
    status: "active"
  };
  files.writeJson(join(boundStartup.root, ".awbs", "private", "session.json"), session);
  await new Promise<void>((resolve) => {
    server.on("close", () => resolve());
  });
}

function readDaemonStartup(argv: string[]): AuthoritySessionDaemonStartup {
  const startupFileIndex = argv.indexOf("--startup-file");
  if (startupFileIndex >= 0) {
    const startupPath = argv[startupFileIndex + 1];
    if (!startupPath) {
      throw new AwbsError("Missing --startup-file value for authority session daemon.");
    }
    const files = new LocalFileDatabaseAdapter();
    try {
      return files.readJson<AuthoritySessionDaemonStartup>(startupPath);
    } finally {
      files.removePath(startupPath);
    }
  }
  throw new AwbsError("Authority session daemon requires --startup-file.");
}

export async function runAuthoritySessionRequest(): Promise<void> {
  const payload = JSON.parse(await readStdin()) as { root: string; request: AuthoritySessionRequest };
  const response = await sendRequestToActiveSession(payload.root, payload.request);
  console.log(JSON.stringify(response));
}

function requestAuthoritySession(cliPath: string, root: string, request: AuthoritySessionRequest): AuthoritySessionResponse {
  const stdout = execFileSync(process.execPath, [cliPath, "__session-request"], {
    cwd: root,
    input: JSON.stringify({ root, request }),
    encoding: "utf8",
    windowsHide: true
  });
  return JSON.parse(stdout) as AuthoritySessionResponse;
}

async function sendRequestToActiveSession(root: string, request: AuthoritySessionRequest): Promise<AuthoritySessionResponse> {
  const files = new LocalFileDatabaseAdapter();
  const sessionPath = join(root, ".awbs", "private", "session.json");
  if (!files.pathExists(sessionPath)) {
    return { ok: false, error: "Authority session is not active." };
  }
  const session = files.readJson<AuthoritySessionFile>(sessionPath);
  const endpoint = parseSocketPath(session.socketPath);

  return await new Promise<AuthoritySessionResponse>((resolve) => {
    const socket = connect(endpoint.port, endpoint.host);
    let response = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("end", () => {
      try {
        resolve(JSON.parse(response) as AuthoritySessionResponse);
      } catch (error) {
        resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
    socket.on("error", (error) => {
      resolve({ ok: false, error: error.message });
    });
  });
}

async function handleSessionRequest(
  body: string,
  startup: AuthoritySessionDaemonStartup,
  authority: SealedAuthorityAdapter,
  files: LocalFileDatabaseAdapter,
  server: ReturnType<typeof createServer>,
  usedControllerNonces: Set<string>
): Promise<AuthoritySessionResponse> {
  let request: AuthoritySessionRequest | null = null;
  let controllerProofAccepted = false;
  try {
    request = JSON.parse(body) as AuthoritySessionRequest;
    if (request.schemaVersion !== 1) {
      throw new AwbsError("Invalid authority session request schema.");
    }
    if (request.controllerProof) {
      assertControllerProof(startup.controllerTokenHash, request, usedControllerNonces);
      controllerProofAccepted = true;
    } else if (isControllerMethod(request.method)) {
      throw new AwbsError("Authority controller token is invalid.");
    }

    const requestedRoot = resolve(request.root || startup.root);
    assertAllowedSessionRoot(startup.root, requestedRoot, startup.repoId, files);
    const root = requestedRoot;
    const args = request.args ?? [];
    let result: unknown;
    switch (request.method) {
      case "status":
        result = {
          status: "active",
          active: true,
          repoId: startup.repoId,
          pid: process.pid,
          socketPath: files.readJson<AuthoritySessionFile>(join(startup.root, ".awbs", "private", "session.json")).socketPath,
          startedAt: files.readJson<AuthoritySessionFile>(join(startup.root, ".awbs", "private", "session.json")).startedAt,
          errors: []
        } satisfies AuthoritySessionStatusReport;
        break;
      case "stop":
        files.writeJson(join(startup.root, ".awbs", "private", "local.json"), startup.local);
        files.removePath(join(startup.root, ".awbs", "private", "recovery.seal.json"));
        files.removePath(join(startup.root, ".awbs", "private", "session.json"));
        result = { stopped: true, localRestored: true } satisfies AuthoritySessionStopResult;
        break;
      case "ensureInitialized":
        authority.ensureInitialized(root);
        result = null;
        break;
      case "createView":
        result = authority.createView(root, args[0] as never);
        break;
      case "getViewContract":
        result = authority.getViewContract(root, args[0] as string, args[1] && typeof args[1] === "object" ? (args[1] as never) : undefined);
        break;
      case "revokeView":
        result = authority.revokeView(root, args[0] as string);
        break;
      case "verify":
        result = authority.verify(root);
        break;
      case "repairMirrors":
        result = authority.repairMirrors(root);
        break;
      case "readCatalog":
        result = authority.readCatalog(root);
        break;
      case "hasLedger":
        result = authority.hasLedger(root);
        break;
      case "bootstrapLedger":
        result = authority.bootstrapLedger(root, args[0] as string);
        break;
      case "readLedger":
        result = authority.readLedger(root);
        break;
      case "recordChangesetApply":
        result = authority.recordChangesetApply(root, args[0] as never);
        break;
      case "sealChangesetReceipt":
        result = authority.sealChangesetReceipt(root, args[0] as string, args[1] as never);
        break;
      case "openChangesetReceipt":
        result = authority.openChangesetReceipt(root, args[0] as string);
        break;
      default:
        throw new AwbsError(`Unknown authority session method: ${request.method}`);
    }
    const response = { ok: true, result } satisfies AuthoritySessionResponse;
    return controllerProofAccepted && request ? attachControllerResponseProof(response, request, startup.controllerTokenHash) : response;
  } catch (error) {
    const response = { ok: false, error: error instanceof Error ? error.message : String(error) } satisfies AuthoritySessionResponse;
    return controllerProofAccepted && request ? attachControllerResponseProof(response, request, startup.controllerTokenHash) : response;
  }
}

function isControllerMethod(method: string): boolean {
  return new Set(["stop", "ensureInitialized", "createView", "revokeView", "bootstrapLedger", "recordChangesetApply", "repairMirrors"]).has(method);
}

function assertAllowedSessionRoot(boundRoot: string, requestedRoot: string, repoId: string, files: LocalFileDatabaseAdapter): void {
  if (requestedRoot === boundRoot) {
    return;
  }
  const requestedRepoPath = join(requestedRoot, ".awbs", "authority", "repo.json");
  if (!files.pathExists(requestedRepoPath)) {
    throw new AwbsError("Authority session can only serve its bound repository or an AWBS trusted worktree from the same Git repository.");
  }
  const requestedRepo = files.readJson<AuthorityRepo>(requestedRepoPath);
  if (requestedRepo.repoId !== repoId) {
    throw new AwbsError("Authority session repo id mismatch for requested root.");
  }
  const boundCommonDir = tryGitCommonDir(boundRoot);
  const requestedCommonDir = tryGitCommonDir(requestedRoot);
  if (boundCommonDir && requestedCommonDir && sameFilesystemPath(boundCommonDir, requestedCommonDir)) {
    return;
  }
  throw new AwbsError("Authority session can only serve trusted worktrees from the same Git repository.");
}

function sameFilesystemPath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return platform() === "win32" ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase() : normalizedLeft === normalizedRight;
}

function tryGitCommonDir(root: string): string | null {
  try {
    return gitCommonDir(root);
  } catch {
    return null;
  }
}

function gitCommonDir(root: string): string {
  try {
    return resolve(execFileSync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim());
  } catch {
    throw new AwbsError(`Cannot verify Git common directory for authority session root: ${root}`);
  }
}

function assertControllerProof(expectedHash: string, request: AuthoritySessionRequest, usedNonces: Set<string>): void {
  if (!verifyControllerProof(expectedHash, request, usedNonces)) {
    throw new AwbsError("Authority controller token is invalid.");
  }
}

function sealRecoveryLocal(repoId: string, local: AuthorityLocal, recoverySecret: string): RecoverySealEnvelope {
  assertSecret("recoverySecret", recoverySecret);
  const salt = randomBytes(24);
  const nonce = randomBytes(12);
  const key = deriveRecoveryKey(repoId, recoverySecret, salt);
  const plaintext = Buffer.from(canonicalJson(local), "utf8");
  const aad = { repoId, payloadType: "authority.local" as const };
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(canonicalJson(aad), "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    schemaVersion: 1,
    sealType: "awbs.recovery.seal.v1",
    payloadType: "authority.local",
    kdf: "scrypt-recovery-secret-v1",
    aad,
    salt: salt.toString("base64"),
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    contentHash: sha256String(plaintext.toString("utf8"))
  };
}

function openRecoveryLocal(repoId: string, envelope: RecoverySealEnvelope, recoverySecret: string): AuthorityLocal {
  if (envelope.sealType !== "awbs.recovery.seal.v1" || envelope.payloadType !== "authority.local") {
    throw new AwbsError("Invalid authority recovery seal.");
  }
  try {
    const key = deriveRecoveryKey(repoId, recoverySecret, Buffer.from(envelope.salt, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64"));
    decipher.setAAD(Buffer.from(canonicalJson(envelope.aad), "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8");
    if (sha256String(plaintext) !== envelope.contentHash) {
      throw new AwbsError("Authority recovery content hash mismatch.");
    }
    return JSON.parse(plaintext) as AuthorityLocal;
  } catch (error) {
    if (error instanceof AwbsError) {
      throw error;
    }
    throw new AwbsError("Failed to open authority recovery seal.");
  }
}

function deriveRecoveryKey(repoId: string, recoverySecret: string, salt: Buffer): Buffer {
  return scryptSync(`${recoverySecret}:${repoId}:${RECOVERY_PEPPER}`, salt, 32, { N: 16384, r: 8, p: 1 });
}

function parseSocketPath(socketPath: string): { host: string; port: number } {
  const match = /^tcp:\/\/([^:]+):(\d+)$/.exec(socketPath);
  if (!match) {
    throw new AwbsError(`Unsupported authority session endpoint: ${socketPath}`);
  }
  return { host: match[1], port: Number(match[2]) };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function assertControlInput(input: AuthoritySessionControlInput): void {
  assertSecret("recoverySecret", input.recoverySecret);
  assertSecret("controllerToken", input.controllerToken);
}

function assertSecret(name: string, value: string | undefined): asserts value is string {
  if (!value || value.trim().length === 0) {
    throw new AwbsError(`${name} is required.`);
  }
}

function inactiveStatus(): AuthoritySessionStatusReport {
  return {
    status: "inactive",
    active: false,
    repoId: null,
    pid: null,
    socketPath: null,
    startedAt: null,
    errors: []
  };
}

function staleStatus(errors: string[], session?: AuthoritySessionFile): AuthoritySessionStatusReport {
  return {
    status: "stale",
    active: false,
    repoId: session?.repoId ?? null,
    pid: session?.pid ?? null,
    socketPath: session?.socketPath ?? null,
    startedAt: session?.startedAt ?? null,
    errors
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
