import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { attachControllerProof } from "../src/domain/session-proof.ts";

const CLI = resolve("src/cli.ts");
const RECOVERY_SECRET = "test recovery secret";
const CONTROLLER_TOKEN = "test controller token";

test("authority session checks out local key, requires controller token, and stops cleanly", () => {
  const project = mkdtempSync(join(tmpdir(), "awbs-session-"));
  try {
    seedProjectWithoutSession(project);
    startSession(project);

    assert.ok(!existsSync(join(project, ".awbs", "private", "local.json")));
    assert.ok(existsSync(join(project, ".awbs", "private", "session.json")));
    assert.ok(existsSync(join(project, ".awbs", "private", "recovery.seal.json")));

    const sessionText = readFileSync(join(project, ".awbs", "private", "session.json"), "utf8");
    assert.doesNotMatch(sessionText, /controller token|localSealSeed|test recovery secret/);
    const status = JSON.parse(awbs(project, ["authority", "session", "status", "--json"]));
    assert.equal(status.active, true);

    const noToken = awbsFail(project, ["ledger", "bootstrap"]);
    assert.match(noToken.stderr, /requires --control-token-stdin/);
    const wrongSecretField = awbsFailInput(project, ["ledger", "bootstrap", "--control-token-stdin"], JSON.stringify({ recoverySecret: CONTROLLER_TOKEN }));
    assert.match(wrongSecretField.stderr, /controller token is invalid/);
    const rawTokenStop = sessionRequest(project, {
      schemaVersion: 1,
      method: "stop",
      root: project,
      controllerToken: CONTROLLER_TOKEN
    });
    assert.equal(rawTokenStop.ok, false);
    assert.match(rawTokenStop.error, /controller token is invalid/);
    const proofRequest = attachControllerProof({ schemaVersion: 1, method: "ensureInitialized", root: project }, CONTROLLER_TOKEN);
    assert.equal(sessionRequest(project, proofRequest).ok, true);
    const replayedProof = sessionRequest(project, proofRequest);
    assert.equal(replayedProof.ok, false);
    assert.match(replayedProof.error, /controller token is invalid/);

    awbsToken(project, ["ledger", "bootstrap", "--control-token-stdin"]);
    awbsToken(project, ["view", "create", "--out", "workspace", "--write", "B", "--control-token-stdin"]);
    writeFileSync(join(project, "workspace", "B", "draft.md"), "session edit\n", "utf8");
    const collectOut = awbs(project, ["changeset", "collect", "--workspace", "workspace"]);
    const changesetId = /Changeset collected: (\S+)/.exec(collectOut)?.[1];
    assert.ok(changesetId);
    awbsToken(project, ["changeset", "apply", changesetId, "--control-token-stdin"]);

    const stop = JSON.parse(awbsToken(project, ["authority", "session", "stop", "--control-token-stdin", "--json"]));
    assert.equal(stop.stopped, true);
    assert.ok(existsSync(join(project, ".awbs", "private", "local.json")));
    assert.ok(!existsSync(join(project, ".awbs", "private", "session.json")));
    assert.ok(!existsSync(join(project, ".awbs", "private", "recovery.seal.json")));
  } finally {
    safeStopSession(project);
    rmSync(project, { recursive: true, force: true });
  }
});

test("authority session crash requires explicit recovery secret", () => {
  const project = mkdtempSync(join(tmpdir(), "awbs-session-recover-"));
  try {
    seedProjectWithoutSession(project);
    startSession(project);
    const status = JSON.parse(awbs(project, ["authority", "session", "status", "--json"]));
    assert.equal(status.active, true);
    process.kill(status.pid);

    const failedWrite = awbsFailToken(project, ["ledger", "bootstrap", "--control-token-stdin"]);
    assert.match(failedWrite.stderr, /ECONNREFUSED|not active|socket hang up|connect/);
    assert.ok(!existsSync(join(project, ".awbs", "private", "local.json")));

    const badRecover = awbsFailInput(project, ["authority", "session", "recover", "--recovery-secret-stdin"], "wrong secret");
    assert.match(badRecover.stderr, /Failed to open authority recovery seal/);
    assert.ok(!existsSync(join(project, ".awbs", "private", "local.json")));

    const recovered = JSON.parse(awbsInput(project, ["authority", "session", "recover", "--recovery-secret-stdin", "--json"], RECOVERY_SECRET));
    assert.equal(recovered.recovered, true);
    assert.ok(existsSync(join(project, ".awbs", "private", "local.json")));
    assert.ok(!existsSync(join(project, ".awbs", "private", "session.json")));
  } finally {
    safeStopSession(project);
    rmSync(project, { recursive: true, force: true });
  }
});

test("authority session rejects low-level write primitives", () => {
  const project = mkdtempSync(join(tmpdir(), "awbs-session-primitives-"));
  try {
    seedProjectWithoutSession(project);
    startSession(project);

    const createViewContract = sessionRequest(project, {
      schemaVersion: 1,
      method: "createViewContract",
      root: project,
      controllerToken: CONTROLLER_TOKEN,
      args: []
    });
    assert.equal(createViewContract.ok, false);
    assert.match(createViewContract.error, /Unknown authority session method/);

    const appendLedgerEntry = sessionRequest(project, {
      schemaVersion: 1,
      method: "appendLedgerEntry",
      root: project,
      controllerToken: CONTROLLER_TOKEN,
      args: []
    });
    assert.equal(appendLedgerEntry.ok, false);
    assert.match(appendLedgerEntry.error, /Unknown authority session method/);
  } finally {
    safeStopSession(project);
    rmSync(project, { recursive: true, force: true });
  }
});

test("authority session rejects copied repo identity from another Git repository", () => {
  const project = mkdtempSync(join(tmpdir(), "awbs-session-bound-"));
  const fakeProject = mkdtempSync(join(tmpdir(), "awbs-session-fake-"));
  try {
    seedProjectWithoutSession(project);
    startSession(project);

    git(fakeProject, ["init"]);
    mkdirSync(join(fakeProject, ".awbs", "authority"), { recursive: true });
    mkdirSync(join(fakeProject, ".awbs", "private"), { recursive: true });
    writeFileSync(join(fakeProject, ".awbs", "authority", "repo.json"), readFileSync(join(project, ".awbs", "authority", "repo.json"), "utf8"), "utf8");
    writeFileSync(join(fakeProject, ".awbs", "private", "session.json"), readFileSync(join(project, ".awbs", "private", "session.json"), "utf8"), "utf8");

    const response = sessionRequest(fakeProject, {
      schemaVersion: 1,
      method: "readCatalog",
      root: fakeProject,
      args: []
    });
    assert.equal(response.ok, false);
    assert.match(response.error, /same Git repository/);
  } finally {
    safeStopSession(project);
    rmSync(project, { recursive: true, force: true });
    rmSync(fakeProject, { recursive: true, force: true });
  }
});

test("authority session rejects unsigned controller success responses", async () => {
  const project = mkdtempSync(join(tmpdir(), "awbs-session-fake-response-"));
  let originalSessionText = "";
  let capturedRequest = "";
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      capturedRequest += chunk;
      socket.end(`${JSON.stringify({ ok: true, result: null })}\n`, () => socket.destroy());
    });
  });
  try {
    seedProjectWithoutSession(project);
    startSession(project);
    const sessionPath = join(project, ".awbs", "private", "session.json");
    originalSessionText = readFileSync(sessionPath, "utf8");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const session = JSON.parse(originalSessionText);
    session.socketPath = `tcp://127.0.0.1:${address.port}`;
    writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");

    const result = await awbsFailTokenAsync(project, ["ledger", "bootstrap", "--control-token-stdin"]);
    assert.match(result.stderr, /response proof is invalid/);
    assert.doesNotMatch(capturedRequest, /test controller token/);
  } finally {
    server.close();
    if (originalSessionText) {
      writeFileSync(join(project, ".awbs", "private", "session.json"), originalSessionText, "utf8");
    }
    safeStopSession(project);
    rmSync(project, { recursive: true, force: true });
  }
});

type SessionResponse =
  | {
      ok: true;
      result: unknown;
    }
  | {
      ok: false;
      error: string;
    };

function sessionRequest(cwd: string, request: Record<string, unknown>): SessionResponse {
  return JSON.parse(
    execFileSync(process.execPath, [CLI, "__session-request"], {
      cwd,
      encoding: "utf8",
      input: JSON.stringify({ root: cwd, request })
    })
  ) as SessionResponse;
}

function seedProjectWithoutSession(project: string): void {
  awbs(project, ["init"]);
  mkdirSync(join(project, "B"));
  writeFileSync(join(project, "B", "draft.md"), "first draft\n", "utf8");
  git(project, ["config", "user.email", "awbs@example.test"]);
  git(project, ["config", "user.name", "AWBS Test"]);
  git(project, ["add", "."]);
  git(project, ["commit", "-m", "initial"]);
}

function startSession(cwd: string): void {
  awbsInput(cwd, ["authority", "session", "start", "--control-stdin"], JSON.stringify({ recoverySecret: RECOVERY_SECRET, controllerToken: CONTROLLER_TOKEN }));
}

function safeStopSession(cwd: string): void {
  spawnSync(process.execPath, [CLI, "authority", "session", "stop", "--control-token-stdin"], {
    cwd,
    encoding: "utf8",
    input: CONTROLLER_TOKEN
  });
}

function awbs(cwd: string, args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

function awbsToken(cwd: string, args: string[]): string {
  return awbsInput(cwd, args, CONTROLLER_TOKEN);
}

function awbsInput(cwd: string, args: string[], input: string): string {
  return execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", input });
}

function awbsFail(cwd: string, args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function awbsFailToken(cwd: string, args: string[]): { stdout: string; stderr: string } {
  return awbsFailInput(cwd, args, CONTROLLER_TOKEN);
}

async function awbsFailTokenAsync(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdin.end(CONTROLLER_TOKEN);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const status = await new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
  });
  assert.notEqual(status, 0);
  return { stdout, stderr };
}

function awbsFailInput(cwd: string, args: string[], input: string): { stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", input });
  assert.notEqual(result.status, 0);
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
