import { DatabaseSync } from "node:sqlite";
import type { IndexEntry, IndexKind, IndexStatus, SummarySource } from "../domain/types.ts";
import type { FileDatabasePort } from "../ports/file-database.ts";
import type { IndexStorePort } from "../ports/index-store.ts";

type FileRow = {
  json: string;
};

export class SqliteIndexStoreAdapter implements IndexStorePort {
  private readonly files: FileDatabasePort;

  constructor(files: FileDatabasePort) {
    this.files = files;
  }

  readIndex(indexFile: string): IndexEntry[] {
    if (this.files.pathExists(indexFile)) {
      const db = new DatabaseSync(indexFile);
      try {
        ensureSchema(db);
        return readAllEntries(db);
      } finally {
        db.close();
      }
    }
    return [];
  }

  writeIndex(indexFile: string, entries: IndexEntry[]): void {
    const db = new DatabaseSync(indexFile);
    try {
      ensureSchema(db);
      db.exec("BEGIN");
      try {
        db.exec("DELETE FROM files_fts");
        db.exec("DELETE FROM files");
        const insertFile = db.prepare(`
          INSERT INTO files (
            path, kind, sha256, size, mtime, commit_hash, status, summary, summary_source, json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const insertFts = db.prepare("INSERT INTO files_fts(rowid, path, summary) VALUES (?, ?, ?)");
        const selectId = db.prepare("SELECT id FROM files WHERE path = ?");

        for (const entry of entries) {
          insertFile.run(
            entry.path,
            entry.kind,
            entry.sha256,
            entry.size,
            entry.mtime,
            entry.commit,
            entry.status,
            entry.summary,
            entry.summarySource ?? "fallback",
            JSON.stringify(normalizeEntry(entry))
          );
          const row = selectId.get(entry.path) as { id: number };
          insertFts.run(row.id, entry.path, entry.summary);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
    }
  }

  queryIndex(indexFile: string, term: string | null, options: { status?: IndexStatus | "all" }): IndexEntry[] {
    if (!this.files.pathExists(indexFile)) {
      return [];
    }

    const db = new DatabaseSync(indexFile);
    try {
      ensureSchema(db);
      const status = options.status ?? "active";
      if (!term) {
        return queryFiles(db, status);
      }

      const ftsRows = queryFts(db, term, status);
      if (ftsRows.length > 0) {
        return rowsToEntries(ftsRows);
      }
      return rowsToEntries(queryLike(db, term, status));
    } finally {
      db.close();
    }
  }
}

function ensureSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      sha256 TEXT,
      size INTEGER,
      mtime TEXT NOT NULL,
      commit_hash TEXT,
      status TEXT NOT NULL,
      summary TEXT NOT NULL,
      summary_source TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);
    CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
    CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
      path,
      summary,
      content='files',
      content_rowid='id'
    );
  `);
}

function readAllEntries(db: DatabaseSync): IndexEntry[] {
  return rowsToEntries(db.prepare("SELECT json FROM files ORDER BY path").all() as FileRow[]);
}

function queryFiles(db: DatabaseSync, status: IndexStatus | "all"): IndexEntry[] {
  const statement = status === "all" ? db.prepare("SELECT json FROM files ORDER BY path") : db.prepare("SELECT json FROM files WHERE status = ? ORDER BY path");
  const rows = (status === "all" ? statement.all() : statement.all(status)) as FileRow[];
  return rowsToEntries(rows);
}

function queryFts(db: DatabaseSync, term: string, status: IndexStatus | "all"): FileRow[] {
  try {
    const match = quoteFtsTerm(term);
    const where = status === "all" ? "files_fts MATCH ?" : "files_fts MATCH ? AND files.status = ?";
    const statement = db.prepare(`
      SELECT files.json
      FROM files_fts
      JOIN files ON files.id = files_fts.rowid
      WHERE ${where}
      ORDER BY bm25(files_fts), files.path
    `);
    return (status === "all" ? statement.all(match) : statement.all(match, status)) as FileRow[];
  } catch {
    return [];
  }
}

function queryLike(db: DatabaseSync, term: string, status: IndexStatus | "all"): FileRow[] {
  const needle = `%${escapeLike(term.toLowerCase())}%`;
  const where = status === "all"
    ? "(lower(path) LIKE ? ESCAPE '\\' OR lower(summary) LIKE ? ESCAPE '\\')"
    : "status = ? AND (lower(path) LIKE ? ESCAPE '\\' OR lower(summary) LIKE ? ESCAPE '\\')";
  const statement = db.prepare(`SELECT json FROM files WHERE ${where} ORDER BY path`);
  return (status === "all" ? statement.all(needle, needle) : statement.all(status, needle, needle)) as FileRow[];
}

function rowsToEntries(rows: FileRow[]): IndexEntry[] {
  return rows.map((row) => JSON.parse(row.json) as IndexEntry);
}

function normalizeEntry(entry: IndexEntry): IndexEntry & { kind: IndexKind; summarySource: SummarySource } {
  return {
    ...entry,
    summarySource: entry.summarySource ?? "fallback"
  };
}

function quoteFtsTerm(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
