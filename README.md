# AWBS

AWBS is short for Agent Work Base Space. It is a CLI prototype for an agent-oriented file-system database: files are the database body, Git is the version manager, workspace views are copied out for agent work, and changes are written back through changesets.

The project is intentionally not a sandbox system. Its core concern is workflow workspace management: selecting project files into a temporary working directory, recording which view was created, collecting the resulting file changes, and applying allowed changes back to the Git-managed database.

## Current Capabilities

- Initialize an AWBS database in a Git repository.
- Build and query a persistent disk SQLite index with FTS5.
- Store external file summaries through a CLI summary interface.
- Create copy-based workspace views with read/write path declarations.
- Seal view authority contracts under `.awbs/authority`.
- Collect workspace changes into changesets.
- Inspect and apply valid same-path changesets.
- Reject stale changesets, revoked views, dirty database worktrees, and readonly-path modifications.

## Requirements

- Node.js `>=24.0.0`
- Git

AWBS currently uses Node's built-in `node:sqlite`, so it does not add a third-party SQLite dependency.

## Install

From a local checkout:

```powershell
npm install -g .
awbs --help
```

You can also run it directly while developing:

```powershell
npm run awbs -- --help
node src\cli.ts --help
```

## Basic Flow

```powershell
awbs init
git add .
git commit -m "initialize database"

awbs index rebuild
awbs index query

awbs view create --out ..\awbs-workspace --read A --write B
# Work inside ..\awbs-workspace

awbs changeset collect --workspace ..\awbs-workspace
awbs changeset inspect <changesetId>
awbs changeset apply <changesetId> --adapter same-path
```

## Commands

```text
awbs init
awbs index rebuild
awbs index query [term] [--status active|removed|all] [--json]
awbs summary set <path> (--text <summary> | --file <file>)
awbs summary get <path> [--json]
awbs summary list [--json]
awbs view create --out <workspace> [--read A] [--write B]
awbs view inspect <viewId> [--json]
awbs view revoke <viewId>
awbs changeset collect --workspace <workspace>
awbs changeset inspect <changesetDir|id> [--json]
awbs changeset apply <changesetDir|id> --adapter same-path
awbs authority verify [--json]
awbs authority repair-mirrors [--json]
```

## Design Notes

The main design document is [AWBS_CORE_DESIGN.md](./AWBS_CORE_DESIGN.md).

The view authority design is documented in [TASK_001_VIEW_AUTHORITY.md](./TASK_001_VIEW_AUTHORITY.md).

## Development

```powershell
npm test
npm pack --dry-run
```

## License

MIT
