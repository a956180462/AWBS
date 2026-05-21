# AWBS 003：可信数据链与可信重建

## Summary

003 的核心不是“清理 Git 脏提交”，而是建立 **AWBS Trusted Chain / AWBS 可信数据链**。

AWBS 认证数据库不再等于普通 Git `HEAD`，也不等于当前工作区文件。AWBS 认证数据库只等于可信链头对应的 Git tree。

可信链规则是：

```text
trustedCommit(Tn)
  -> view projection 基于 Tn
  -> changeset 声明基于 Tn
  -> apply 只把 changeset 写入 Tn
  -> 生成 trustedCommit(Tn+1)
```

任何不来自 AWBS `changeset apply` 的提交、文件写入或 Git 操作，都不会自动进入 AWBS 可信链。它们可以被 `db audit` 报告，也可以通过可信重建排除，但 AWBS 不承认它们是认证数据库的一部分。

## Design Position

003 后，AWBS 的数据库事实源分成两层：

```text
Git repository
  保存所有普通 Git 对象、提交、分支和工作区状态。

AWBS trusted chain
  只保存 AWBS 承认的数据库状态推进链。
```

Git 仍然是底层版本管理器，但 Git 当前 `HEAD` 只是普通工作状态，不再自动代表 AWBS 数据库状态。

AWBS 当前认证数据库头由两部分共同确定：

```text
.awbs/authority/ledger.seal.json
refs/awbs/trusted
```

其中：

- `ledger.seal.json` 是 sealed trusted ledger。
- `ledger.mirror.json` 是给人看的明文镜像，可重建，不作为事实源。
- `ledger-events.jsonl` 是诊断事件日志。
- `refs/awbs/trusted` 指向当前 AWBS 认证数据库头。

## Why Git User Is Not Enough

Git commit 中的这些字段都可以被本地调用者任意设置：

```text
author.name
author.email
committer.name
committer.email
```

例如：

```powershell
git -c user.name="A" -c user.email="a@example.com" commit -m "..."
```

因此：

- 不能说“只允许某个 Git 用户名提交”。
- 不能通过 Git 用户名判断合法写入。
- GitHub 登录身份只能说明谁 push 了 commit，不等于 commit author 可信。
- signed commit 可以提高外部身份可信度，但不等于 AWBS 写入流程可信。

AWBS 需要自己的可信数据链，而不是把 Git 用户名当权限系统。

## Authority Ledger Layout

003 增加：

```text
.awbs/
  authority/
    ledger.seal.json
    ledger.mirror.json
    ledger-events.jsonl
```

密封账本解密后包含：

```json
{
  "schemaVersion": 1,
  "repoId": "uuid",
  "ledgerVersion": 1,
  "createdAt": "iso time",
  "updatedAt": "iso time",
  "headEntryId": "uuid",
  "entries": [],
  "ext": {}
}
```

每条 entry 至少包含：

```json
{
  "schemaVersion": 1,
  "entryId": "uuid",
  "kind": "bootstrap | changeset",
  "parentTrustedCommit": "git commit",
  "baseCommit": "git commit",
  "changesetId": "changeset_xxx",
  "viewId": "uuid",
  "createdAt": "iso time",
  "appliedPaths": [],
  "changesetManifestHash": "sha256:...",
  "authorityContractHash": "sha256:...",
  "operationHash": "sha256:...",
  "ext": {}
}
```

`resultCommit` 不写进同一个 sealed entry。原因是 Git commit hash 由 commit 内容决定，如果账本文件里预先写入 result commit hash，会形成自引用。

当前实现的策略是：

```text
sealed ledger entry
  记录可提前确定的操作事实。

Git commit trailer
  记录 AWBS-Ledger-Entry 和 AWBS-Operation-Hash。

refs/awbs/trusted
  指向包含最新 sealed ledger entry 的认证数据库提交。
```

## Bootstrap

003 新增：

```text
awbs ledger bootstrap
```

bootstrap 要求当前 Git `HEAD` 存在，并创建第一条可信链记录。

这一步会：

1. 读取当前 Git `HEAD` 作为 `parentTrustedCommit`。
2. 写入第一份 sealed ledger。
3. 创建一个 AWBS bootstrap commit。
4. 将 `refs/awbs/trusted` 指向 bootstrap commit。

从这一刻开始，AWBS 数据库头不再由普通 `HEAD` 决定，而由 `refs/awbs/trusted` 决定。

## View / Index / Apply Behavior

003 后，核心流程变成：

```text
view create
  从 currentTrustedCommit 的 Git tree 投影文件。
  不读取当前污染工作区。

index rebuild
  扫描 currentTrustedCommit 的 Git tree。
  不把当前工作区污染文件写入索引。

changeset collect
  比较 view baseline 和 workspace 当前状态。
  changeset.baseCommit 来自 sealed view contract。

changeset apply
  只接受 baseCommit 等于 currentTrustedCommit 的 valid changeset。
  只读路径违规永远拒绝。
  成功后写入业务文件变化、sealed ledger entry，并推进 refs/awbs/trusted。
```

如果当前工作区干净且 `HEAD` 正好等于 currentTrustedCommit，apply 可以在当前工作区原地提交，方便普通使用。

如果当前 Git `HEAD` 已经被外部 commit 推走，AWBS 不在外部 commit 上继续生长。apply 会基于 currentTrustedCommit 的临时 worktree 生成新的可信提交，并推进 `refs/awbs/trusted`。外部 commit 仍然留在 Git 里，但不进入 AWBS 认证数据库。

旧 view 基于旧 trusted commit。可信链推进后，旧 view 的 apply 会被拒绝；要继续工作，必须从新的 currentTrustedCommit 重新创建 view。

## Database Audit

003 新增：

```text
awbs ledger inspect [--json]
awbs ledger verify [--json]
awbs db audit [--json]
```

`ledger inspect` / `ledger verify` 检查：

- `refs/awbs/trusted` 是否存在。
- trusted commit 中的 sealed ledger 是否可解密。
- ledger head entry 是否存在。

`db audit` 检查：

- 当前 Git `HEAD` 是否等于 currentTrustedCommit。
- 当前 `HEAD` 是否偏离 AWBS trusted chain。
- 当前工作树是否有未提交变化。
- authority / ledger 是否可验证。

审计的语义不是“阻止 Git”，而是明确告诉用户：哪些内容属于 AWBS 认证数据库，哪些只是普通 Git 或文件系统状态。

## Trusted Rebuild

003 新增：

```text
awbs db clean-rebuild [--json]
awbs db backups list [--json]
```

`clean-rebuild` 不在污染目录里做复杂递归删除。它采用更稳的方式：

```text
1. 读取 currentTrustedCommit。
2. 从该 commit 克隆/检出一个干净数据库目录。
3. 复制 .awbs/private/local.json，保证新目录能解密 authority。
4. 验证新目录 authority / ledger。
5. 将原数据库目录改名为 <name>.backup-<timestamp>。
6. 将干净目录改名接管原数据库路径。
```

旧目录默认保留，不自动删除。003 不实现 purge。

这样清理不会在污染现场逐个删除文件，也不会试图理解所有软链接、临时文件或外部写入。AWBS 只从自己的可信链头重建一个干净数据库。

## Current CLI

003 后新增命令：

```text
awbs ledger bootstrap [--json]
awbs ledger inspect [--json]
awbs ledger verify [--json]
awbs db audit [--json]
awbs db clean-rebuild [--json]
awbs db backups list [--json]
```

基本流程变为：

```powershell
awbs init
git add .
git commit -m "initialize database"
awbs ledger bootstrap

awbs view create --out workspace --read A --write B
awbs changeset collect --workspace workspace
awbs changeset apply <changesetId>
```

## Boundaries

- 003 不实现强安全沙箱。
- 003 不阻止本地用户直接修改文件或直接 Git commit。
- 003 只是不承认这些绕过 AWBS 的写入属于 AWBS 认证数据库。
- 已提交外部历史不静默删除、不重写。
- 清理核心采用可信重建和目录替换，不采用精细递归删除。
- 备份目录删除后续另做显式 purge 任务，003 不做自动删除。
- 摘要仍然永远由上层写入，AWBS 不内置 AI 摘要。
