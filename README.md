# AWBS

AWBS is short for **Agent Work Base Space**.

中文：AWBS 是一个面向 agent 工作流的文件系统数据库底座。它把标准文件系统当作数据库主体，把 Git 当作版本管理器，把某一步工作需要的文件复制成独立的工作空间视图，再通过 changeset 把允许的变更写回数据库。

English: AWBS is an agent-oriented file-system database foundation. It treats ordinary files as the database body, Git as the version manager, copy-based workspace views as the working surface, and changesets as the write-back format.

AWBS is intentionally **not** a sandbox system. Its core concern is workflow workspace management: what an agent can see for this step, what it is allowed to change, how those changes are collected, and how valid changes return to the Git-managed database.

AWBS 不是沙箱系统。它关心的是 agent 工作流的工作目录管理：这一步能看到什么、允许改什么、改完后如何收集变更、哪些变更可以写回 Git 管理的文件系统数据库。

## 当前效果

这个仓库现在已经是一个可运行的 v0/001/002 CLI 原型，已经打通了最小闭环：

```text
init
  -> index rebuild/query
  -> summary set/get/list
  -> view create/inspect/revoke
  -> workspace 工作
  -> changeset collect/inspect/apply
  -> Git commit
```

当前已经具备这些能力：

- 可以在一个目录中初始化 AWBS 数据库；如果不是 Git repo，会自动 `git init`。
- 可以使用磁盘 SQLite + FTS5 建立持久索引：默认写入 `.awbs/index/files.sqlite`。
- 可以查询文件路径、摘要和 active/removed 状态。
- 可以通过 `summary` 命令写入、读取、列出外部摘要；AWBS 不内置 AI 摘要模型。
- 可以创建 copy-based 工作空间视图，不重命名目录，只按原路径复制。
- 每个 view 都有唯一 UUID，并在 `.awbs/authority` 下生成密封契约。
- workspace 里的 `.awbs-view.json` 只作为展示/索引，不再作为权限事实源。
- collect/apply 会回查密封 authority contract，而不是信任 workspace 明文。
- 只读路径被修改时，changeset 会变成 invalid，apply 永远拒绝。
- view revoke 后，基于该 view 的新 collect/apply 会被拒绝。
- apply 时要求当前 Git `HEAD` 等于 changeset 的 `baseCommit`，体现单线生长原则。
- v0 只实现 `same-path` adapter：可写路径变化写回数据库同名路径。
- 已经有 Node 内置测试覆盖架构、authority、changeset、SQLite 索引和 CLI 闭环。
- 当前仓库已经是 public GitHub repository，并带 MIT License。

## 还没有做什么

- 还没有发布到 npm registry；目前可以从本地 checkout 全局安装。
- 还没有实现真实 AI 摘要 provider；摘要由上层业务或外部 agent 写入。
- 还没有实现复杂业务 adapter；目前只有 `same-path`。
- 还没有实现操作系统级只读属性、文件级 ACL 或强安全沙箱。
- 还没有实现跨机器 authority key 迁移。
- 还没有实现 workflow/run/step 的完整记录层。

## 安装与运行

要求：

- Node.js `>=24.0.0`
- Git

从本地仓库全局安装：

```powershell
npm install -g .
awbs --help
```

开发时也可以直接运行：

```powershell
npm run awbs -- --help
node src\cli.ts --help
```

## 基本使用流程

```powershell
awbs init
git add .
git commit -m "initialize database"

awbs index rebuild
awbs index query

awbs view create --out ..\awbs-workspace --read A --write B
# 在 ..\awbs-workspace 里工作

awbs changeset collect --workspace ..\awbs-workspace
awbs changeset inspect <changesetId>
awbs changeset apply <changesetId> --adapter same-path
```

## CLI 命令

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

## 设计文档

- [AWBS_CORE_DESIGN.md](./AWBS_CORE_DESIGN.md)：核心思想、当前能力、技术架构、索引设计和 npm 包状态。
- [TASK_001_VIEW_AUTHORITY.md](./TASK_001_VIEW_AUTHORITY.md)：视图鉴权器、密封契约、明文镜像和鉴权目录总账。

## Development Status

This repository is currently a runnable CLI prototype for AWBS v0/001/002.

It already supports:

- Git-backed AWBS project initialization.
- Persistent disk SQLite indexing with FTS5.
- External summary read/write commands.
- Copy-based workspace view creation.
- Sealed view authority contracts.
- View inspection and revocation.
- Changeset collection, inspection, and same-path apply.
- Readonly-path violation detection.
- Stale base commit rejection.
- Authority verification and mirror repair.
- Node test coverage for the main closed loop.

It does not yet provide:

- npm registry publishing.
- Built-in AI summary generation.
- Custom business changeset adapters.
- OS-level readonly enforcement.
- File-level ACL.
- Strong sandbox isolation.
- Cross-machine authority key migration.
- Full workflow/run/step history.

## English Quick Start

Requirements:

- Node.js `>=24.0.0`
- Git

Install from a local checkout:

```powershell
npm install -g .
awbs --help
```

Basic flow:

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

## Development

```powershell
npm test
npm pack --dry-run
```

## License

MIT
