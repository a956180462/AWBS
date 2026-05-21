import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const CLI = resolve("src/cli.ts");

test("authority artifacts are created, mirrors rebuild, and workspace manifest cannot expand permissions", () => {
  const project = mkdtempSync(join(tmpdir(), "awbs-authority-"));
  try {
    seedProject(project);

    const createOut = awbs(project, ["view", "create", "--out", "workspace", "--read", "A", "--write", "B"]);
    const viewId = /View created: (\S+)/.exec(createOut)?.[1];
    assert.ok(viewId);
    assert.ok(existsSync(join(project, ".awbs", "authority", "repo.json")));
    assert.ok(existsSync(join(project, ".awbs", "authority", "catalog.seal.json")));
    assert.ok(existsSync(join(project, ".awbs", "authority", "catalog.mirror.json")));
    assert.ok(existsSync(join(project, ".awbs", "authority", "views", viewId, "contract.seal.json")));
    assert.ok(existsSync(join(project, ".awbs", "authority", "views", viewId, "mirror.json")));
    assert.ok(existsSync(join(project, ".awbs", "authority", "views", viewId, "receipt.json")));

    const workspaceManifestPath = join(project, "workspace", ".awbs-view.json");
    const workspaceManifest = JSON.parse(readFileSync(workspaceManifestPath, "utf8"));
    workspaceManifest.writePaths = ["A", "B"];
    writeFileSync(workspaceManifestPath, `${JSON.stringify(workspaceManifest, null, 2)}\n`, "utf8");

    const mirrorPath = join(project, ".awbs", "authority", "views", viewId, "mirror.json");
    writeFileSync(mirrorPath, "{\"hacked\":true}\n", "utf8");
    writeFileSync(join(project, "workspace", "A", "context.md"), "tampered context\n", "utf8");

    const collectOut = awbs(project, ["changeset", "collect", "--workspace", "workspace"]);
    const changesetId = /Changeset collected: (\S+)/.exec(collectOut)?.[1];
    assert.ok(changesetId);
    const manifest = JSON.parse(readFileSync(join(project, ".awbs", "changesets", changesetId, "manifest.json"), "utf8"));
    assert.equal(manifest.status, "invalid");
    assert.equal(manifest.summary.violations, 1);

    const repairedMirror = JSON.parse(readFileSync(mirrorPath, "utf8"));
    assert.equal(repairedMirror.viewId, viewId);
    assert.deepEqual(repairedMirror.writePaths, ["B"]);

    const apply = awbsFail(project, ["changeset", "apply", changesetId, "--adapter", "same-path"]);
    assert.match(apply.stderr, /invalid and cannot be applied/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("tampered sealed view contract prevents collect", () => {
  const project = mkdtempSync(join(tmpdir(), "awbs-seal-tamper-"));
  try {
    seedProject(project);
    const createOut = awbs(project, ["view", "create", "--out", "workspace", "--write", "B"]);
    const viewId = /View created: (\S+)/.exec(createOut)?.[1];
    assert.ok(viewId);

    const sealPath = join(project, ".awbs", "authority", "views", viewId, "contract.seal.json");
    const envelope = JSON.parse(readFileSync(sealPath, "utf8"));
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -4)}AAAA`;
    writeFileSync(sealPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");

    writeFileSync(join(project, "workspace", "B", "draft.md"), "changed\n", "utf8");
    const collect = awbsFail(project, ["changeset", "collect", "--workspace", "workspace"]);
    assert.match(collect.stderr, /Failed to open sealed authority payload/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("revoked view blocks future collect and apply without rolling back applied data", () => {
  const project = mkdtempSync(join(tmpdir(), "awbs-revoke-"));
  try {
    seedProject(project);
    const createOut = awbs(project, ["view", "create", "--out", "workspace", "--write", "B"]);
    const viewId = /View created: (\S+)/.exec(createOut)?.[1];
    assert.ok(viewId);

    writeFileSync(join(project, "workspace", "B", "draft.md"), "applied before revoke\n", "utf8");
    const collectOut = awbs(project, ["changeset", "collect", "--workspace", "workspace"]);
    const changesetId = /Changeset collected: (\S+)/.exec(collectOut)?.[1];
    assert.ok(changesetId);
    awbs(project, ["changeset", "apply", changesetId, "--adapter", "same-path"]);
    assert.equal(readFileSync(join(project, "B", "draft.md"), "utf8"), "applied before revoke\n");

    awbs(project, ["view", "revoke", viewId]);
    assert.equal(readFileSync(join(project, "B", "draft.md"), "utf8"), "applied before revoke\n");
    const inspect = awbs(project, ["view", "inspect", viewId, "--json"]);
    assert.equal(JSON.parse(inspect).catalogView.status, "revoked");

    const collectAfterRevoke = awbsFail(project, ["changeset", "collect", "--workspace", "workspace"]);
    assert.match(collectAfterRevoke.stderr, /View has been revoked/);

    const applyAfterRevoke = awbsFail(project, ["changeset", "apply", changesetId, "--adapter", "same-path"]);
    assert.match(applyAfterRevoke.stderr, /View has been revoked/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("authority verify and repair-mirrors inspect sealed authority state", () => {
  const project = mkdtempSync(join(tmpdir(), "awbs-verify-"));
  try {
    seedProject(project);
    const createOut = awbs(project, ["view", "create", "--out", "workspace", "--write", "B"]);
    const viewId = /View created: (\S+)/.exec(createOut)?.[1];
    assert.ok(viewId);

    const mirrorPath = join(project, ".awbs", "authority", "views", viewId, "mirror.json");
    writeFileSync(mirrorPath, "{\"stale\":true}\n", "utf8");
    const verify = awbs(project, ["authority", "verify", "--json"]);
    const report = JSON.parse(verify);
    assert.equal(report.ok, true);
    assert.ok(report.repairedMirrors.some((path: string) => path.includes(viewId)));

    writeFileSync(mirrorPath, "{\"stale\":true}\n", "utf8");
    const repair = awbs(project, ["authority", "repair-mirrors", "--json"]);
    const repairReport = JSON.parse(repair);
    assert.ok(repairReport.repairedMirrors.some((path: string) => path.includes(viewId)));
  } finally {
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
  awbs(project, ["ledger", "bootstrap"]);
}

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
