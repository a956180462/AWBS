import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const CLI = resolve("src/cli.ts");
const RECOVERY_SECRET = "test recovery secret";
const CONTROLLER_TOKEN = "test controller token";

test("view and index are projected from trusted commit, not polluted working tree", () => {
  const project = mkdtempSync(join(tmpdir(), "awbs-trusted-projection-"));
  try {
    seedProject(project);
    writeFileSync(join(project, "B", "polluted.md"), "untrusted pollution\n", "utf8");

    awbsToken(project, ["view", "create", "--out", "workspace", "--write", "B", "--control-token-stdin"]);
    assert.ok(existsSync(join(project, "workspace", "B", "draft.md")));
    assert.ok(!existsSync(join(project, "workspace", "B", "polluted.md")));

    awbs(project, ["index", "rebuild"]);
    const polluted = JSON.parse(awbs(project, ["index", "query", "polluted", "--json"]));
    assert.equal(polluted.length, 0);
  } finally {
    safeStopSession(project);
    rmSync(project, { recursive: true, force: true });
  }
});

test("external commits do not enter the AWBS trusted chain", () => {
  const project = mkdtempSync(join(tmpdir(), "awbs-trusted-external-"));
  try {
    seedProject(project);
    const trustedBefore = JSON.parse(awbs(project, ["ledger", "inspect", "--json"])).currentTrustedCommit;

    awbsToken(project, ["view", "create", "--out", "workspace", "--write", "B", "--control-token-stdin"]);
    writeFileSync(join(project, "workspace", "B", "draft.md"), "trusted update\n", "utf8");
    const collectOut = awbs(project, ["changeset", "collect", "--workspace", "workspace"]);
    const changesetId = /Changeset collected: (\S+)/.exec(collectOut)?.[1];
    assert.ok(changesetId);

    writeFileSync(join(project, "B", "external.md"), "external commit\n", "utf8");
    git(project, ["add", "B/external.md"]);
    git(project, ["commit", "-m", "external bypass"]);
    const externalCommit = git(project, ["rev-parse", "HEAD"]).trim();

    awbsToken(project, ["changeset", "apply", changesetId, "--control-token-stdin"]);
    const trustedAfter = JSON.parse(awbs(project, ["ledger", "inspect", "--json"])).currentTrustedCommit;
    assert.notEqual(trustedAfter, trustedBefore);
    assert.notEqual(trustedAfter, externalCommit);
    assert.equal(gitStatus(project, ["merge-base", "--is-ancestor", externalCommit, trustedAfter]), 1);
    assert.equal(git(project, ["show", `${trustedAfter}:B/draft.md`]), "trusted update\n");
    assert.notEqual(gitStatus(project, ["cat-file", "-e", `${trustedAfter}:B/external.md`]), 0);

    const audit = JSON.parse(awbsFailAllowed(project, ["db", "audit", "--json"]).stdout);
    assert.equal(audit.ok, false);
    assert.equal(audit.headMatchesTrusted, false);
    assert.ok(audit.errors.some((error: string) => error.includes("not on top")));
  } finally {
    safeStopSession(project);
    rmSync(project, { recursive: true, force: true });
  }
});

test("clean-rebuild swaps in a clean database from trusted commit and keeps backup", () => {
  const project = mkdtempSync(join(tmpdir(), "awbs-clean-rebuild-"));
  let backupPath: string | null = null;
  try {
    seedProject(project);
    awbsToken(project, ["view", "create", "--out", "workspace", "--write", "B", "--control-token-stdin"]);
    writeFileSync(join(project, "workspace", "B", "draft.md"), "clean trusted update\n", "utf8");
    const collectOut = awbs(project, ["changeset", "collect", "--workspace", "workspace"]);
    const changesetId = /Changeset collected: (\S+)/.exec(collectOut)?.[1];
    assert.ok(changesetId);
    awbsToken(project, ["changeset", "apply", changesetId, "--control-token-stdin"]);

    writeFileSync(join(project, "B", "external.md"), "external pollution\n", "utf8");
    git(project, ["add", "B/external.md"]);
    git(project, ["commit", "-m", "external bypass"]);
    safeStopSession(project);

    const report = JSON.parse(awbs(project, ["db", "clean-rebuild", "--json"]));
    backupPath = report.backupPath;
    assert.equal(report.swapped, true);
    assert.ok(existsSync(report.backupPath));
    assert.equal(dirname(report.backupPath), dirname(project));
    assert.equal(readFileSync(join(project, "B", "draft.md"), "utf8").replace(/\r\n/g, "\n"), "clean trusted update\n");
    assert.ok(!existsSync(join(project, "B", "external.md")));
    assert.ok(existsSync(join(project, ".awbs", "private", "local.json")));
    assert.equal(JSON.parse(awbs(project, ["ledger", "verify", "--json"])).ok, true);

    const backups = JSON.parse(awbs(project, ["db", "backups", "list", "--json"]));
    assert.ok(backups.includes(report.backupPath));
  } finally {
    safeStopSession(project);
    rmSync(project, { recursive: true, force: true });
    if (backupPath) {
      rmSync(backupPath, { recursive: true, force: true });
    }
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

function awbsFailAllowed(cwd: string, args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
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
