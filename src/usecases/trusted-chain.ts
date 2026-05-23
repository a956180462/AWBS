import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { TRUSTED_REF } from "../domain/constants.ts";
import { AwbsError } from "../domain/errors.ts";
import type { FileDatabasePort } from "../ports/file-database.ts";
import type { GitPort } from "../ports/git.ts";

export function requireTrustedCommit(git: GitPort, root: string): string {
  const trustedCommit = git.refCommit(root, TRUSTED_REF);
  if (!trustedCommit) {
    throw new AwbsError("AWBS trusted chain is not bootstrapped. Run `awbs ledger bootstrap` after creating an initial Git commit.");
  }
  return trustedCommit;
}

export function withTrustedWorktree<T>(
  deps: { files: FileDatabasePort; git: GitPort },
  root: string,
  commit: string,
  prefix: string,
  fn: (worktreeRoot: string) => T
): T {
  const parent = mkdtempSync(join(tmpdir(), prefix));
  const worktreeRoot = join(parent, "worktree");
  try {
    deps.git.createDetachedWorktree(root, worktreeRoot, commit);
    copyPrivateMaterial(deps.files, root, worktreeRoot);
    return fn(worktreeRoot);
  } finally {
    try {
      deps.git.removeWorktree(root, worktreeRoot);
    } catch {
      // Best-effort cleanup; the caller's primary error should remain visible.
    }
    rmSync(parent, { recursive: true, force: true });
  }
}

function copyPrivateMaterial(files: FileDatabasePort, root: string, worktreeRoot: string): void {
  const source = join(root, ".awbs", "private");
  const destination = join(worktreeRoot, ".awbs", "private");
  if (!existsSync(source)) {
    return;
  }
  files.copyPath(source, destination);
}

export function assertInsideParent(parent: string, child: string): void {
  const normalizedParent = resolve(parent);
  const normalizedChild = resolve(child);
  const childRelative = relative(normalizedParent, normalizedChild);
  if (childRelative.startsWith("..") || dirname(childRelative) === ".." || normalizedChild === normalizedParent) {
    throw new AwbsError(`Path escapes expected parent: ${child}`);
  }
}
