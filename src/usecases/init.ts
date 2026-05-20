import { join } from "node:path";
import { AWBS_DIR } from "../domain/constants.ts";
import type { AuthorityPort } from "../ports/authority.ts";
import type { FileDatabasePort } from "../ports/file-database.ts";
import type { GitPort } from "../ports/git.ts";

export type InitUseCases = {
  initProject(cwd: string): void;
};

export function createInitUseCases(deps: { files: FileDatabasePort; git: GitPort; authority: AuthorityPort }): InitUseCases {
  return {
    initProject(cwd: string): void {
      if (!deps.git.isRepository(cwd)) {
        deps.git.init(cwd);
      }

      deps.files.ensureDir(join(cwd, AWBS_DIR, "index"));
      deps.files.ensureDir(join(cwd, AWBS_DIR, "summaries"));
      deps.files.ensureDir(join(cwd, AWBS_DIR, "views"));
      deps.files.ensureDir(join(cwd, AWBS_DIR, "changesets"));
      deps.authority.ensureInitialized(cwd);

      const configPath = join(cwd, AWBS_DIR, "config.json");
      if (!deps.files.pathExists(configPath)) {
        deps.files.writeJson(configPath, {
          schemaVersion: 1,
          name: "awbs-project",
          createdAt: new Date().toISOString()
        });
      }

      const awbsGitignore = join(cwd, AWBS_DIR, ".gitignore");
      const ignored = ensureIgnoredLines(deps.files.pathExists(awbsGitignore) ? deps.files.readText(awbsGitignore) : "", ["index/", "views/", "changesets/", "private/"]);
      deps.files.writeText(awbsGitignore, ignored);
    }
  };
}

function ensureIgnoredLines(existing: string, required: string[]): string {
  const lines = existing.split(/\r?\n/).filter(Boolean);
  for (const line of required) {
    if (!lines.includes(line)) {
      lines.push(line);
    }
  }
  return `${lines.join("\n")}\n`;
}
