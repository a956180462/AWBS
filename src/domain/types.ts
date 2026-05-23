export type IndexStatus = "active" | "removed";
export type IndexKind = "file" | "directory";
export type ChangeKind = "add" | "modify" | "delete";
export type ChangesetStatus = "valid" | "invalid";
export type SummarySource = "external" | "fallback" | "path-level";

export type IndexEntry = {
  path: string;
  kind: IndexKind;
  sha256: string | null;
  size: number | null;
  mtime: string;
  commit: string | null;
  status: IndexStatus;
  summary: string;
  summarySource?: SummarySource;
};

export type SummaryEntry = {
  schemaVersion: 1;
  path: string;
  kind: IndexKind | "unknown";
  sha256: string | null;
  commit: string | null;
  summary: string;
  source: "external";
  updatedAt: string;
  ext: Record<string, unknown>;
};

export type ViewManifest = {
  schemaVersion: 1;
  viewId: string;
  projectRoot: string;
  workspacePath: string;
  baseCommit: string;
  createdAt: string;
  readPaths: string[];
  writePaths: string[];
  sources: Array<{
    path: string;
    sourcePath: string;
    workspacePath: string;
    baselinePath: string;
    kind: IndexKind;
    sha256: string | null;
  }>;
};

export type ChangeRecord = {
  path: string;
  kind: ChangeKind;
  allowed: boolean;
  reason?: string;
  file?: string;
  sha256?: string | null;
};

export type ChangesetManifest = {
  schemaVersion: 1;
  changesetId: string;
  viewId: string;
  baseCommit: string;
  createdAt: string;
  projectRoot: string;
  workspacePath: string;
  status: ChangesetStatus;
  readPaths: string[];
  writePaths: string[];
  changes: ChangeRecord[];
  violations: ChangeRecord[];
  payloadHash: string;
  operationHash: string;
  summary: {
    added: number;
    modified: number;
    deleted: number;
    violations: number;
  };
};

export type SnapshotEntry = {
  path: string;
  sha256: string;
  size: number;
};

export type FileEntry = {
  path: string;
  kind: IndexKind;
  size: number | null;
  mtime: string;
  sha256: string | null;
};
