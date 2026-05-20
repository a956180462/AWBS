import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";

const CLI = resolve("src/cli.ts");

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
    const initialHead = git(project, ["rev-parse", "HEAD"]).trim();

    awbs(project, ["index", "rebuild"]);
    assert.ok(existsSync(join(project, ".awbs", "index", "files.sqlite")));
    const indexQuery = JSON.parse(awbs(project, ["index", "query", "draft", "--json"]));
    assert.ok(indexQuery.some((entry: { path: string; commit: string | null; status: string }) => entry.path === "B/draft.md" && entry.commit && entry.status === "active"));

    awbs(project, ["view", "create", "--out", "workspace-good", "--read", "A", "--write", "B"]);
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
    awbs(project, ["changeset", "apply", goodId, "--adapter", "same-path"]);
    assert.equal(readFileSync(join(project, "B", "draft.md"), "utf8"), "second draft\n");
    assert.notEqual(git(project, ["rev-parse", "HEAD"]).trim(), initialHead);

    awbs(project, ["view", "create", "--out", "workspace-bad", "--read", "A", "--write", "B"]);
    writeFileSync(join(project, "workspace-bad", "A", "context.md"), "mutated context\n", "utf8");
    const badCollectOut = awbs(project, ["changeset", "collect", "--workspace", "workspace-bad"]);
    const badId = /Changeset collected: (\S+)/.exec(badCollectOut)?.[1];
    assert.ok(badId);
    const badManifest = JSON.parse(readFileSync(join(project, ".awbs", "changesets", badId, "manifest.json"), "utf8"));
    assert.equal(badManifest.status, "invalid");
    assert.equal(badManifest.summary.violations, 1);
    const badApply = awbsFail(project, ["changeset", "apply", badId, "--adapter", "same-path"]);
    assert.match(badApply.stderr, /invalid and cannot be applied/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("apply rejects stale base commits", () => {
  const project = mkdtempSync(join(tmpdir(), "awbs-stale-"));
  try {
    awbs(project, ["init"]);
    mkdirSync(join(project, "B"));
    writeFileSync(join(project, "B", "draft.md"), "one\n", "utf8");
    git(project, ["config", "user.email", "awbs@example.test"]);
    git(project, ["config", "user.name", "AWBS Test"]);
    git(project, ["add", "."]);
    git(project, ["commit", "-m", "initial"]);

    awbs(project, ["view", "create", "--out", "workspace", "--write", "B"]);
    writeFileSync(join(project, "workspace", "B", "draft.md"), "two\n", "utf8");
    const collectOut = awbs(project, ["changeset", "collect", "--workspace", "workspace"]);
    const id = /Changeset collected: (\S+)/.exec(collectOut)?.[1];
    assert.ok(id);

    writeFileSync(join(project, "B", "other.md"), "parallel\n", "utf8");
    git(project, ["add", "."]);
    git(project, ["commit", "-m", "parallel"]);

    const result = awbsFail(project, ["changeset", "apply", id, "--adapter", "same-path"]);
    assert.match(result.stderr, /Base commit mismatch/);
  } finally {
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

    awbs(project, ["index", "rebuild"]);
    rmSync(join(project, "note.md"));
    git(project, ["add", "-A"]);
    git(project, ["commit", "-m", "remove note"]);
    awbs(project, ["index", "rebuild"]);

    const removed = awbs(project, ["index", "query", "note.md", "--status", "removed", "--json"]);
    const entries = JSON.parse(removed);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].path, "note.md");
    assert.equal(entries[0].status, "removed");
    assert.match(entries[0].summary, /hello index|note.md/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("index rebuild migrates legacy JSONL removed entries into disk sqlite", () => {
  const project = mkdtempSync(join(tmpdir(), "awbs-legacy-index-"));
  try {
    awbs(project, ["init"]);
    writeFileSync(join(project, ".awbs", "index", "files.jsonl"), `${JSON.stringify({
      path: "old.md",
      kind: "file",
      sha256: "legacy",
      size: 3,
      mtime: new Date(0).toISOString(),
      commit: "legacy-commit",
      status: "active",
      summary: "legacy old summary",
      summarySource: "external"
    })}\n`, "utf8");
    writeFileSync(join(project, "current.md"), "current\n", "utf8");
    git(project, ["config", "user.email", "awbs@example.test"]);
    git(project, ["config", "user.name", "AWBS Test"]);
    git(project, ["add", "."]);
    git(project, ["commit", "-m", "initial"]);

    awbs(project, ["index", "rebuild"]);
    assert.ok(existsSync(join(project, ".awbs", "index", "files.sqlite")));
    const removed = JSON.parse(awbs(project, ["index", "query", "old.md", "--status", "removed", "--json"]));
    assert.equal(removed.length, 1);
    assert.equal(removed[0].path, "old.md");
    assert.equal(removed[0].summary, "legacy old summary");
  } finally {
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
    rmSync(project, { recursive: true, force: true });
  }
});

function awbs(cwd: string, args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

function awbsFail(cwd: string, args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
