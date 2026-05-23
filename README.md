# AWBS

AWBS is short for **Agent Work Base Space**.

中文：AWBS 是一个面向 agent 工作流的文件系统数据库底座。它把标准文件系统当作数据库主体，把 Git 当作版本管理器，把某一步工作需要的文件复制成独立的工作空间视图，再通过 changeset 把允许的变更写回数据库。

English: AWBS is an agent-oriented file-system database foundation. It treats ordinary files as the database body, Git as the version manager, copy-based workspace views as the working surface, and changesets as the write-back format.

AWBS is intentionally **not** a sandbox system. Its core concern is workflow workspace management: what an agent can see for this step, what it is allowed to change, how those changes are collected, and how valid changes return to the Git-managed database.

AWBS 不是沙箱系统。它关心的是 agent 工作流的工作目录管理：这一步能看到什么、允许改什么、改完后如何收集变更、哪些变更可以写回 Git 管理的文件系统数据库。

## 文档入口

- [产品文档](./docs/PRODUCT.md)：AWBS 是什么、解决什么问题、不解决什么问题。
- [使用文档](./docs/USAGE.md)：从安装、初始化、创建 view 到 apply changeset 的操作手册。
- [全链路文档](./docs/FULL_CHAIN.md)：AWBS 从 init 到 trusted chain 推进的完整数据流。
- [开发学习文档](./docs/DEVELOPMENT_LEARNING.md)：源码分层、关键机制和学习顺序。
- [当前特性总览](./AWBS_CURRENT_FEATURES.md)：当前初版已经实现的能力清单。
- [核心设计文档](./AWBS_CORE_DESIGN.md)：设计思想、架构、可信事实层和长期边界。

## 当前效果

这个仓库现在已经是一个可运行的 v0/001/002/003/005/006/007 CLI 原型，已经打通了最小闭环：

```text
init
  -> authority session start
  -> ledger bootstrap
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
- 可以通过 `summary` 命令写入、读取、列出外部摘要；摘要永远由上层业务或外部工具生成。
- 可以创建 copy-based 工作空间视图，不重命名目录，只按原路径复制。
- 每个 view 都有唯一 UUID，并在 `.awbs/authority` 下生成密封契约。
- workspace 里的 `.awbs-view.json` 只作为展示/索引，不再作为权限事实源。
- collect/apply 会回查密封 authority contract，而不是信任 workspace 明文。
- 只读路径被修改时，changeset 会变成 invalid，apply 永远拒绝。
- view revoke 后，基于该 view 的新 collect/apply 会被拒绝。
- `awbs ledger bootstrap` 会创建 AWBS 可信数据链，并维护 `refs/awbs/trusted`。
- `ledger verify` 不只检查 ref 是否存在；它会校验 trusted commit 的父提交、提交消息、变更路径和 ledger 记录的最终路径 hash。
- `awbs authority session start` 会把本地 authority key 托管到同用户后台 session daemon，并删除磁盘 `local.json`。
- 可信写入命令必须由 host controller 通过 stdin 提供 `controllerToken`。
- `controllerToken` 不直接进入 session IPC；AWBS 使用带 nonce 的 HMAC controller proof，并要求可信写入成功响应带 response proof。
- session 异常退出后，可以用上层应用提供的 `recoverySecret` 显式恢复 `local.json`。
- `view create` 和 `index rebuild` 默认基于 AWBS trusted commit，不读取污染工作区。
- `changeset apply` 只接受基于当前 trusted commit 的 valid changeset；成功后推进 AWBS trusted chain。
- 外部 Git commit 可以存在，但不会自动进入 AWBS 认证数据库。
- `db audit` 可以报告当前 `HEAD`、工作树和 trusted chain 的偏离。
- `db clean-rebuild` 可以从 trusted commit 重建干净数据库目录，并把旧目录整体保留为 backup。
- 已经有 Node 内置测试覆盖架构、authority、changeset、SQLite 索引和 CLI 闭环。
- 当前仓库已经是 public GitHub repository，并带 MIT License。
- 当前 npm 包名是 `@c956180462/awbs`，全局命令仍然是 `awbs`。

摘要边界是硬边界：AWBS 永远不会内置 AI 摘要模型、API 配置、提示词或业务理解逻辑。AWBS 只保存和索引上层写入的摘要。

## 还没有做什么

- 还没有实现操作系统级只读属性、文件级 ACL 或强安全沙箱。
- 还没有实现跨机器 authority key 迁移。
- 还没有实现 workflow/run/step 的完整记录层。
- 还没有实现 backup purge；003 只保留 backup，不自动删除。
- 还没有实现 B 模式：独立 OS 用户、系统 keychain、系统服务形式的 AWBS Authority Service。

## 安装与运行

要求：

- Node.js `>=24.0.0`
- Git

从 npm 安装：

```powershell
npm install -g @c956180462/awbs
awbs --help
```

如果曾经安装过 `0.0.1`，请升级到 `0.0.2` 或更新版本。`0.0.1` 的包入口仍指向 `.ts` 源码，在全局安装后可能触发 Node.js 的 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`。`0.0.2+` 发布包会先编译到 `dist/`，全局命令加载的是 JavaScript。

`0.0.3+` 进一步加固 trusted chain：`refs/awbs/trusted` 指向的 commit 必须被 sealed ledger head entry 解释，不能只靠手动改 Git ref 进入 AWBS 认证数据库。

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

# recoverySecret / controllerToken 应由上层应用的非 AI 控制层注入。
'{"recoverySecret":"dev-recovery","controllerToken":"dev-controller"}' | awbs authority session start --control-stdin
'dev-controller' | awbs ledger bootstrap --control-token-stdin

awbs index rebuild
awbs index query

'dev-controller' | awbs view create --out ..\awbs-workspace --read A --write B --control-token-stdin
# 在 ..\awbs-workspace 里工作

awbs changeset collect --workspace ..\awbs-workspace
awbs changeset inspect <changesetId>
'dev-controller' | awbs changeset apply <changesetId> --control-token-stdin
'dev-controller' | awbs authority session stop --control-token-stdin
```

## CLI 命令

```text
awbs init
awbs index rebuild
awbs index query [term] [--status active|removed|all] [--json]
awbs summary set <path> (--text <summary> | --file <file>)
awbs summary get <path> [--json]
awbs summary list [--json]
awbs view create --out <workspace> [--read A] [--write B] --control-token-stdin
awbs view inspect <viewId> [--json]
awbs view revoke <viewId> --control-token-stdin
awbs changeset collect --workspace <workspace>
awbs changeset inspect <changesetDir|id> [--json]
awbs changeset apply <changesetDir|id> --control-token-stdin
awbs ledger bootstrap [--json] --control-token-stdin
awbs ledger inspect [--json]
awbs ledger verify [--json]
awbs db audit [--json]
awbs db clean-rebuild [--json]
awbs db backups list [--json]
awbs authority session start --control-stdin [--json]
awbs authority session status [--json]
awbs authority session stop --control-token-stdin [--json]
awbs authority session recover --recovery-secret-stdin [--json]
awbs authority verify [--json]
awbs authority repair-mirrors --control-token-stdin [--json]
```

## 设计文档

- [docs/PRODUCT.md](./docs/PRODUCT.md)：产品定位、适用场景和边界。
- [docs/USAGE.md](./docs/USAGE.md)：CLI 使用手册。
- [docs/FULL_CHAIN.md](./docs/FULL_CHAIN.md)：全链路运行机制。
- [docs/DEVELOPMENT_LEARNING.md](./docs/DEVELOPMENT_LEARNING.md)：开发学习路径和源码结构。
- [AWBS_CORE_DESIGN.md](./AWBS_CORE_DESIGN.md)：核心思想、当前能力、技术架构、索引设计和 npm 包状态。
- [AWBS_CURRENT_FEATURES.md](./AWBS_CURRENT_FEATURES.md)：当前系统已实现特性的集中总览。
- [TASK_001_VIEW_AUTHORITY.md](./TASK_001_VIEW_AUTHORITY.md)：视图鉴权器、密封契约、明文镜像和鉴权目录总账。
- [TASK_003_AUTHORITY_LEDGER_AND_DB_AUDIT.md](./TASK_003_AUTHORITY_LEDGER_AND_DB_AUDIT.md)：AWBS 可信数据链、数据库审计和可信重建设计。
- [TASK_004_TRUSTED_AUTHORITY_LAYER.md](./TASK_004_TRUSTED_AUTHORITY_LAYER.md)：可信事实层、hash-linked ledger、Authority Service 和 trust anchor 设计。
- [TASK_005_AUTHORITY_SESSION.md](./TASK_005_AUTHORITY_SESSION.md)：A 模式运行期本地钥匙托管、controller token 和恢复流程。
- [TASK_006_TRUST_BOUNDARY_HARDENING.md](./TASK_006_TRUST_BOUNDARY_HARDENING.md)：可信边界加固、路径策略和 changeset payload 校验。
- [TASK_007_TRUSTED_OPERATION_ENTRY.md](./TASK_007_TRUSTED_OPERATION_ENTRY.md)：可信操作入口与 verify / repair 拆分。

## Development Status

This repository is currently a runnable CLI prototype for AWBS v0/001/002/003/005/006/007.

It already supports:

- Git-backed AWBS project initialization.
- Persistent disk SQLite indexing with FTS5.
- External summary read/write commands.
- Copy-based workspace view creation.
- Sealed view authority contracts.
- View inspection and revocation.
- Changeset collection, inspection, and apply.
- Readonly-path violation detection.
- Stale base commit rejection.
- Read-only authority verification and controller-token-gated mirror repair.
- AWBS trusted chain bootstrap and verification.
- Trusted commit binding verification: parent commit, commit message, changed paths, and applied path hashes must match the sealed ledger head entry.
- Ephemeral local authority sessions for trusted writes.
- Controller-token-gated trusted write commands.
- Recovery-secret-based local key recovery after a crashed session.
- Trusted-commit-based view projection and index rebuild.
- Database audit for divergence from the AWBS trusted chain.
- Clean database rebuild from the trusted commit with backup preservation.
- Node test coverage for the main closed loop.
- Public npm package under `@c956180462/awbs`, with the global command name `awbs`.

Summary generation is deliberately outside AWBS. AWBS never ships a built-in AI summarizer, model configuration, API key flow, prompt layer, or business-specific content understanding. Upper-layer applications may generate summaries however they want and write them through AWBS summary commands.

It does not yet provide:

- OS-level readonly enforcement.
- File-level ACL.
- Strong sandbox isolation.
- Cross-machine authority key migration.
- Full workflow/run/step history.
- Backup purge.
- OS-level B mode with an independent OS user, OS keychain, or standalone AWBS Authority Service.

## English Quick Start

Requirements:

- Node.js `>=24.0.0`
- Git

Install from npm:

```powershell
npm install -g @c956180462/awbs
awbs --help
```

If you installed `0.0.1`, upgrade to `0.0.2` or later. Version `0.0.1` pointed the package bin at TypeScript source, which can fail under `node_modules` with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. Starting from `0.0.2+`, the npm package runs compiled JavaScript from `dist/`.

Starting from `0.0.3+`, the trusted chain also binds `refs/awbs/trusted` to the sealed ledger head entry by checking commit parent, commit message, changed paths, and applied path hashes.

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

'{"recoverySecret":"dev-recovery","controllerToken":"dev-controller"}' | awbs authority session start --control-stdin
'dev-controller' | awbs ledger bootstrap --control-token-stdin

awbs index rebuild
awbs index query

'dev-controller' | awbs view create --out ..\awbs-workspace --read A --write B --control-token-stdin
# Work inside ..\awbs-workspace

awbs changeset collect --workspace ..\awbs-workspace
awbs changeset inspect <changesetId>
'dev-controller' | awbs changeset apply <changesetId> --control-token-stdin
'dev-controller' | awbs authority session stop --control-token-stdin
```

## Maintenance And Contributions

中文：这个仓库是公开的个人研究型开源项目，更新节奏随缘。你可以阅读、fork、改造和自用；issue 或 pull request 可以提，但不保证处理，也不承诺接受外部代码合入。本仓库不会开放外部直接提交权限。

English: This is a public personal research project with irregular maintenance. You are welcome to read, fork, modify, and use it for your own work. Issues and pull requests may be opened, but there is no guarantee of review, merge, or ongoing support. External direct commit access is not granted.

## Development

```powershell
npm run build
node bin\awbs.js --help
npm test
npm pack --dry-run
```

## License

MIT
