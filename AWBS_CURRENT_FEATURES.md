# AWBS 当前系统特性总览

本文档记录 AWBS 当前已经具备的系统能力。它描述的是当前代码已经实现并由测试覆盖的能力，不把未来设想当成已完成特性。

当前版本可以理解为：

```text
v0/001/002/003/005/006/007 CLI prototype
```

AWBS 当前不是沙箱系统，也不是传统 SQL 数据库。它是一个基于标准文件系统、Git、SQLite 索引、工作空间视图、changeset 和可信事实层的 agent 工作流文件系统数据库底座。

## 1. 系统定位

AWBS 当前提供的是一套面向 agent 工作流的文件系统数据库能力：

- 用普通目录和文件保存业务事实。
- 用 Git 保存版本历史、文件差异和提交记录。
- 用 SQLite + FTS5 保存可重建索引。
- 用 copy-based workspace view 给 agent 提供独立工作目录。
- 用 changeset 表达一次工作对数据库提出的变更。
- 用 sealed authority contract 记录 view 的权限事实。
- 用 trusted chain 决定 AWBS 承认哪一个 Git tree 是认证数据库。
- 用 authority session 在运行期托管本地 key，并要求可信写入由 host controller 授权。

AWBS 不负责规定业务目录如何设计。业务文件怎么组织、产物写在哪里、摘要怎么生成，都由上层应用决定。

## 2. 初始化与项目结构

当前 `awbs init` 已实现：

- 如果当前目录不是 Git repo，自动执行 `git init`。
- 创建 `.awbs/` 基础结构。
- 创建 `.awbs/config.json`。
- 初始化 authority 材料。
- 创建 `.awbs/.gitignore`，忽略可重建或私有运行材料。

典型 `.awbs/` 结构：

```text
.awbs/
  authority/
    repo.json
    catalog.seal.json
    catalog.mirror.json
    ledger.seal.json
    ledger.mirror.json
    view-events.jsonl
    ledger-events.jsonl
    views/<viewId>/
      contract.seal.json
      mirror.json
      receipt.json
  changesets/
  index/
    files.sqlite
  private/
    local.json
    session.json
    recovery.seal.json
  summaries/
    files.jsonl
  views/
  config.json
```

其中：

- `.awbs/authority/` 保存 AWBS 可信事实层材料。
- `.awbs/private/` 保存本机私有材料，继续被 Git 忽略。
- `.awbs/index/` 是可重建索引。
- `.awbs/views/` 和 `.awbs/changesets/` 是运行材料。
- `.awbs/summaries/files.jsonl` 是上层业务可写的摘要事实文件。

## 3. 磁盘 SQLite 索引

当前索引层已经从 JSONL 默认持久层升级为磁盘 SQLite：

```text
.awbs/index/files.sqlite
```

已实现能力：

- `awbs index rebuild` 从当前 AWBS trusted commit 对应的 Git tree 重建索引。
- `awbs index query` 查询持久 SQLite，不把全量 JSONL 加载进内存。
- 使用 FTS5 查询 path 和 summary。
- 没有搜索词时按 status 查询。
- 搜索特殊字符时保留 LIKE fallback，避免 FTS 查询失败导致命令崩溃。
- 文件删除后，旧索引记录保留为 `removed`。

索引条目保留原有 `IndexEntry` 结构，主要包含：

```json
{
  "path": "B/draft.md",
  "kind": "file",
  "sha256": "...",
  "size": 123,
  "mtime": "2026-05-22T00:00:00.000Z",
  "commit": "git commit",
  "status": "active",
  "summary": "external or fallback summary",
  "summarySource": "external | path-level | fallback",
  "json": {}
}
```

索引不是事实源，可以删除和重建。

## 4. 摘要接口

AWBS 当前提供摘要读写接口：

```text
awbs summary set <path> (--text <summary> | --file <file>)
awbs summary get <path> [--json]
awbs summary list [--json]
```

已实现能力：

- 摘要写入 `.awbs/summaries/files.jsonl`。
- `index rebuild` 会优先使用外部摘要。
- 摘要可以被 FTS5 查询命中。

硬边界：

- AWBS 永远不内置 AI 摘要模型。
- AWBS 不保存 AI API key。
- AWBS 不配置摘要模型、提示词或 provider。
- 摘要由上层业务、外部工具或人类生成后写入。

## 5. 工作空间视图

当前 view 采用 copy-based materialization：

```text
awbs view create --out <workspace> [--read A] [--write B] --control-token-stdin
```

已实现能力：

- 从 AWBS trusted commit 对应的 Git tree 复制文件，不读取污染工作区。
- 保持原目录结构，不做路径重命名。
- 每个 view 有唯一 UUID。
- 创建 workspace 的 `.awbs-view.json`。
- 保存 baseline 到 `.awbs/views/<viewId>/baseline/`。
- 在 `.awbs/authority/views/<viewId>/contract.seal.json` 中写入 sealed view contract。
- `view inspect` 可以查看 view 契约和状态。
- `view revoke` 可以撤销 view。

view contract 主要包含：

```json
{
  "schemaVersion": 1,
  "viewId": "uuid",
  "baseCommit": "trusted commit",
  "createdAt": "iso time",
  "readPaths": ["A"],
  "writePaths": ["B"],
  "sources": [],
  "ext": {
    "workspacePath": "..."
  }
}
```

权限事实源不是 workspace 里的 `.awbs-view.json`，而是 sealed authority contract。

## 6. Changeset 变更包

当前 changeset 能表达工作空间和 baseline 之间的文件变化：

```text
awbs changeset collect --workspace <workspace>
awbs changeset inspect <changesetDir|id> [--json]
awbs changeset apply <changesetDir|id> --control-token-stdin
```

已实现能力：

- 比较 `.awbs/views/<viewId>/baseline/` 和 workspace 当前内容。
- 生成 `.awbs/changesets/<changesetId>/`。
- 写入 `manifest.json`。
- 写入 `diff.patch`。
- 对新增/修改文件保存 payload 到 `files/`。
- 标记 add / modify / delete。
- 根据 sealed contract 的 `writePaths` 判断是否允许写入。
- 修改只读路径时，changeset 仍生成，但 status 为 `invalid`。
- invalid changeset 永远不能 apply。
- stale view 不能 apply。
- v0 当前只支持 `same-path` 写回语义。

changeset manifest 主要包含：

```json
{
  "schemaVersion": 1,
  "changesetId": "uuid",
  "viewId": "uuid",
  "baseCommit": "trusted commit",
  "projectRoot": "...",
  "workspacePath": "...",
  "status": "valid",
  "readPaths": ["A"],
  "writePaths": ["B"],
  "changes": [],
  "violations": [],
  "summary": {
    "added": 0,
    "modified": 1,
    "deleted": 0,
    "violations": 0
  }
}
```

## 7. View Authority

001 已实现 view authority：

- `.awbs/authority/repo.json` 保存公开仓库 authority 参数。
- `.awbs/authority/catalog.seal.json` 是 sealed 鉴权目录总账。
- `.awbs/authority/catalog.mirror.json` 是给人看的明文镜像，可自动重建。
- 每个 view 有 sealed contract。
- 每个 view 有 mirror 和 receipt。
- view 只允许创建和撤销，不提供普通修改。
- mirror 被改后可以从 seal 修复。
- sealed contract 被改后会导致解封失败，collect/apply 拒绝。
- revoked view 的新 collect/apply 会拒绝。

已实现命令：

```text
awbs view inspect <viewId> [--json]
awbs view revoke <viewId> --control-token-stdin
awbs authority verify [--json]
awbs authority repair-mirrors [--json]
```

## 8. Trusted Chain 可信数据链

003 已实现 AWBS trusted chain：

- AWBS 认证数据库不是普通 Git `HEAD`。
- AWBS 认证数据库也不是当前工作区文件。
- AWBS 认证数据库等于 `refs/awbs/trusted` 指向的 Git tree。
- sealed ledger 记录 AWBS 承认的可信状态推进。

已实现材料：

```text
.awbs/authority/ledger.seal.json
.awbs/authority/ledger.mirror.json
.awbs/authority/ledger-events.jsonl
refs/awbs/trusted
```

已实现命令：

```text
awbs ledger bootstrap --control-token-stdin
awbs ledger inspect [--json]
awbs ledger verify [--json]
```

可信链规则：

```text
trustedCommit(Tn)
  -> view projection 基于 Tn
  -> changeset 声明基于 Tn
  -> apply 只接受基于 Tn 的 valid changeset
  -> 生成 trustedCommit(Tn+1)
```

外部 Git commit 可以存在，但不会自动进入 AWBS 认证数据库。

## 9. 数据库审计与可信重建

003 已实现：

```text
awbs db audit [--json]
awbs db clean-rebuild [--json]
awbs db backups list [--json]
```

`db audit` 能报告：

- 当前 Git `HEAD`。
- 当前 `refs/awbs/trusted`。
- HEAD 是否等于 trusted commit。
- HEAD 是否在 trusted chain 之上。
- 工作区是否 dirty。
- 是否存在外部 commit。
- authority/ledger 是否可验证。

`db clean-rebuild` 能：

- 从当前 trusted commit 克隆/检出干净数据库。
- 复制 `.awbs/private/` 私有材料。
- 把原数据库目录整体改名为 backup。
- 让干净目录接管原路径。
- 默认保留 backup，不自动删除。

如果 session 正在运行，当前实现要求先停止 session，再执行 clean rebuild。

## 10. A 模式 Authority Session

005 已实现 A 模式：

```text
awbs authority session start --control-stdin
awbs authority session status [--json]
awbs authority session stop --control-token-stdin
awbs authority session recover --recovery-secret-stdin
```

`start --control-stdin` 读取：

```json
{
  "recoverySecret": "...",
  "controllerToken": "..."
}
```

已实现行为：

- session start 读取 `.awbs/private/local.json`。
- 使用 recoverySecret 写入 `.awbs/private/recovery.seal.json`。
- 启动同用户后台 session daemon。
- 删除磁盘 `local.json`。
- session active 时 key 只存在于 daemon 内存中。
- `session.json` 只保存 pid、socketPath、repoId、startedAt、status，不保存 key/token/secret。
- 可信写入必须由 host controller 提供 `controllerToken`。
- controller token 不直接进入 session IPC；CLI 发送带 nonce 的 HMAC controller proof。
- session daemon 会拒绝重复 nonce，防止 controller proof 被重放。
- 可信写入的成功响应必须带 response proof，CLI 会拒绝未签回的伪成功响应。
- session daemon 只服务启动仓库及其同一 Git common dir 下的临时 worktree。
- session stop 写回 `local.json`，删除 recovery/session 状态。
- session 崩溃后，可以用 recoverySecret 显式 recover。
- 错误 recoverySecret 不能恢复。

需要 controller token 的可信写入：

```text
ledger bootstrap
view create
view revoke
changeset apply
```

当前 A 模式不实现：

- 独立 OS 用户。
- Windows DPAPI / Credential Manager。
- Linux keyring / Secret Service。
- 系统服务形式的 `awbsd`。
- remote signer。
- admin/root 防护。

## 11. CLI 与 npm 包形态

当前 AWBS 是 Node/TypeScript CLI 原型。

运行要求：

```text
Node.js >= 24.0.0
Git
```

`package.json` 声明：

```text
bin:
  awbs -> ./src/cli.ts
```

本地可运行：

```text
node src/cli.ts --help
npm run awbs -- --help
npm install -g .
awbs --help
```

当前 `npm pack --dry-run` 已能把运行源码和核心设计文档打入包。

## 12. 架构分层

当前代码保持四层结构：

```text
CLI Adapter
  解析命令、读取 stdin、格式化输出。

Application Use Cases
  编排 init / index / view / changeset / ledger / db / session。

Domain Contracts
  定义 manifest、authority、session、index、错误和路径规则。

Infrastructure Adapters
  Git CLI、文件系统、SQLite、sealed authority、session daemon。
```

当前关键端口：

- `GitPort`
- `FileDatabasePort`
- `IndexStorePort`
- `SummaryStorePort`
- `AuthorityPort`
- `AuthoritySessionPort`

## 13. 当前测试覆盖

当前 Node 内置测试覆盖：

- runtime 和 CLI 架构依赖方向。
- init / index / summary / view / changeset 的闭环。
- read-only violation。
- stale view 拒绝。
- SQLite 持久索引、FTS、removed 记录迁移。
- authority seal / mirror / revoke。
- trusted chain 和外部 commit 排除。
- clean rebuild。
- authority session start / stop。
- controller token 拒绝。
- session 崩溃恢复。

当前验证命令：

```text
npm test
node src\cli.ts --help
npm pack --dry-run
git diff --check
```

## 14. 明确未实现

当前系统尚未实现：

- 操作系统只读属性。
- 文件级 ACL。
- 强安全沙箱。
- 独立 OS 用户运行的 B 模式 Authority Service。
- OS keychain / DPAPI / Secret Service。
- remote signer。
- 跨机器 authority key 迁移。
- workflow / run / step 完整记录层。
- backup purge。
- 自定义业务 adapter。
- AI 摘要生成。

这些未实现项不是隐藏能力，也不应在上层宣传为已完成特性。
