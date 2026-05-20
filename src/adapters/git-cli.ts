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

  statusPorcelain(root: string): string {
    return this.run(["status", "--porcelain"], root);
  }

  addAll(root: string, paths: string[]): void {
    this.run(["add", "-A", "--", ...paths], root);
  }

  commit(root: string, message: string): void {
    this.run(["commit", "-m", message], root);
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
