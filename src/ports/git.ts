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
  statusPorcelain(root: string): string;
  addAll(root: string, paths: string[]): void;
  commit(root: string, message: string): void;
  diffNoIndex(baselineRoot: string, workspacePath: string): string;
}
