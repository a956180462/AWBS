export type GitCommandResult = {
  stdout: string;
  stderr: string;
  status: number | null;
};

export interface GitPort {
  isRepository(root: string): boolean;
  init(root: string): void;
  headCommit(root: string): string | null;
  requireHeadCommit(root: string): string;
  refCommit(root: string, ref: string): string | null;
  updateRef(root: string, ref: string, commit: string): void;
  isAncestor(root: string, ancestor: string, descendant: string): boolean;
  revList(root: string, range: string): string[];
  statusPorcelain(root: string): string;
  addAll(root: string, paths: string[]): void;
  commit(root: string, message: string): void;
  createDetachedWorktree(root: string, path: string, commit: string): void;
  removeWorktree(root: string, path: string): void;
  cloneAtCommit(sourceRoot: string, destination: string, commit: string): void;
  diffNoIndex(baselineRoot: string, workspacePath: string): string;
}
