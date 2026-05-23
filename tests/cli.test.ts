import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";

const CLI = resolve("src/cli.ts");
const RECOVERY_SECRET = "test recovery secret";
const CONTROLLER_TOKEN = "test controller token";

test("awbs v0 closed loop and read-only violation handling", () => {
  const project = mkdtempSync(join(tmpdir(), "awbs-v0-"));
  try {
    awbs(project, ["init"]);
    assert.ok(existsSync(join(project, ".git")));
    assert.ok(existsSync(join(project, ".awbs", "config.json")));

    mkdirSync(join(project, "A"));
    mkdirSync(join(project, "B"));
    writeFileSync(join(project, "A", "context.md"), "read only context\n", "utf8");
    writeFileSync(join(project, "B", "draft.md"), "first draft\n", "utf8");
    git(project, ["config", "user.email", "awbs@example.test"]);
    git(project, ["config", "user.name", "AWBS Test"]);
    git(project, ["add", "."]);
    git(project, ["commit", "-m", "initial"]);
    startSession(project);
    awbsToken(project, ["ledger", "bootstrap", "--control-token-stdin"]);
    const initialHead = git(project, ["rev-parse", "HEAD"]).trim();

    awbs(project, ["index", "rebuild"]);
    assert.ok(existsSync(join(project, ".awbs", "index", "files.sqlite")));
    const indexQuery = JSON.parse(awbs(project, ["index", "query", "draft", "--json"]));
    assert.ok(indexQuery.some((entry: { path: string; commit: string | null; status: string }) => entry.path === "B/draft.md" && entry.commit && entry.status === "active"));

    awbsToken(project, ["view", "create", "--out", "workspace-good", "--read", "A", "--write", "B", "--control-token-stdin"]);
    assert.ok(existsSync(join(project, "workspace-good", "A", "context.md")));
    assert.ok(existsSync(join(project, "workspace-good", "B", "draft.md")));
    assert.ok(!existsSync(join(project, "workspace-good", "C")));

    writeFileSync(join(project, "workspace-good", "B", "draft.md"), "second draft\n", "utf8");
    const collectOut = awbs(project, ["changeset", "collect", "--workspace", "workspace-good"]);
    const goodId = /Changeset collected: (\S+)/.exec(collectOut)?.[1];
    assert.ok(goodId);
    const goodManifest = JSON.parse(readFileSync(join(project, ".awbs", "changesets", goodId, "manifest.json"), "utf8"));
    assert.equal(goodManifest.status, "valid");
    assert.equal(goodManifest.summary.modified, 1);

    const inspect = awbs(project, ["changeset", "inspect", goodId]);
    assert.match(inspect, /Status: valid/);
    awbsToken(project, ["changeset", "apply", goodId, "--adapter", "same-path", "--control-token-stdin"]);
    assert.equal(readFileSync(join(project, "B", "draft.md"), "utf8"), "second draft\n");
    assert.notEqual(git(project, ["rev-parse", "HEAD"]).trim(), initialHead);

    awbsToken(project, ["view", "create", "--out", "workspace-bad", "--read", "A", "--write", "B", "--control-token-stdin"]);
    writeFileSync(join(project, "workspace-bad", "A", "context.md"), "mutated context\n", "utf8");
    const badCollectOut = awbs(project, ["changeset", "collect", "--workspace", "workspace-bad"]);
    const badId = /Changeset collected: (\S+)/.exec(badCollectOut)?.[1];
    assert.ok(badId);
    const badManifest = JSON.parse(readFileSync(join(project, ".awbs", "changesets", badId, "manifest.json"), "utf8"));
    assert.equal(badManifest.status, "invalid");
    assert.equal(badManifest.summary.violations, 1);
    const badApply = awbsFailToken(project, ["changeset", "apply", badId, "--adapter", "same-path", "--control-token-stdin"]);
    assert.match(badApply.stderr, /invalid and cannot be applied/);
  } finally {
    safeStopSession(project);
    rmSync(project, { recursive: true, force: true });
  }
});

test("apply rejects stale view once trusted chain advances", () => {
  const project = mkdtempSync(join(tmpdir(), "awbs-stale-"));
  try {
    awbs(project, ["init"]);
    mkdirSync(join(project, "B"));
    writeFileSync(join(project, "B", "draft.md"), "one\n", "utf8");
    git(project, ["config", "user.email", "awbs@example.test"]);
    git(project, ["config", "user.name", "AWBS Test"]);
    git(project, ["add", "."]);
    git(project, ["commit", "-m", "initial"]);
    startSession(project);
    awbsToken(project, ["ledger", "bootstrap", "--control-token-stdin"]);

    awbsToken(project, ["view", "create", "--out", "workspace-old", "--write", "B", "--control-token-stdin"]);
    writeFileSync(join(project, "workspace-old", "B", "draft.md"), "old view edit\n", "utf8");
    const oldCollectOut = awbs(project, ["changeset", "collect", "--workspace", "workspace-old"]);
    const oldId = /Changeset collected: (\S+)/.exec(oldCollectOut)?.[1];
    assert.ok(oldId);

    awbsToken(project, ["view", "create", "--out", "workspace-new", "--write", "B", "--control-token-stdin"]);
    writeFileSync(join(project, "workspace-new", "B", "draft.md"), "new trusted edit\n", "utf8");
    const newCollectOut = awbs(project, ["changeset", "collect", "--workspace", "workspace-new"]);
    const newId = /Changeset collected: (\S+)/.exec(newCollectOut)?.[1];
    assert.ok(newId);
    awbsToken(project, ["changeset", "apply", newId, "--adapter", "same-path", "--control-token-stdin"]);

    const result = awbsFailToken(project, ["changeset", "apply", oldId, "--adapter", "same-path", "--control-token-stdin"]);
    assert.match(result.stderr, /Stale view/);
  } finally {
    safeStopSession(project);
    rmSync(project, { recursive: true, force: true });
  }
});

test("index rebuild keeps removed entries", () => {
  const project = mkdtempSync(join(tmpdir(), "awbs-index-"));
  try {
    awbs(project, ["init"]);
    writeFileSync(join(project, "note.md"), "hello index\n", "utf8");
    git(project, ["config", "user.email", "awbs@example.test"]);
    git(project, ["config", "user.name", "AWBS Test"]);
    git(project, ["add", "."]);
    git(project, ["commit", "-m", "initial"]);
    startSession(project);
    awbsToken(project, ["ledger", "bootstrap", "--control-token-stdin"]);

    awbs(project, ["index", "rebuild"]);
    awbsToken(project, ["view", "create", "--out", "workspace-remove", "--write", "note.md", "--control-token-stdin"]);
    rmSync(join(project, "workspace-remove", "note.md"));
    const collectOut = awbs(project, ["changeset", "collect", "--workspace", "workspace-remove"]);
    const changesetId = /Changeset collected: (\S+)/.exec(collectOut)?.[1];
    assert.ok(changesetId);
    awbsToken(project, ["changeset", "apply", changesetId, "--control-token-stdin"]);
    awbs(project, ["index", "rebuild"]);

    const removed = awbs(project, ["index", "query", "note.md", "--status", "removed", "--json"]);
    const entries = JSON.parse(removed);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].path, "note.md");
    assert.equal(entries[0].status, "removed");
    assert.match(entries[0].summary, /hello index|note.md/);
  } finally {
    safeStopSession(project);
    rmSync(project, { recursive: true, force: true });
  }
});

test("index query uses persistent sqlite, FTS summary search, path search, and special-character fallback", () => {
  const project = mkdtempSync(join(tmpdir(), "awbs-sqlite-index-"));
  try {
    awbs(project, ["init"]);
    writeFileSync(join(project, "scene-001.md"), "plain text\n", "utf8");
    writeFileSync(join(project, "special_[x].md"), "special text\n", "utf8");
    git(project, ["config", "user.email", "awbs@example.test"]);
    git(project, ["config", "user.name", "AWBS Test"]);
    git(project, ["add", "."]);
    git(project, ["commit", "-m", "initial"]);
    startSession(project);
    awbsToken(project, ["ledger", "bootstrap", "--control-token-stdin"]);

    awbs(project, ["summary", "set", "scene-001.md", "--text", "unique semantic beacon"]);
    awbs(project, ["index", "rebuild"]);

    const bySummary = JSON.parse(awbs(project, ["index", "query", "semantic", "--json"]));
    assert.equal(bySummary.length, 1);
    assert.equal(bySummary[0].path, "scene-001.md");

    const byPath = JSON.parse(awbs(project, ["index", "query", "scene-001", "--json"]));
    assert.equal(byPath.length, 1);
    assert.equal(byPath[0].path, "scene-001.md");

    const special = awbs(project, ["index", "query", "[x]", "--json"]);
    assert.doesNotThrow(() => JSON.parse(special));
  } finally {
    safeStopSession(project);
    rmSync(project, { recursive: true, force: true });
  }
});

test("external summaries are written through AWBS and used by index rebuild", () => {
  const project = mkdtempSync(join(tmpdir(), "awbs-summary-"));
  try {
    awbs(project, ["init"]);
    writeFileSync(join(project, "note.md"), "raw content that AWBS should not pretend to semantically understand\n", "utf8");
    git(project, ["config", "user.email", "awbs@example.test"]);
    git(project, ["config", "user.name", "AWBS Test"]);
    git(project, ["add", "."]);
    git(project, ["commit", "-m", "initial"]);
    startSession(project);
    awbsToken(project, ["ledger", "bootstrap", "--control-token-stdin"]);

    awbs(project, ["summary", "set", "note.md", "--text", "Business-owned note summary"]);
    const getSummary = awbs(project, ["summary", "get", "note.md"]);
    assert.equal(getSummary.trim(), "Business-owned note summary");

    const list = awbs(project, ["summary", "list", "--json"]);
    const summaries = JSON.parse(list);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].source, "external");

    awbs(project, ["index", "rebuild"]);
    const query = awbs(project, ["index", "query", "Business-owned", "--json"]);
    const entries = JSON.parse(query);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].path, "note.md");
    assert.equal(entries[0].summary, "Business-owned note summary");
    assert.equal(entries[0].summarySource, "external");
  } finally {
    safeStopSession(project);
    rmSync(project, { recursive: true, force: true });
  }
});

function awbs(cwd: string, args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

function awbsToken(cwd: string, args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", input: CONTROLLER_TOKEN });
}

function awbsFail(cwd: string, args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function awbsFailToken(cwd: string, args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", input: CONTROLLER_TOKEN });
  assert.notEqual(result.status, 0);
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function startSession(cwd: string): void {
  execFileSync(process.execPath, [CLI, "authority", "session", "start", "--control-stdin"], {
    cwd,
    encoding: "utf8",
    input: JSON.stringify({ recoverySecret: RECOVERY_SECRET, controllerToken: CONTROLLER_TOKEN })
  });
}

function safeStopSession(cwd: string): void {
  spawnSync(process.execPath, [CLI, "authority", "session", "stop", "--control-token-stdin"], {
    cwd,
    encoding: "utf8",
    input: CONTROLLER_TOKEN
  });
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
