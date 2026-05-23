# AWBS 007：可信操作入口与只读/修复拆分

## Summary

007 的目标是把 AWBS 可信写入收束成更清楚的语义入口。

AWBS 不信任“谁声称自己是应用”。AWBS 只信任：

```text
controller capability
+ authority session
+ verified operation
```

也就是说：

```text
Workflow Actor 可以产出请求和 changeset。
Host Controller 才能授权可信操作。
```

AWBS 不防止宿主应用主动把控制权交给 agent；那属于宿主应用授权错误。AWBS 要防的是未获 controller capability 的 workflow actor 绕过可信链。

## Actor Model

```text
Workflow Actor
  普通 agent / 大 agent / 工作流步骤。
  可以在 workspace 中工作。
  可以生成 changeset。
  可以读取诊断和索引。
  不能直接推进 AWBS 可信事实。

Host Controller
  上层应用的非 AI 控制层 / 人类确认层 / 服务端控制层。
  持有 controllerToken。
  决定是否创建 view、撤销 view、修复 mirror、apply changeset。
```

如果宿主应用把 controllerToken 暴露给 agent，AWBS 会把这个请求视为已授权请求。AWBS 不伪装自己还能阻止这种宿主授权错误。

当前实现中，controllerToken 不直接进入 session IPC。CLI 用 controllerToken 派生 HMAC proof，并把 proof 绑定到：

```text
method
root
args
nonce
createdAt
```

session daemon 在内存中记录已使用 nonce，拒绝重放。可信写入的成功响应也必须由 daemon 签回 response proof；CLI 验证后才承认操作成功。这样即使 `.awbs/private/session.json` 被篡改指向一个假 endpoint，假 endpoint 也不能伪造“可信写入成功”。

## Trusted Operation Entry

Authority Service 不应暴露底层写入原语。

禁止把它设计成：

```text
sign(rawHash)
appendLedgerEntry(rawEntry)
createViewContract(rawContract)
```

应当收束成语义操作：

```text
bootstrapTrustedChain
createView
revokeView
sealChangesetReceipt
recordChangesetApply
repairMirrors
```

这些操作必须在 Authority 内部重新检查当前 authority 状态，并由 Authority 自己完成密封写入、ledger 记录或 mirror 重建。

## Verify / Repair Boundary

`verify` 是只读诊断。

```text
verify:
  读取 sealed payload
  读取 mirror
  报告 mirror mismatch / seal error / ledger error
  不写任何文件
```

`repair` 是显式维护写入。

```text
repair-mirrors:
  需要 controllerToken
  从 sealed payload 重建 mirror
  可写 view-events.jsonl
```

不能让一个看似只读的检查命令偷偷修复 mirror。否则 AWBS 会出现隐藏写入通道。

## `.awbs` Boundary

`.awbs` 是 AWBS 系统目录，不是业务数据目录。

```text
.awbs/authority
.awbs/private
.awbs/index
.awbs/views
.awbs/changesets
.awbs/summaries
```

这些目录不进入 agent workspace。agent 需要的上下文应被投影成普通业务文件，而不是直接读取 AWBS 自己的系统材料。

## Implementation Result

007 完成后：

- session daemon 不接受 `createViewContract` / `appendLedgerEntry` 这类低层写入 method。
- session daemon 只接受绑定仓库或同一 Git common dir 下的临时 worktree。
- controller capability 通过 nonce HMAC proof 表达，不把 raw token 发给 session endpoint。
- controller proof 不能重放，可信写入成功响应必须带 response proof。
- `authority verify` 不修复 mirror。
- `authority repair-mirrors` 必须带 `--control-token-stdin`。
- view create、view revoke、changeset apply 仍通过 controller capability 走语义操作。
- 普通 inspect / collect / query / verify 不需要 controller token。
- `.awbs` / `.git` 作为系统路径按大小写无关方式拒绝投影和写回。
