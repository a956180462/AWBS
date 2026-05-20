# AWBS 003：AWBS 写入账本与数据库审计

## Summary

003 的目标是把 001 的视图鉴权器继续扩展为 AWBS 自己的写入事实源。

Git 的 author、committer、用户名和邮箱都只是 commit 元数据，不是 AWBS 可以信任的身份认证。任何能在本地执行 Git 的人或程序，都可以伪造某个用户名提交。因此，AWBS 不能通过 Git 用户名判断“这是不是合法 AWBS 写入”。

003 要建立一套 AWBS 自己承认的账本：

```text
changeset apply
  -> 校验 sealed view contract
  -> 写入数据库文件
  -> 写入 sealed ledger entry
  -> 生成 Git commit
  -> 后续 audit 能证明这个 commit 是 AWBS apply 产生的
```

它的核心作用是：

- 记录哪些数据库变更是通过 AWBS changeset apply 落地的。
- 识别哪些 Git commit 是外部直接提交的。
- 识别哪些 commit 声称自己来自 AWBS、但账本或 authority 对不上的伪造记录。
- 为后续数据库污染审计和清理提供事实依据。

003 仍然不是沙箱，也不试图阻止一个有本地权限的人直接修改文件或执行 Git。它做的是：**AWBS 永远不承认绕过 changeset 和 authority ledger 的写入是合法 AWBS 写入。**

## Design Position

001 的 Authority 有两个职责：

```text
视图鉴权
  记录 viewId、readPaths、writePaths、baseCommit 和 workspace 投影事实。

写入账本
  记录哪些 changeset apply 被 AWBS 接受，并以什么 Git commit 进入数据库。
```

这两件事应该在同一个 authority 体系下，因为它们共同回答一个问题：

```text
什么东西被 AWBS 认为是正式、可追溯、可验证的数据库状态变化？
```

Git 仍然是底层版本管理器，但 AWBS 的正式写入事实源不能只依赖 Git commit metadata。

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

AWBS 需要自己的账本，而不是把 Git 用户名当权限系统。

## Authority Ledger Layout

003 建议新增：

```text
.awbs/
  authority/
    ledger.seal.json
    ledger.mirror.json
    ledger-events.jsonl
```

其中：

- `ledger.seal.json` 是 AWBS 信任的密封账本。
- `ledger.mirror.json` 是给人看的明文镜像，可自动重建，不作为事实源。
- `ledger-events.jsonl` 是追加事件日志，用于诊断和恢复；最终事实仍以 sealed ledger 为准。

`ledger.mirror.json` 被人手改了没有意义。系统运行时必须从 `ledger.seal.json` 解密和认证账本，并在必要时重建 mirror。

## Ledger Contract

密封账本解密后包含：

```json
{
  "schemaVersion": 1,
  "repoId": "uuid",
  "ledgerVersion": 1,
  "entries": [],
  "ext": {}
}
```

每条 entry 至少包含：

```json
{
  "schemaVersion": 1,
  "entryId": "uuid",
  "changesetId": "changeset_xxx",
  "viewId": "uuid",
  "baseCommit": "git commit before apply",
  "createdAt": "iso time",
  "appliedPaths": [],
  "changesetManifestHash": "sha256:...",
  "authorityContractHash": "sha256:...",
  "operationHash": "sha256:...",
  "commitTrailers": {
    "AWBS-Ledger-Entry": "uuid",
    "AWBS-Operation-Hash": "sha256:..."
  },
  "ext": {}
}
```

注意：`resultCommit` 不应直接写进同一个 commit 内的 sealed ledger entry。原因是 Git commit hash 由 commit 内容决定；如果账本文件中预先写入 result commit hash，会形成自引用。

003 的正确策略是：

```text
sealed ledger entry
  记录 entryId、changesetId、baseCommit、appliedPaths、operationHash 等可提前确定的事实。

Git commit trailer
  记录 AWBS-Ledger-Entry 和 AWBS-Operation-Hash。

audit 阶段
  扫描 Git history，找到包含对应 ledger entry 和 trailer 的 commit。
  resultCommit 是审计推导结果，不是 sealed entry 内部的自引用字段。
```

## Commit Trailer

AWBS apply 生成的 commit message 可以包含：

```text
awbs: apply <changesetId>

AWBS-Ledger-Entry: <entryId>
AWBS-Changeset: <changesetId>
AWBS-View: <viewId>
AWBS-Operation-Hash: sha256:<hash>
```

这些 trailer 不是单独可信的。它们只是 Git history 中的可读线索。系统真正验证时必须同时检查：

- commit 中是否包含对应的 sealed ledger 更新。
- sealed ledger 是否能通过 authority key 解密和认证。
- ledger entry 的 `operationHash` 是否匹配 changeset、view contract 和 applied paths。
- commit 的 parent 是否等于 entry 记录的 `baseCommit`。

如果 trailer 存在但 sealed ledger 不匹配，应判定为伪造或损坏。

## Apply Behavior

003 后，`changeset apply` 成功条件应包括：

- authority verify 通过。
- view contract 未被 revoke。
- changeset valid。
- 没有只读路径修改。
- 当前 Git HEAD 等于 sealed contract 的 `baseCommit`。
- 工作树干净。
- 将数据库变更和 sealed ledger 更新放进同一个 Git commit。

如果数据库文件已经写入但账本无法写入，不能伪装成功。实现时应尽量在 commit 前完成所有可验证材料的准备；任何中途失败都必须留下明确诊断。

## Audit

003 建议新增：

```text
awbs ledger inspect [--json]
awbs ledger verify [--json]
awbs db audit [--json]
```

`ledger verify` 检查：

- `ledger.seal.json` 是否可解密。
- mirror 是否与 sealed ledger 一致。
- 每条 entry 是否字段完整。
- entry 是否能在 Git history 中找到对应 commit。
- 对应 commit 的 trailer、parent、applied paths 是否匹配。

`db audit` 检查：

- 当前工作树是否有未提交变化。
- 当前工作树是否有 untracked 文件。
- Git history 中是否存在没有 AWBS ledger entry 的外部 commit。
- 是否存在伪造 AWBS trailer 但账本不匹配的 commit。
- `.awbs/authority` 是否被破坏。

## Cleanup

003 可以提供清理能力，但必须区分未提交污染和已提交历史。

未提交污染：

```text
awbs db clean --dry-run
awbs db clean --restore-head
```

默认必须是 dry-run，只报告会恢复哪些 tracked 文件、会删除哪些 untracked 文件。真正删除或恢复必须由显式参数触发。

已提交外部 commit：

```text
awbs db audit
```

只报告，不静默删除，不重写历史。未来如果需要修复，应生成显式的 revert/repair changeset 或要求人工处理。

设计原则：

```text
能自动发现污染。
不能静默删除历史。
不能把清理失败伪装成成功。
```

## Workspace Cleanup

workspace 污染和数据库污染不是一回事。

当前 collect 已经可以发现 workspace 中只读路径或非授权路径的变化，并把 changeset 标记为 invalid。后续可以增加：

```text
awbs workspace audit --workspace <path>
awbs workspace clean --workspace <path> --dry-run
awbs workspace clean --workspace <path> --restore-baseline
```

workspace clean 的语义是：根据 sealed view contract 和 baseline，把工作空间恢复到 view 创建时的状态。它不影响数据库，不影响 Git history。

## Test Plan

新增测试应覆盖：

- Git author/committer 不参与 AWBS 合法性判断。
- apply 成功后生成 sealed ledger entry。
- apply commit 带 AWBS trailer。
- `ledger verify` 能找到对应 Git commit。
- 伪造 trailer 但没有 sealed ledger entry 时，audit 报告伪造。
- 直接手写 Git commit 时，audit 报告 external commit。
- 修改 `ledger.mirror.json` 后可从 sealed ledger 修复。
- 修改 `ledger.seal.json` 后，verify 失败。
- 未提交数据库污染可被 `db audit` 发现。
- `db clean --dry-run` 不改变文件。
- `db clean --restore-head` 只在显式参数下恢复未提交污染。
- 已提交外部 commit 不被自动删除。

## Assumptions

- 003 不实现强安全隔离。
- 003 不信任 Git 用户名或邮箱。
- 003 不要求 signed commit。
- 003 不重写 Git 历史。
- 003 不静默删除用户数据。
- 003 不处理 npm 供应链治理。
- 003 只把 AWBS 自己承认的写入路径记录为可验证事实。
