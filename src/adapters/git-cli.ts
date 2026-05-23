import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { AwbsError } from "../domain/errors.ts";
import type { GitCommandResult, GitPort } from "../ports/git.ts";

export class GitCliAdapter implements GitPort {
  isRepository(root: string): boolean {
    const result = this.runResult(["rev-parse", "--is-inside-work-tree"], root);
    return result.status === 0 && result.stdout.trim() === "true";
  }

  init(root: string): void {
    this.run(["init"], root);
  }

  headCommit(root: string): string | null {
    const result = this.runResult(["rev-parse", "HEAD"], root);
    return result.status === 0 ? result.stdout.trim() : null;
  }

  requireHeadCommit(root: string): string {
    const commit = this.headCommit(root);
    if (!commit) {
      throw new AwbsError("Git HEAD is not available. Create an initial commit before running this command.");
    }
    return commit;
  }

  refCommit(root: string, ref: string): string | null {
    const result = this.runResult(["rev-parse", "--verify", ref], root);
    return result.status === 0 ? result.stdout.trim() : null;
  }

  updateRef(root: string, ref: string, commit: string): void {
    this.run(["update-ref", ref, commit], root);
  }

  isAncestor(root: string, ancestor: string, descendant: string): boolean {
    const result = this.runResult(["merge-base", "--is-ancestor", ancestor, descendant], root);
    return result.status === 0;
  }

  revList(root: string, range: string): string[] {
    const output = this.run(["rev-list", "--reverse", range], root).trim();
    return output ? output.split(/\r?\n/) : [];
  }

  commitParents(root: string, commit: string): string[] {
    const output = this.run(["rev-list", "--parents", "-n", "1", commit], root).trim();
    const parts = output.split(/\s+/).filter(Boolean);
    return parts.slice(1);
  }

  commitMessage(root: string, commit: string): string {
    return this.run(["log", "-1", "--format=%B", commit], root);
  }

  diffNameOnly(root: string, fromCommit: string, toCommit: string): string[] {
    const output = this.run(["diff", "--name-only", "--no-renames", fromCommit, toCommit], root).trim();
    return output ? output.split(/\r?\n/).filter(Boolean) : [];
  }

  pathExistsAtCommit(root: string, commit: string, path: string): boolean {
    return this.runResult(["cat-file", "-e", `${commit}:${path}`], root).status === 0;
  }

  fileSha256AtCommit(root: string, commit: string, path: string): string {
    const result = spawnSync("git", ["-C", root, "show", `${commit}:${path}`], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (result.status !== 0) {
      throw new AwbsError(`git show ${commit}:${path} failed:\n${result.stderr?.toString() ?? result.stdout?.toString() ?? ""}`);
    }
    return createHash("sha256").update(result.stdout ?? Buffer.alloc(0)).digest("hex");
  }

  pathExistsInIndex(root: string, path: string): boolean {
    return this.runResult(["cat-file", "-e", `:${path}`], root).status === 0;
  }

  fileSha256InIndex(root: string, path: string): string {
    const result = spawnSync("git", ["-C", root, "show", `:${path}`], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (result.status !== 0) {
      throw new AwbsError(`git show :${path} failed:\n${result.stderr?.toString() ?? result.stdout?.toString() ?? ""}`);
    }
    return createHash("sha256").update(result.stdout ?? Buffer.alloc(0)).digest("hex");
  }

  statusPorcelain(root: string): string {
    return this.run(["status", "--porcelain", "-uall"], root);
  }

  addAll(root: string, paths: string[]): void {
    this.run(["add", "-A", "--", ...paths], root);
  }

  commit(root: string, message: string): void {
    this.run(["commit", "-m", message], root);
  }

  createDetachedWorktree(root: string, path: string, commit: string): void {
    this.run(["worktree", "add", "--detach", path, commit], root);
  }

  removeWorktree(root: string, path: string): void {
    this.run(["worktree", "remove", "--force", path], root);
  }

  cloneAtCommit(sourceRoot: string, destination: string, commit: string): void {
    this.run(["clone", "--no-checkout", "--no-hardlinks", sourceRoot, destination], sourceRoot);
    const sourceRemote = this.runResult(["remote", "get-url", "origin"], sourceRoot);
    if (sourceRemote.status === 0 && sourceRemote.stdout.trim()) {
      this.run(["remote", "set-url", "origin", sourceRemote.stdout.trim()], destination);
    }
    this.run(["checkout", "--detach", commit], destination);
  }

  diffNoIndex(baselineRoot: string, workspacePath: string): string {
    const result = spawnSync("git", ["diff", "--no-index", "--binary", "--no-color", "--", baselineRoot, workspacePath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (result.status === 0 || result.status === 1) {
      return result.stdout ?? "";
    }
    return `git diff --no-index failed:\n${result.stderr ?? ""}`;
  }

  private run(args: string[], cwd: string): string {
    const result = this.runResult(args, cwd);
    if (result.status !== 0) {
      throw new AwbsError(`git ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
    }
    return result.stdout;
  }

  private runResult(args: string[], cwd: string): GitCommandResult {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: result.status
    };
  }
}
