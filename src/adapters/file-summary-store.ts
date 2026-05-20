import { readdirSync, readFileSync } from "node:fs";
import type { IndexKind, SummaryEntry } from "../domain/types.ts";
import type { FileDatabasePort } from "../ports/file-database.ts";
import type { SummaryStorePort, SummaryWriteInput } from "../ports/summary-store.ts";

export class FileSummaryStoreAdapter implements SummaryStorePort {
  private readonly files: FileDatabasePort;

  constructor(files: FileDatabasePort) {
    this.files = files;
  }

  readSummaries(summaryFile: string): SummaryEntry[] {
    if (!this.files.pathExists(summaryFile)) {
      return [];
    }
    const content = this.files.readText(summaryFile).trim();
    if (!content) {
      return [];
    }
    return content.split(/\r?\n/).map((line) => JSON.parse(line) as SummaryEntry);
  }

  writeSummary(summaryFile: string, input: SummaryWriteInput): SummaryEntry {
    const summaries = this.readSummaries(summaryFile);
    const nextEntry: SummaryEntry = {
      schemaVersion: 1,
      path: input.path,
      kind: input.kind,
      sha256: input.sha256,
      commit: input.commit,
      summary: input.summary,
      source: "external",
      updatedAt: new Date().toISOString(),
      ext: {}
    };

    const next = summaries.filter((entry) => !(entry.path === nextEntry.path && entry.sha256 === nextEntry.sha256));
    next.push(nextEntry);
    next.sort((a, b) => a.path.localeCompare(b.path) || (a.sha256 ?? "").localeCompare(b.sha256 ?? ""));
    this.files.writeText(summaryFile, next.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
    return nextEntry;
  }

  findSummary(summaryFile: string, path: string, sha256: string | null): SummaryEntry | null {
    const summaries = this.readSummaries(summaryFile).filter((entry) => entry.path === path);
    const exact = summaries.find((entry) => entry.sha256 === sha256);
    if (exact) {
      return exact;
    }
    const pathLevel = summaries.find((entry) => entry.sha256 === null);
    return pathLevel ?? null;
  }

  fallbackSummary(absPath: string, relPath: string, kind: IndexKind): string {
    if (kind === "directory") {
      const count = readdirSync(absPath).length;
      return `Directory ${relPath} with ${count} item${count === 1 ? "" : "s"}.`;
    }

    const buffer = readFileSync(absPath);
    if (!looksText(buffer)) {
      return `Binary file ${relPath} (${buffer.length} bytes).`;
    }

    if (buffer.length === 0) {
      return `Empty text file ${relPath}.`;
    }
    return `Text file ${relPath} (${buffer.length} bytes).`;
  }
}

function looksText(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return true;
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) {
      return false;
    }
    if (byte < 7 || (byte > 14 && byte < 32)) {
      suspicious += 1;
    }
  }
  return suspicious / sample.length < 0.05;
}
