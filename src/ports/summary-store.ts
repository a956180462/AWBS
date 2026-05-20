import type { IndexKind, SummaryEntry } from "../domain/types.ts";

export type SummaryWriteInput = {
  path: string;
  kind: IndexKind | "unknown";
  sha256: string | null;
  commit: string | null;
  summary: string;
};

export interface SummaryStorePort {
  readSummaries(summaryFile: string): SummaryEntry[];
  writeSummary(summaryFile: string, input: SummaryWriteInput): SummaryEntry;
  findSummary(summaryFile: string, path: string, sha256: string | null): SummaryEntry | null;
  fallbackSummary(absPath: string, relPath: string, kind: IndexKind): string;
}
