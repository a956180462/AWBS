import { join, relative } from "node:path";
import { INDEX_PATH, LEGACY_INDEX_PATH, SUMMARY_PATH, TRUSTED_REF } from "../domain/constants.ts";
import { fromPosixPath, normalizeUserPath, toPosixPath } from "../domain/paths.ts";
import type { IndexEntry, IndexKind, IndexStatus, SummaryEntry } from "../domain/types.ts";
import type { FileDatabasePort } from "../ports/file-database.ts";
import type { GitPort } from "../ports/git.ts";
import type { IndexStorePort } from "../ports/index-store.ts";
import type { SummaryStorePort } from "../ports/summary-store.ts";
import { requireTrustedCommit, withTrustedWorktree } from "./trusted-chain.ts";

export type IndexUseCases = {
  rebuildIndex(cwd: string): { active: number; removed: number; path: string };
  queryIndex(cwd: string, term: string | null, options: { json?: boolean; status?: IndexStatus | "all" }): IndexEntry[];
  setSummary(cwd: string, args: { path: string; summary: string }): SummaryEntry;
  getSummary(cwd: string, path: string): SummaryEntry | null;
  listSummaries(cwd: string): SummaryEntry[];
};

export function createIndexUseCases(deps: {
  files: FileDatabasePort;
  git: GitPort;
  index: IndexStorePort;
  summaries: SummaryStorePort;
}): IndexUseCases {
  return {
    rebuildIndex(cwd: string): { active: number; removed: number; path: string } {
      const root = deps.files.findProjectRoot(cwd);
      const indexFile = join(root, INDEX_PATH);
      const oldEntries = deps.index.readIndex(indexFile, join(root, LEGACY_INDEX_PATH));
      const commit = requireTrustedCommit(deps.git, root);
      const activePaths = new Set<string>();
      const nextEntries: IndexEntry[] = [];

      withTrustedWorktree(deps, root, commit, "awbs-index-", (trustedRoot) => {
        for (const fileEntry of deps.files.walkIndexableEntries(trustedRoot)) {
          const absPath = join(trustedRoot, fromPosixPath(fileEntry.path));
          const entry: IndexEntry = {
            path: fileEntry.path,
            kind: fileEntry.kind,
            sha256: fileEntry.sha256,
            size: fileEntry.size,
            mtime: fileEntry.mtime,
            commit,
            status: "active",
            ...resolveSummary(deps.summaries, join(root, SUMMARY_PATH), absPath, fileEntry.path, fileEntry.kind, fileEntry.sha256)
          };
          activePaths.add(fileEntry.path);
          nextEntries.push(entry);
        }
      });

      for (const oldEntry of oldEntries) {
        if (!activePaths.has(oldEntry.path)) {
          nextEntries.push({
            ...oldEntry,
            status: "removed",
            summary: oldEntry.summary || `Removed ${oldEntry.kind}: ${oldEntry.path}`,
            summarySource: oldEntry.summarySource ?? "fallback"
          });
        }
      }

      nextEntries.sort((a, b) => a.path.localeCompare(b.path));
      deps.index.writeIndex(indexFile, nextEntries);

      return {
        active: nextEntries.filter((entry) => entry.status === "active").length,
        removed: nextEntries.filter((entry) => entry.status === "removed").length,
        path: toPosixPath(relative(root, indexFile))
      };
    },

    queryIndex(cwd: string, term: string | null, options: { json?: boolean; status?: IndexStatus | "all" }): IndexEntry[] {
      const root = deps.files.findProjectRoot(cwd);
      const indexFile = join(root, INDEX_PATH);
      return deps.index.queryIndex(indexFile, term, { status: options.status });
    },

    setSummary(cwd: string, args: { path: string; summary: string }): SummaryEntry {
      const root = deps.files.findProjectRoot(cwd);
      const relPath = normalizeUserPath(args.path);
      const absPath = join(root, fromPosixPath(relPath));
      const exists = deps.files.pathExists(absPath);
      const kind: IndexKind | "unknown" = exists ? (deps.files.isDirectory(absPath) ? "directory" : "file") : "unknown";
      const sha256 = exists && kind === "file" ? deps.files.sha256File(absPath) : null;
      return deps.summaries.writeSummary(join(root, SUMMARY_PATH), {
        path: relPath,
        kind,
        sha256,
        commit: deps.git.refCommit(root, TRUSTED_REF) ?? deps.git.headCommit(root),
        summary: args.summary
      });
    },

    getSummary(cwd: string, path: string): SummaryEntry | null {
      const root = deps.files.findProjectRoot(cwd);
      const relPath = normalizeUserPath(path);
      const absPath = join(root, fromPosixPath(relPath));
      const sha256 = deps.files.pathExists(absPath) && !deps.files.isDirectory(absPath) ? deps.files.sha256File(absPath) : null;
      return deps.summaries.findSummary(join(root, SUMMARY_PATH), relPath, sha256);
    },

    listSummaries(cwd: string): SummaryEntry[] {
      const root = deps.files.findProjectRoot(cwd);
      return deps.summaries.readSummaries(join(root, SUMMARY_PATH));
    }
  };
}

function resolveSummary(
  summaries: SummaryStorePort,
  summaryFile: string,
  absPath: string,
  relPath: string,
  kind: IndexKind,
  sha256: string | null
): { summary: string; summarySource: "external" | "fallback" } {
  const external = summaries.findSummary(summaryFile, relPath, sha256);
  if (external) {
    return { summary: external.summary, summarySource: "external" };
  }
  return { summary: summaries.fallbackSummary(absPath, relPath, kind), summarySource: "fallback" };
}
