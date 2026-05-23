import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { INDEX_EXCLUDED_PATHS, VIEW_MANIFEST } from "../domain/constants.ts";
import { AwbsError } from "../domain/errors.ts";
import type { FileEntry, IndexKind, SnapshotEntry } from "../domain/types.ts";
import type { FileDatabasePort } from "../ports/file-database.ts";

export class LocalFileDatabaseAdapter implements FileDatabasePort {
  findProjectRoot(cwd: string): string {
    let current = cwd;
    while (true) {
      if (existsSync(join(current, ".awbs", "config.json"))) {
        return current;
      }
      const parent = dirname(current);
      if (parent === current) {
        throw new AwbsError("No AWBS project found. Run `awbs init` first.");
      }
      current = parent;
    }
  }

  pathExists(path: string): boolean {
    return existsSync(path);
  }

  isDirectory(path: string): boolean {
    return statSync(path).isDirectory();
  }

  ensureDir(path: string): void {
    assertSafeDirectoryTarget(path);
    mkdirSync(path, { recursive: true });
  }

  assertSafeOutputDirectory(path: string): void {
    if (existsSync(path) && readdirSync(path).length > 0) {
      throw new AwbsError(`Output directory already exists and is not empty: ${path}`);
    }
  }

  copyPath(source: string, destination: string): void {
    assertNoSymlinkTree(source);
    assertSafeFileTarget(destination);
    this.ensureDir(dirname(destination));
    cpSync(source, destination, { recursive: true, force: true, errorOnExist: false });
  }

  removePath(path: string): void {
    assertSafeFileTarget(path);
    if (existsSync(path)) {
      assertNotSymlink(path);
      rmSync(path, { recursive: true, force: true });
    }
  }

  readText(path: string): string {
    assertSafeFileTarget(path);
    return readFileSync(path, "utf8");
  }

  writeText(path: string, value: string): void {
    assertSafeFileTarget(path);
    this.ensureDir(dirname(path));
    writeFileSync(path, value, "utf8");
  }

  readJson<T>(path: string): T {
    assertSafeFileTarget(path);
    return JSON.parse(readFileSync(path, "utf8")) as T;
  }

  writeJson(path: string, value: unknown): void {
    assertSafeFileTarget(path);
    this.ensureDir(dirname(path));
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  sha256File(path: string): string {
    assertSafeFileTarget(path);
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  }

  walkIndexableEntries(root: string): FileEntry[] {
    const results: FileEntry[] = [];
    const visit = (absPath: string, relPath: string): void => {
      if (shouldExclude(relPath)) {
        return;
      }
      const lstat = lstatSync(absPath);
      if (lstat.isSymbolicLink()) {
        throw new AwbsError(`Symbolic links are not supported by AWBS file database paths: ${absPath}`);
      }
      const stats = statSync(absPath);
      if (relPath) {
        const kind: IndexKind = stats.isDirectory() ? "directory" : "file";
        results.push({
          path: relPath,
          kind,
          sha256: kind === "file" ? this.sha256File(absPath) : null,
          size: kind === "file" ? stats.size : null,
          mtime: stats.mtime.toISOString()
        });
      }
      if (stats.isDirectory()) {
        const children = readdirSync(absPath).sort((a, b) => a.localeCompare(b));
        for (const child of children) {
          const childRel = relPath ? `${relPath}/${child}` : child;
          visit(join(absPath, child), childRel);
        }
      }
    };
    visit(root, "");
    return results;
  }

  snapshotFiles(root: string, options: { ignoreAwbsViewManifest: boolean }): Map<string, SnapshotEntry> {
    const entries = new Map<string, SnapshotEntry>();
    if (!existsSync(root)) {
      return entries;
    }

    const visit = (absPath: string, relPath: string): void => {
      if (options.ignoreAwbsViewManifest && relPath === VIEW_MANIFEST) {
        return;
      }
      const lstat = lstatSync(absPath);
      if (lstat.isSymbolicLink()) {
        throw new AwbsError(`Symbolic links are not supported by AWBS snapshots: ${absPath}`);
      }
      const stats = statSync(absPath);
      if (stats.isDirectory()) {
        const children = readdirSync(absPath).sort((a, b) => a.localeCompare(b));
        for (const child of children) {
          const childRel = relPath ? `${relPath}/${child}` : child;
          visit(join(absPath, child), childRel);
        }
        return;
      }
      entries.set(relPath, {
        path: relPath,
        sha256: this.sha256File(absPath),
        size: stats.size
      });
    };

    visit(root, "");
    return entries;
  }
}

function assertNoSymlinkTree(path: string): void {
  assertNotSymlink(path);
  if (!statSync(path).isDirectory()) {
    return;
  }
  const children = readdirSync(path);
  for (const child of children) {
    assertNoSymlinkTree(join(path, child));
  }
}

function assertNotSymlink(path: string): void {
  if (lstatSync(path).isSymbolicLink()) {
    throw new AwbsError(`Symbolic links are not supported by AWBS file database paths: ${path}`);
  }
}

function assertNoSymlinkInExistingAncestors(path: string): void {
  let current = dirname(path);
  while (current && current !== dirname(current)) {
    if (existsSync(current)) {
      assertNotSymlink(current);
    }
    current = dirname(current);
  }
}

function assertSafeFileTarget(path: string): void {
  assertNoSymlinkInExistingAncestors(path);
  if (existsSync(path)) {
    assertNotSymlink(path);
  }
}

function assertSafeDirectoryTarget(path: string): void {
  assertNoSymlinkInExistingAncestors(path);
  if (existsSync(path)) {
    assertNotSymlink(path);
  }
}

function shouldExclude(relPath: string): boolean {
  if (!relPath) {
    return false;
  }
  return INDEX_EXCLUDED_PATHS.some((excluded) => relPath === excluded || relPath.startsWith(`${excluded}/`));
}
