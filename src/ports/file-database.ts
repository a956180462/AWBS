import type { FileEntry, SnapshotEntry } from "../domain/types.ts";

export interface FileDatabasePort {
  findProjectRoot(cwd: string): string;
  pathExists(path: string): boolean;
  isDirectory(path: string): boolean;
  ensureDir(path: string): void;
  assertSafeOutputDirectory(path: string): void;
  copyPath(source: string, destination: string): void;
  removePath(path: string): void;
  readText(path: string): string;
  writeText(path: string, value: string): void;
  readJson<T>(path: string): T;
  writeJson(path: string, value: unknown): void;
  sha256File(path: string): string;
  walkIndexableEntries(root: string): FileEntry[];
  snapshotFiles(root: string, options: { ignoreAwbsViewManifest: boolean }): Map<string, SnapshotEntry>;
}
