# AWBS 开发学习文档

本文档面向想阅读 AWBS 源码、理解设计演进、fork 后继续改造的人。

AWBS 当前是一个 Node/TypeScript CLI 原型。开发时可以依赖 Node.js 24 直接运行 `.ts` 文件；npm 发布包必须先编译到 `dist/`，因为 Node 不支持在 `node_modules` 下直接 strip TypeScript。

## 1. 学习顺序

建议按这个顺序读：

```text
README.md
  -> docs/README.md
  -> docs/PRODUCT.md
  -> docs/FULL_CHAIN.md
  -> docs/reference/AWBS_CORE_DESIGN.md
  -> docs/tasks/TASK_001_VIEW_AUTHORITY.md
  -> docs/tasks/TASK_003_AUTHORITY_LEDGER_AND_DB_AUDIT.md
  -> docs/tasks/TASK_004_TRUSTED_AUTHORITY_LAYER.md
  -> docs/tasks/TASK_005_AUTHORITY_SESSION.md
  -> docs/tasks/TASK_006_TRUST_BOUNDARY_HARDENING.md
  -> docs/tasks/TASK_007_TRUSTED_OPERATION_ENTRY.md
  -> src/
  -> tests/
```

本机如果存在 `docs/archive/AWBS_USER_DISCUSSION_NOTES.md`，它是原始讨论记录，只作个人归档，不进入 Git 和 npm 包。

## 2. 架构分层

当前源码分四层：

```text
CLI Adapter
  src/cli.ts

Application Use Cases
  src/usecases/*

Domain Contracts
  src/domain/*

Ports / Infrastructure Adapters
  src/ports/*
  src/adapters/*
```

`src/runtime.ts` 负责组装默认运行时。

## 3. CLI 层

入口：

```text
src/cli.ts
```

职责：

- 解析命令行参数。
- 读取 stdin 中的 controller token / recovery secret。
- 创建 runtime。
- 调用 use case。
- 格式化输出。

CLI 不应该直接 import 具体 infrastructure adapter。这个约束由 `tests/architecture.test.ts` 覆盖。

## 4. Use Case 层

主要文件：

```text
src/usecases/init.ts
src/usecases/index.ts
src/usecases/view.ts
src/usecases/changeset.ts
src/usecases/authority.ts
src/usecases/session.ts
src/usecases/ledger.ts
src/usecases/db.ts
src/usecases/trusted-chain.ts
```

Use case 层负责业务流程编排。它不应该把密封算法、SQLite 细节、Git 命令细节写死在自己里面。

## 5. Domain 层

主要文件：

```text
src/domain/types.ts
src/domain/authority-types.ts
src/domain/session-types.ts
src/domain/paths.ts
src/domain/path-policy.ts
src/domain/session-proof.ts
src/domain/hash.ts
src/domain/constants.ts
src/domain/errors.ts
```

这里定义：

- manifest 类型。
- authority 类型。
- session 类型。
- path policy。
- controller proof。
- hash / canonical JSON。
- 常量和错误类型。

路径策略是安全边界的一部分。`.git`、`.awbs`、`.awbs-view.json` 不能作为业务数据路径。

## 6. Ports 层

主要接口：

```text
FileDatabasePort
GitPort
IndexStorePort
SummaryStorePort
AuthorityPort
AuthoritySessionPort
```

Ports 的作用是让 use case 依赖能力，而不是依赖具体实现。

## 7. Adapters 层

当前 adapters：

```text
GitCliAdapter
LocalFileDatabaseAdapter
SqliteIndexStoreAdapter
FileSummaryStoreAdapter
SealedAuthorityAdapter
LocalAuthoritySessionAdapter
SessionAuthorityClientAdapter
AutoAuthorityAdapter
```

重点：

- Git 操作统一走 `GitCliAdapter`。
- 文件扫描、copy、remove 统一走 `LocalFileDatabaseAdapter`。
- SQLite 索引走 `SqliteIndexStoreAdapter`。
- sealed authority 走 `SealedAuthorityAdapter`。
- session daemon 走 `LocalAuthoritySessionAdapter`。

## 8. Trusted Chain 机制

AWBS 认证数据库不等于 Git HEAD。

可信链由两部分表达：

```text
.awbs/authority/ledger.seal.json
refs/awbs/trusted
```

ledger entry 使用：

- `previousEntryHash`
- `entryHash`
- `operationHash`
- `parentTrustedCommit`
- `baseCommit`
- `appliedPaths`
- `appliedPathStates`
- `changesetPayloadHash`
- `authorityContractHash`

`ledger verify` 会重算 hash chain，也会验证 `refs/awbs/trusted` 指向的 commit 是否真的匹配 ledger head entry：

- commit parent 必须等于 `parentTrustedCommit`。
- commit message 必须包含 ledger entry id、operation hash 和 parent trusted commit。
- commit diff 中的数据路径必须被 `appliedPaths` 声明。
- 当前 commit 中的最终文件内容必须匹配 `appliedPathStates` 记录的 sha256。

## 9. Authority Session 机制

session start：

- 读入 `.awbs/private/local.json`。
- 写出 `recovery.seal.json`。
- 启动 hidden detached daemon。
- 删除 `local.json`。

可信写入：

- CLI 从 stdin 读取 controller token。
- 生成 nonce HMAC controller proof。
- daemon 验证 proof。
- daemon 拒绝重复 nonce。
- daemon 执行语义 operation。
- daemon 签回 response proof。
- CLI 验证 response proof。

daemon 不提供 `sign(rawHash)`。

## 10. Changeset 机制

changeset collect 生成：

```text
.awbs/changesets/<changesetId>/
  manifest.json
  diff.patch
  files/
  receipt.seal.json
```

apply 前会验证：

- payload sha256。
- payloadHash。
- operationHash。
- sealed receipt。
- sealed view contract。
- current trusted commit。
- write path 权限。

任何验证失败都不能写入数据库。

## 11. 索引和摘要

索引：

```text
.awbs/index/files.sqlite
```

摘要：

```text
.awbs/summaries/files.jsonl
```

摘要边界是长期设计边界：

```text
AWBS 永远不内置 AI 摘要。
```

如果要接 AI 摘要，应由上层应用生成摘要，再调用 AWBS summary 接口写入。

## 12. 测试结构

当前测试：

```text
tests/architecture.test.ts
tests/cli.test.ts
tests/authority.test.ts
tests/trusted-chain.test.ts
tests/hardening.test.ts
tests/session.test.ts
```

覆盖：

- CLI 闭环。
- SQLite 索引。
- summary。
- view authority。
- changeset apply。
- trusted chain。
- trusted ref retarget 拒绝。
- forged trusted commit 拒绝。
- clean rebuild。
- session。
- 对抗路径。
- symlink 拒绝。
- payload 篡改。
- session endpoint 伪成功。

运行：

```powershell
npm test
```

测试使用串行执行，避免 Windows 上并发启动过多 authority session daemon。

## 13. 开发原则

AWBS 的核心开发原则：

- 输入开放，落地受控。
- 失败不能伪成功。
- 普通 HEAD 不等于认证数据库。
- workspace 可以混乱，trusted chain 不能混乱。
- 权限事实源不能在 workspace 明文里。
- summary 不是 AWBS 的 AI 能力。
- 不默认兼容开发期旧仓库，除非明确开 migration 任务。
- 不用一堆特例替代底层机制。

## 14. 发布流程

发布前：

```powershell
npm test
npm run build
node bin\awbs.js --help
node src\cli.ts --help
npm pack --dry-run
git diff --check
```

首次 npm 发布需要登录：

```powershell
npm adduser
npm publish --access public
```

当前公开包名是 `@c956180462/awbs`，全局命令仍然是 `awbs`。

## 15. 后续可做方向

可能的后续任务：

- workflow / run / step 记录。
- `applyVerifiedOperation` 更彻底的 Authority Service 化。
- B 模式：OS keychain / 独立系统账号 / 本地服务。
- npm release workflow。
- JSONL / SQLite 导出调试命令。
- 更正式的版本迁移策略。
