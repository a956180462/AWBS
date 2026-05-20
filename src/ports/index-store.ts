import type { IndexEntry, IndexStatus } from "../domain/types.ts";

export interface IndexStorePort {
  readIndex(indexFile: string, legacyIndexFile?: string): IndexEntry[];
  writeIndex(indexFile: string, entries: IndexEntry[]): void;
  queryIndex(indexFile: string, term: string | null, options: { status?: IndexStatus | "all" }): IndexEntry[];
}
