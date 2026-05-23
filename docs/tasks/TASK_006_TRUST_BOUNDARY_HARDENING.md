# AWBS 006：可信边界加固问题记录

## Summary

006 记录可信事实层实现暴露出的边界问题，并完成第一轮实现修复。

这些问题的核心不是“沙箱逃逸”，也不是操作系统权限问题，而是 AWBS 自己的数据库可信链还没有完全收束成少数硬机制：

```text
AWBS 认证数据库
  != 当前工作区
  != 普通 Git HEAD
  != agent 可写文件系统

AWBS 认证数据库
  = trusted chain 当前链头对应的 Git tree
  + authority 认可的 changeset / operation 记录
```

本任务的目标是把所有可能绕开可信链、污染 authority、破坏 Git 仓库、篡改 changeset payload、误导索引和摘要的路径记录下来，并用统一机制修掉第一批高风险问题。

## Development Compatibility Policy

AWBS 当前没有投产仓库，因此默认不考虑旧仓库兼容。

后续所有任务遵循这条规则：

```text
除非任务明确要求兼容旧仓库，否则 AWBS 永远不默认考虑旧仓库兼容。
```

这意味着：

- 可以直接修改数据结构。
- 可以直接废弃旧 manifest / authority / ledger 形态。
- 可以要求重新 init / bootstrap / create view。
- 不因为“已有开发期仓库”牺牲新可信链设计。
- 不把兼容迁移逻辑混进普通运行路径。

如果未来真的需要兼容旧仓库，必须单独开 migration 任务，明确迁移源版本、目标版本、校验方式和失败处理。

## Review Findings

### P0：workspace 可泄露 `.awbs/private`

`view create` 只拦截直接传入 `.awbs/private` 的情况，但如果传入：

```text
--read .awbs
--read .
```

就可能绕过直接检查。可信投影过程中如果把 `.awbs/private` 复制进 workspace，agent 就可能看到：

```text
.awbs/private/recovery.seal.json
.awbs/private/session.json
```

这直接违反 005 的边界：

```text
agent 生命周期内不应从 repo 文件系统读到 authority key / secret 材料。
```

涉及位置：

- `src/usecases/view.ts`
- `src/usecases/trusted-chain.ts`

修复方向：

- 建立统一 path policy。
- 默认拒绝投影 `.git`、`.awbs/private`、`.awbs/index`、`.awbs/views`、`.awbs/changesets`、`.awbs/tmp` 等系统目录。
- 对 `.`、父目录、包含系统目录的上级路径进行展开检查，而不是只做字符串直等判断。
- workspace 中永远不出现 AWBS private 材料。

### P0：`.git` 可以被声明为可写路径并被删除

如果允许：

```text
awbs view create --write .git
```

那么 agent 可以在 workspace 中删除 `.git`，之后 `changeset apply` 可能把删除传播回数据库目录。

这属于最严重的失败类型：

```text
命令最终失败，但副作用已经破坏仓库。
```

涉及位置：

- `src/usecases/view.ts`
- `src/usecases/changeset.ts`
- `src/adapters/local-file-database.ts`

修复方向：

- `.git` 永远是 AWBS 系统保留路径，不能 read、write、view、changeset、apply。
- apply 前必须先完成所有路径合法性验证。
- 任何写入数据库根目录的动作，都必须经过统一 path policy。
- 禁止在没有完整预检通过前执行 `rmSync` / overwrite / copy。

### P0：changeset payload 没有不可变校验

当前 `changeset collect` 生成：

```text
manifest.json
diff.patch
files/
```

但 `apply` 时主要信任磁盘上的 payload，不重新校验 `record.sha256`，`operationHash` 也没有覆盖 payload 内容。

风险是：

```text
collect 后替换 .awbs/changesets/<id>/files/... 的内容，
apply 仍可能提交被替换后的内容。
```

这会让 changeset 从“可信最小变更单元”退化成“可被本地磁盘篡改的临时包”。

涉及位置：

- `src/usecases/changeset.ts`

修复方向：

- collect 时为每个 payload 文件记录 sha256。
- apply 前重新计算所有 payload 文件 sha256。
- operationHash 必须覆盖 manifest 关键字段和 payload hash。
- changeset seal / receipt 应当把 payload hash 纳入不可变契约。
- 任何 payload 校验失败都必须拒绝 apply，不能降级。

### P1：Authority Service 抽象太低层

当前 session daemon 暴露的能力偏底层，例如：

```text
appendLedgerEntry
createViewContract
```

这更像是“远程 sealed 文件写入器”，而不是 004 设计中的 Authority Service。

004 的核心要求是：

```text
Authority Service 不能签任意 hash。
Authority Service 不能只提供底层写入原语。
Authority Service 应该只提供 applyVerifiedOperation 这类语义接口。
```

也就是说，Authority Service 应当自己重新计算、验证、应用 operation，而不是让外层 CLI 把已经算好的结果交给它写入。

涉及位置：

- `src/adapters/local-authority-session.ts`
- `src/adapters/session-authority-client.ts`
- `TASK_004_TRUSTED_AUTHORITY_LAYER.md`

修复方向：

- 提升 AuthorityPort 语义层级。
- 收敛为 `applyVerifiedOperation` / `createVerifiedView` / `revokeVerifiedView` 等语义操作。
- daemon 内部重新计算 operationHash。
- daemon 内部验证 trusted head、view contract、changeset payload、path policy。
- controller token 只能授权语义操作，不能授权任意底层写入。

### P1：ledger verify 还不足以称为可信链验证（已修复）

当前 ledger verify 更接近：

```text
从 trusted commit 读取 sealed ledger
确认 head entry 存在
确认 ref 大体对应
```

但完整可信链需要验证：

```text
previousEntryHash
entryHash
operationHash
parentTrustedCommit
currentTrustedCommit
refs/awbs/trusted
```

如果没有 hash-linked ledger，AWBS 还不能严肃地说“整条链可验证”。当前实现已经把这一项推进到更硬的验证：不仅重算 ledger hash chain，还会把 `refs/awbs/trusted` 指向的 commit 和 ledger head entry 绑定校验。

涉及位置：

- `src/usecases/ledger.ts`
- `src/domain/authority-types.ts`
- `TASK_004_TRUSTED_AUTHORITY_LAYER.md`

修复方向：

- ledger entry 增加 `previousEntryHash`、`entryHash`。
- entryHash 覆盖 entry 的规范化 JSON。
- operationHash 覆盖 operation 输入、changeset payload hash、path list、base commit。
- verify 从 genesis 一路重算到 current trusted entry。
- verify 同时校验 `refs/awbs/trusted` 指向的 commit 与 ledger head 一致。
- verify 校验 trusted commit parent、commit message、diff path 和 `appliedPathStates` 内容 hash。

### P1：session IPC 没有绑定死到启动 repo

daemon 接受 `request.root`，再根据这个 root 执行 authority 操作。

风险是：

```text
如果 endpoint 被知道，或 session.json 被伪造，
请求方可能让 daemon 对非启动 repo 执行 authority 操作。
```

另外，一些非 controller 方法看似是只读，但仍可能触发 mirror / event 写入。

涉及位置：

- `src/adapters/local-authority-session.ts`

修复方向：

- session daemon 启动后绑定固定 repo root / repoId。
- 所有请求中的 root 只能用于 sanity check，不能改变 daemon 操作对象。
- 非 controller 方法必须真正只读。
- mirror repair / event append 这种写入动作必须明确归类为 controller operation 或 trusted maintenance operation。

### P2：文件系统边界缺少 symlink / realpath 策略

当前大量路径操作依赖：

```text
statSync
cpSync
rmSync
```

如果允许路径下出现 symlink，可能导致：

```text
index / view / apply 触达 repo 根目录之外的真实路径。
```

涉及位置：

- `src/adapters/local-file-database.ts`
- `src/usecases/changeset.ts`

修复方向：

- 统一使用 `lstat` 识别 symlink。
- v0/v1 阶段可以直接拒绝 symlink。
- 如未来支持 symlink，必须有 realpath containment 校验。
- `copy`、`snapshot`、`remove`、`apply` 全部走同一套 path policy。

### P2：summary 允许旧摘要静默套到当前文件

当前 summary 查询如果 exact miss，可能 fallback 到 path-level 或最后一条摘要。

风险是：

```text
文件内容已经变化，但索引仍显示旧摘要。
```

索引不是 AWBS 事实源，但摘要会影响 agent 如何选择上下文，因此不能静默错配。

涉及位置：

- `src/adapters/file-summary-store.ts`
- `src/usecases/index.ts`

修复方向：

- 默认只接受 sha256 精确匹配的摘要。
- path-level 摘要必须显式标记为 `summarySource: "path-level"` 或类似状态。
- stale summary 不能伪装成 current summary。
- query 输出应能区分 exact / stale / path-level / missing。

## Cross-Cutting Fix Order

优先级建议如下：

1. 统一 path policy。
2. 禁止 `.git`、`.awbs/private`、`.awbs` 系统路径绕过。
3. 禁止 symlink escape。
4. changeset payload hash 封装和 apply 前重算。
5. AuthorityPort 提升为语义 operation 接口。
6. ledger 增加 hash-linked verify。
7. session daemon 绑定启动 repo。
8. summary stale 语义显式化。
9. 补 adversarial tests。

## Required Test Cases

本轮实现已经补以下对抗测试：

- `view create --read .` 不能复制 `.awbs/private`。
- `view create --read .awbs` 被拒绝或被系统路径策略过滤。
- `view create --write .git` 被拒绝。
- workspace 删除 `.git` 后，collect/apply 不得破坏数据库根目录。
- collect 后篡改 `changeset/files/`，apply 必须拒绝。
- operationHash 变化能检测 payload 篡改。
- ledger verify 能从 genesis 重算整条 hash-linked chain。
- session daemon 不能对非启动 repo 执行 authority 操作。
- 非 controller session 方法不能写 mirror/event。
- symlink 指向 repo 外部时，index/view/apply 必须拒绝。
- stale summary 不得被标成 exact current summary。
- `.awbs` / `.git` 大小写变体不能绕过保留路径策略。
- 通过 symlink 作为写入目标时，文件数据库必须拒绝而不是覆盖链接外部目标。

## Non-Goals

006 不把 AWBS 改成沙箱系统。

006 不承诺对抗 admin/root。

006 不实现旧仓库兼容。

006 不引入 AI 摘要。

006 不引入 OS keychain / Windows service / Linux daemon 账户。

006 不做自动删除污染目录的危险清理。

## Acceptance Direction

006 完成后，AWBS 的可信边界应当更接近：

```text
开放文件系统可以混乱。
agent workspace 可以混乱。
Git 普通 HEAD 可以混乱。

但 AWBS 认证数据库只能由：
  path-policy-valid changeset
  + payload-hash-verified operation
  + authority-semantic apply
  + hash-linked ledger
  + trusted ref
共同推进。
```

这才符合 AWBS 的核心设计：输入开放，落地受控；失败可观察，不能伪成功；可信事实只能从可信链进入。

## First Implementation Pass

第一轮修复已经覆盖以下内容：

- 新增统一 path policy，拒绝把数据库根、`.git`、`.awbs`、`.awbs-view.json` 当成用户数据路径投影或写入。
- `view create --read .`、`--read .awbs`、`--write .git` 会被拒绝。
- index 默认排除整个 `.awbs` 系统目录，不再把 authority / private / run material 作为可查询用户数据。
- 文件系统 copy / snapshot / remove / index walk 拒绝 symlink，避免通过链接触达 repo 根之外。
- changeset collect 不再复制只读或保留路径违规 payload。
- changeset manifest 增加 `payloadHash` 和 `operationHash`。
- changeset collect 会生成 authority-sealed receipt，apply 必须打开 receipt 并匹配 manifest / payload。
- apply 前会先完成 path policy、payload sha256、payloadHash、operationHash、sealed receipt 校验，再执行写入。
- ledger entry 增加 `previousEntryHash`、`entryHash`、`changesetPayloadHash`、`appliedPathStates`。
- ledger append 会检查 entry 是否链接当前 head，ledger verify 会从头重算 entry hash 链，并校验 trusted commit 是否匹配 ledger head entry。
- `view create`、`index rebuild`、`summary set/get`、`changeset apply` 读取 trusted commit 前会要求 trusted chain verification 通过。
- session daemon 绑定启动 repo，并只允许同 repoId / 同 Git worktree 语义下的内部 trusted worktree 请求。
- session start 不再自动迁移旧 repo trustMode；开发期仓库结构不兼容就应重新初始化。
- summary set / get 改为基于 trusted commit 计算 sha，旧 sha 摘要不会静默套到新内容。
- `.awbs` / `.git` 保留路径判断改为大小写无关，适配 Windows 文件系统语义。
- session controller token 不再作为 raw token 进入 IPC，请求使用 nonce HMAC proof。
- session daemon 拒绝重复 nonce，防止 controller proof 重放。
- 可信写入成功响应必须带 response proof，CLI 会拒绝未签回的伪成功响应。
- session daemon 启动改为 hidden detached + stdio ignore，避免 Windows 测试/运行时弹出大量控制台窗口。
- `npm test` 改为串行执行，避免并发测试一次性拉起过多 session daemon。

第一轮仍未完成的更大结构改造：

- Authority Service 还没有完全提升为唯一的 `applyVerifiedOperation` 语义入口。
- OS keychain / 独立系统服务身份仍然属于后续任务，不在 006 第一轮内。
