import { FileSummaryStoreAdapter } from "./adapters/file-summary-store.ts";
import { GitCliAdapter } from "./adapters/git-cli.ts";
import { LocalFileDatabaseAdapter } from "./adapters/local-file-database.ts";
import { SealedAuthorityAdapter } from "./adapters/sealed-authority.ts";
import { SqliteIndexStoreAdapter } from "./adapters/sqlite-index-store.ts";
import { createAuthorityUseCases, type AuthorityUseCases } from "./usecases/authority.ts";
import { createChangesetUseCases, type ChangesetUseCases } from "./usecases/changeset.ts";
import { createIndexUseCases, type IndexUseCases } from "./usecases/index.ts";
import { createInitUseCases, type InitUseCases } from "./usecases/init.ts";
import { createViewUseCases, type ViewUseCases } from "./usecases/view.ts";

export type AwbsRuntime = {
  usecases: {
    init: InitUseCases;
    index: IndexUseCases;
    view: ViewUseCases;
    changeset: ChangesetUseCases;
    authority: AuthorityUseCases;
  };
};

export function createDefaultRuntime(): AwbsRuntime {
  const files = new LocalFileDatabaseAdapter();
  const git = new GitCliAdapter();
  const index = new SqliteIndexStoreAdapter(files);
  const summaries = new FileSummaryStoreAdapter(files);
  const authority = new SealedAuthorityAdapter(files);

  return {
    usecases: {
      init: createInitUseCases({ files, git, authority }),
      index: createIndexUseCases({ files, git, index, summaries }),
      view: createViewUseCases({ files, git, authority }),
      changeset: createChangesetUseCases({ files, git, authority }),
      authority: createAuthorityUseCases({ files, authority })
    }
  };
}
