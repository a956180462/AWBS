import { FileSummaryStoreAdapter } from "./adapters/file-summary-store.ts";
import { GitCliAdapter } from "./adapters/git-cli.ts";
import { LocalFileDatabaseAdapter } from "./adapters/local-file-database.ts";
import { LocalAuthoritySessionAdapter } from "./adapters/local-authority-session.ts";
import { SealedAuthorityAdapter } from "./adapters/sealed-authority.ts";
import { AutoAuthorityAdapter, SessionAuthorityClientAdapter } from "./adapters/session-authority-client.ts";
import { SqliteIndexStoreAdapter } from "./adapters/sqlite-index-store.ts";
import { createAuthorityUseCases, type AuthorityUseCases } from "./usecases/authority.ts";
import { createChangesetUseCases, type ChangesetUseCases } from "./usecases/changeset.ts";
import { createDbUseCases, type DbUseCases } from "./usecases/db.ts";
import { createIndexUseCases, type IndexUseCases } from "./usecases/index.ts";
import { createInitUseCases, type InitUseCases } from "./usecases/init.ts";
import { createLedgerUseCases, type LedgerUseCases } from "./usecases/ledger.ts";
import { createAuthoritySessionUseCases, type AuthoritySessionUseCases } from "./usecases/session.ts";
import { createViewUseCases, type ViewUseCases } from "./usecases/view.ts";

export type AwbsRuntime = {
  usecases: {
    init: InitUseCases;
    index: IndexUseCases;
    view: ViewUseCases;
    changeset: ChangesetUseCases;
    authority: AuthorityUseCases;
    session: AuthoritySessionUseCases;
    ledger: LedgerUseCases;
    db: DbUseCases;
  };
};

export function createDefaultRuntime(options: { authorityMode?: "local" | "auto" | "session"; controllerToken?: string; cliPath?: string } = {}): AwbsRuntime {
  const files = new LocalFileDatabaseAdapter();
  const git = new GitCliAdapter();
  const index = new SqliteIndexStoreAdapter(files);
  const summaries = new FileSummaryStoreAdapter(files);
  const cliPath = options.cliPath ?? process.argv[1];
  const authority =
    options.authorityMode === "session"
      ? new SessionAuthorityClientAdapter(cliPath, { controllerToken: options.controllerToken })
      : options.authorityMode === "auto"
        ? new AutoAuthorityAdapter(files, cliPath)
        : new SealedAuthorityAdapter(files);
  const session = new LocalAuthoritySessionAdapter(files, cliPath);

  return {
    usecases: {
      init: createInitUseCases({ files, git, authority }),
      index: createIndexUseCases({ files, git, index, summaries }),
      view: createViewUseCases({ files, git, authority }),
      changeset: createChangesetUseCases({ files, git, authority }),
      authority: createAuthorityUseCases({ files, authority }),
      session: createAuthoritySessionUseCases({ session }),
      ledger: createLedgerUseCases({ files, git, authority }),
      db: createDbUseCases({ files, git, authority })
    }
  };
}
