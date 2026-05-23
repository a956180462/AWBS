import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { LocalFileDatabaseAdapter } from "../src/adapters/local-file-database.ts";

const CLI = resolve("src/cli.ts");
const RECOVERY_SECRET = "test recovery secret";
const CONTROLLER_TOKEN = "test controller token";

test("view create rejects root, .awbs, and .git projections", () => {
  const project = mkdtempSync(join(tmpdir(), "awbs-hardening-paths-"));
  try {
    seedProject(project);

    assert.match(awbsFailToken(project, ["view", "create", "--out", "workspace-root", "--read", ".", "--control-token-stdin"]).stderr, /database root|reserved path|Unsafe path/);
    assert.match(awbsFailToken(project, ["view", "create", "--out", "workspace-parent", "--read", "A/..", "--control-token-stdin"]).stderr, /Unsafe path/);
    assert.match(awbsFailToken(project, ["view", "create", "--out", "workspace-dot", "--read", "A/.", "--control-token-stdin"]).stderr, /Unsafe path/);
    assert.match(awbsFailToken(project, ["view", "create", "--out", "workspace-awbs", "--read", ".awbs", "--control-token-stdin"]).stderr, /reserved path/);
    assert.match(awbsFailToken(project, ["view", "create", "--out", "workspace-awbs-case", "--read", ".AWBS", "--control-token-stdin"]).stderr, /reserved path/);
    assert.match(awbsFailToken(project, ["view", "create", "--out", "workspace-git", "--write", ".git", "--control-token-stdin"]).stderr, /reserved path/);
    assert.match(awbsFailToken(project, ["view", "create", "--out", "workspace-git-case", "--write", ".GIT", "--control-token-stdin"]).stderr, /reserved path/);
    assert.match(awbsFailToken(project, ["view", "create", "--out", ".awbs/workspace", "--write", "B", "--control-token-stdin"]).stderr, /Workspace output cannot be inside AWBS reserved directory/);
    assert.match(awbsFailToken(project, ["view", "create", "--out", ".AWBS/workspace", "--write", "B", "--control-token-stdin"]).stderr, /Workspace output cannot be inside AWBS reserved directory/);
    assert.match(awbsFailToken(project, ["view", "create", "--out", ".git/workspace", "--write", "B", "--control-token-stdin"]).stderr, /Workspace output cannot be inside AWBS reserved directory/);
    assert.match(awbsFailToken(project, ["view", "create", "--out", ".GIT/workspace", "--write", "B", "--control-token-stdin"]).stderr, /Workspace output cannot be inside AWBS reserved directory/);
  } finally {
    safeStopSession(project);
    rmSync(project, { recursive: true, force: true });
  }
});

test("workspace-created .git changes are invalid and cannot damage the repository", () => {
  const project = mkdtempSync(join(tmpdir(), "awbs-hardening-git-"));
  try {
    seedProject(project);
    awbsToken(project, ["view", "create", "--out", "workspace", "--write", "B", "--control-token-stdin"]);
    mkdirSync(join(project, "workspace", ".git"));
    writeFileSync(join(project, "workspace", ".git", "config"), "malicious git payload\n", "utf8");

    const collectOut = awbs(project, ["changeset", "collect", "--workspace", "workspace"]);
    const changesetId = /Changeset collected: (\S+)/.exec(collectOut)?.[1];
    assert.ok(changesetId);
    const manifest = JSON.parse(readFileSync(join(project, ".awbs", "changesets", changesetId, "manifest.json"), "utf8"));
    assert.equal(manifest.status, "invalid");
    assert.ok(manifest.violations.some((change: { path: string }) => change.path === ".git/config"));

    assert.match(awbsFailToken(project, ["changeset", "apply", changesetId, "--control-token-stdin"]).stderr, /reserved path|invalid/);
    assert.ok(existsSync(join(project, ".git")));
    assert.ok(existsSync(join(project, ".git", "HEAD")));
  } finally {
    safeStopSession(project);
    rmSync(project, { recursive: true, force: true });
  }
});

test("changeset apply rejects tampered file payloads", () => {
  const project = mkdtempSync(join(tmpdir(), "awbs-hardening-payload-"));
  try {
    seedProject(project);
    awbsToken(project, ["view", "create", "--out", "workspace", "--write", "B", "--control-token-stdin"]);
    writeFileSync(join(project, "workspace", "B", "draft.md"), "trusted payload\n", "utf8");
    const collectOut = awbs(project, ["changeset", "collect", "--workspace", "workspace"]);
    const changesetId = /Changeset collected: (\S+)/.exec(collectOut)?.[1];
    assert.ok(changesetId);

    writeFileSync(join(project, ".awbs", "changesets", changesetId, "files", "B", "draft.md"), "tampered payload\n", "utf8");
    assert.match(awbsFailToken(project, ["changeset", "apply", changesetId, "--control-token-stdin"]).stderr, /payload sha256 mismatch/);
    assert.equal(readFileSync(join(project, "B", "draft.md"), "utf8"), "first draft\n");
  } finally {
    safeStopSession(project);
    rmSync(project, { recursive: true, force: true });
  }
});

test("stale file summary does not silently attach to changed trusted content", () => {
  const project = mkdtempSync(join(tmpdir(), "awbs-hardening-summary-"));
  try {
    seedProject(project);
    awbs(project, ["summary", "set", "B/draft.md", "--text", "old exact draft summary"]);

    awbsToken(project, ["view", "create", "--out", "workspace", "--write", "B", "--control-token-stdin"]);
    writeFileSync(join(project, "workspace", "B", "draft.md"), "changed content\n", "utf8");
    const collectOut = awbs(project, ["changeset", "collect", "--workspace", "workspace"]);
    const changesetId = /Changeset collected: (\S+)/.exec(collectOut)?.[1];
    assert.ok(changesetId);
    awbsToken(project, ["changeset", "apply", changesetId, "--control-token-stdin"]);

    awbs(project, ["index", "rebuild"]);
    const byOldSummary = JSON.parse(awbs(project, ["index", "query", "old exact", "--json"]));
    assert.equal(byOldSummary.length, 0);
    const byPath = JSON.parse(awbs(project, ["index", "query", "draft", "--json"]));
    assert.equal(byPath.length, 1);
    assert.notEqual(byPath[0].summary, "old exact draft summary");
  } finally {
    safeStopSession(project);
    rmSync(project, { recursive: true, force: true });
  }
});

test("summary commands reject AWBS reserved paths", () => {
  const project = mkdtempSync(join(tmpdir(), "awbs-hardening-summary-path-"));
  try {
    seedProject(project);
    assert.match(awbsFail(project, ["summary", "set", ".awbs/authority/repo.json", "--text", "nope"]).stderr, /reserved path/);
    assert.match(awbsFail(project, ["summary", "get", ".git/config"]).stderr, /reserved path/);
  } finally {
    safeStopSession(project);
    rmSync(project, { recursive: true, force: true });
  }
});

test("file database refuses to write through an existing symlink target", () => {
  const project = mkdtempSync(join(tmpdir(), "awbs-hardening-symlink-"));
  const outside = mkdtempSync(join(tmpdir(), "awbs-hardening-outside-"));
  try {
    const files = new LocalFileDatabaseAdapter();
    mkdirSync(join(project, "source"));
    mkdirSync(join(project, "dest"));
    const outsideTarget = join(outside, "target.txt");
    writeFileSync(join(project, "source", "payload.txt"), "safe payload\n", "utf8");
    writeFileSync(outsideTarget, "outside original\n", "utf8");
    try {
      symlinkSync(outsideTarget, join(project, "dest", "payload.txt"), "file");
    } catch {
      return;
    }

    assert.throws(
      () => files.copyPath(join(project, "source", "payload.txt"), join(project, "dest", "payload.txt")),
      /Symbolic links are not supported/
    );
    assert.equal(readFileSync(outsideTarget, "utf8"), "outside original\n");
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

function awbsFail(cwd: string, args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("changeset apply does not commit extra authority files and repairs committed mirrors", () => {
  const project = mkdtempSync(join(tmpdir(), "awbs-hardening-authority-add-"));
  try {
    seedProject(project);
    const createOut = awbsToken(project, ["view", "create", "--out", "workspace", "--write", "B", "--control-token-stdin"]);
    const viewId = /View created: (\S+)/.exec(createOut)?.[1];
    assert.ok(viewId);

    writeFileSync(join(project, ".awbs", "authority", "views", viewId, "mirror.json"), "{\"tampered\":true}\n", "utf8");
    writeFileSync(join(project, ".awbs", "authority", "evil.txt"), "do not commit me\n", "utf8");
    writeFileSync(join(project, "workspace", "B", "draft.md"), "trusted content despite dirty authority\n", "utf8");

    const collectOut = awbs(project, ["changeset", "collect", "--workspace", "workspace"]);
    const changesetId = /Changeset collected: (\S+)/.exec(collectOut)?.[1];
    assert.ok(changesetId);
    awbsToken(project, ["changeset", "apply", changesetId, "--control-token-stdin"]);

    const trustedCommit = JSON.parse(awbs(project, ["ledger", "inspect", "--json"])).currentTrustedCommit;
    assert.notEqual(gitStatus(project, ["cat-file", "-e", `${trustedCommit}:.awbs/authority/evil.txt`]), 0);
    const committedMirror = JSON.parse(git(project, ["show", `${trustedCommit}:.awbs/authority/views/${viewId}/mirror.json`]));
    assert.equal(committedMirror.viewId, viewId);
    assert.deepEqual(committedMirror.writePaths, ["B"]);
  } finally {
    safeStopSession(project);
    rmSync(project, { recursive: true, force: true });
  }
});

test("changeset apply does not inherit dirty ledger leftovers from the working tree", () => {
  const project = mkdtempSync(join(tmpdir(), "awbs-hardening-ledger-leftover-"));
  try {
    seedProject(project);
    awbsToken(project, ["view", "create", "--out", "workspace", "--write", "B", "--control-token-stdin"]);
    writeFileSync(join(project, "workspace", "B", "draft.md"), "trusted content without dirty ledger\n", "utf8");
    const collectOut = awbs(project, ["changeset", "collect", "--workspace", "workspace"]);
    const changesetId = /Changeset collected: (\S+)/.exec(collectOut)?.[1];
    assert.ok(changesetId);

    writeFileSync(join(project, ".awbs", "authority", "ledger-events.jsonl"), "failed leftover should not enter trusted commit\n", "utf8");
    awbsToken(project, ["changeset", "apply", changesetId, "--control-token-stdin"]);

    const trustedCommit = JSON.parse(awbs(project, ["ledger", "inspect", "--json"])).currentTrustedCommit;
    assert.doesNotMatch(git(project, ["show", `${trustedCommit}:.awbs/authority/ledger-events.jsonl`]), /failed leftover/);
    assert.equal(git(project, ["show", `${trustedCommit}:B/draft.md`]), "trusted content without dirty ledger\n");
  } finally {
    safeStopSession(project);
    rmSync(project, { recursive: true, force: true });
  }
});

function seedProject(project: string): void {
  awbs(project, ["init"]);
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
}

function awbs(cwd: string, args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

function awbsToken(cwd: string, args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", input: CONTROLLER_TOKEN });
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

function gitStatus(cwd: string, args: string[]): number | null {
  return spawnSync("git", args, { cwd, encoding: "utf8" }).status;
}
