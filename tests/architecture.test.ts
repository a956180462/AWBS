import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultRuntime } from "../src/runtime.ts";

test("runtime creates default use case groups", () => {
  const runtime = createDefaultRuntime();
  assert.equal(typeof runtime.usecases.init.initProject, "function");
  assert.equal(typeof runtime.usecases.index.rebuildIndex, "function");
  assert.equal(typeof runtime.usecases.index.queryIndex, "function");
  assert.equal(typeof runtime.usecases.index.setSummary, "function");
  assert.equal(typeof runtime.usecases.index.getSummary, "function");
  assert.equal(typeof runtime.usecases.index.listSummaries, "function");
  assert.equal(typeof runtime.usecases.view.createView, "function");
  assert.equal(typeof runtime.usecases.view.inspectView, "function");
  assert.equal(typeof runtime.usecases.view.revokeView, "function");
  assert.equal(typeof runtime.usecases.changeset.collectChangeset, "function");
  assert.equal(typeof runtime.usecases.changeset.inspectChangeset, "function");
  assert.equal(typeof runtime.usecases.changeset.applyChangeset, "function");
  assert.equal(typeof runtime.usecases.authority.verifyAuthority, "function");
  assert.equal(typeof runtime.usecases.authority.repairMirrors, "function");
  assert.equal(typeof runtime.usecases.session.startSession, "function");
  assert.equal(typeof runtime.usecases.session.statusSession, "function");
  assert.equal(typeof runtime.usecases.session.stopSession, "function");
  assert.equal(typeof runtime.usecases.session.recoverSession, "function");
  assert.equal(typeof runtime.usecases.ledger.bootstrapLedger, "function");
  assert.equal(typeof runtime.usecases.ledger.inspectLedger, "function");
  assert.equal(typeof runtime.usecases.ledger.verifyLedger, "function");
  assert.equal(typeof runtime.usecases.db.auditDatabase, "function");
  assert.equal(typeof runtime.usecases.db.cleanRebuild, "function");
  assert.equal(typeof runtime.usecases.db.listBackups, "function");
});

test("cli depends on runtime, not concrete infrastructure adapters", () => {
  const cliSource = readFileSync("src/cli.ts", "utf8");
  assert.match(cliSource, /from "\.\/runtime\.ts"/);
  assert.doesNotMatch(cliSource, /from "\.\/adapters\//);
  assert.doesNotMatch(cliSource, /from "\.\/usecases\//);
});

test("authority session daemon uses hidden detached spawning without stdio pipes", () => {
  const source = readFileSync("src/adapters/local-authority-session.ts", "utf8");
  assert.match(source, /detached:\s*true/);
  assert.match(source, /stdio:\s*"ignore"/);
  assert.match(source, /windowsHide:\s*true/);
  assert.doesNotMatch(source, /stdio:\s*\[\s*"pipe"/);
});

test("child process calls opt into hidden Windows windows", () => {
  for (const file of listSourceFiles("src").concat(listSourceFiles("tests"))) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (/execFileSync\(|spawnSync\(|spawn\(/.test(lines[index])) {
        const callBlock = lines.slice(index, index + 10).join("\n");
        assert.match(callBlock, /windowsHide:\s*true/, `${file}:${index + 1} starts a child process without windowsHide: true`);
      }
    }
  }
});

function listSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...listSourceFiles(path));
    } else if (path.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}
