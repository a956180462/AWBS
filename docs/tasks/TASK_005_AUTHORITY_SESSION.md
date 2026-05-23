# AWBS 005：A 模式 Authority Session

## Summary

005 实现 **A 模式 / 运行期本地钥匙托管**。

它不创建 Windows / Linux 用户，不接操作系统 keychain，不做系统服务。005 的目标是先把 AWBS 的可信写入从“CLI 直接读取 `.awbs/private/local.json`”升级为：

```text
上层应用的非 AI 控制层
  -> 通过 stdin 注入 recoverySecret + controllerToken
  -> 启动 AWBS authority session
  -> session daemon 读入 local key
  -> 删除磁盘 local.json
  -> agent 生命周期内不能通过文件系统顺手读取 key
  -> 可信写入必须带 controller token
```

这里的恢复因子不是 AWBS 内置的人类交互密码。它由上层应用的非 AI 调度层提供；人类、后端服务、supervisor、部署系统都可以是上层来源，但 agent 工作流本身不应持有它。

## Core Boundary

005 仍然不是强安全沙箱，也不承诺对抗 admin/root。

它解决的是一个具体问题：

```text
强 agent 在自己的普通工作生命周期中，不应该能从 repo 文件系统直接读到 authority key。
```

因此，005 把 key 的生命周期改成：

```text
session stopped:
  .awbs/private/local.json 存在
  适合维护、备份、启动下一次 session

session active:
  .awbs/private/local.json 不存在
  key 只在同用户后台 session daemon 内存中
  .awbs/private/recovery.seal.json 存在

session crashed:
  local.json 不存在
  recovery.seal.json 存在
  AWBS 进入 authority unavailable
  必须显式 recover
```

## Actor Model

005 区分两类 actor：

```text
host controller
  上层应用的非 AI 控制层。
  持有 recoverySecret / controllerToken。
  可以启动、停止、恢复 session。
  可以授权可信写入。

workflow agent
  在工作空间中执行任务。
  可以读取视图、生成 changeset、请求诊断。
  不应持有 recoverySecret、controllerToken 或 raw key。
```

这条边界很关键。否则 agent 虽然拿不到 key，却仍然可以自己调用 `view create --write A`，让 authority 帮它创建新的可写视图。005 因此要求可信写入必须带 `controllerToken`。

## CLI

新增命令：

```text
awbs authority session start --control-stdin
awbs authority session status [--json]
awbs authority session stop --control-token-stdin
awbs authority session recover --recovery-secret-stdin
```

`--control-stdin` 读取 JSON：

```json
{
  "recoverySecret": "...",
  "controllerToken": "..."
}
```

`controllerToken` 和 `recoverySecret` 不通过 argv 传递，不写入 workspace，不写入 `.awbs/private/session.json`。
在 session IPC 中，CLI 不发送 raw `controllerToken`，而是发送包含请求 hash、nonce 和 createdAt 的 HMAC controller proof。session daemon 会记录已使用 nonce，拒绝重放；可信写入成功响应也必须带 response proof，CLI 会验证后才承认成功。

需要 controller token 的可信写入命令：

```text
awbs ledger bootstrap --control-token-stdin
awbs view create ... --control-token-stdin
awbs view revoke <viewId> --control-token-stdin
awbs changeset apply <changesetId> --control-token-stdin
```

裸 CLI 没有 `--control-stdin` 时不能启动 session；AWBS 不自动生成 secret，不弹人类口令，不把恢复因子藏进自己的配置文件。

## Files

005 使用这些运行材料：

```text
.awbs/private/local.json
  session stopped 时存在。
  session active 时删除。

.awbs/private/session.json
  只记录 repoId、pid、socketPath、startedAt、status。
  不包含 key，不包含 recoverySecret，不包含 controllerToken。

.awbs/private/recovery.seal.json
  使用 recoverySecret 派生 key 加密 AuthorityLocal。
  只用于显式 recover。
```

`.awbs/private/` 继续被 Git 忽略，不进入 AWBS 可信数据库内容。

`repo.json` 增加：

```json
{
  "trustMode": "ephemeral-local-key-v1"
}
```

开发期不做旧仓库兼容。仓库缺少 `trustMode` 时，`authority session start` 应拒绝继续运行，并要求用当前 AWBS 结构重新初始化。

## Failure Behavior

正常停止：

```text
awbs authority session stop --control-token-stdin
  -> daemon 写回 local.json
  -> 删除 recovery.seal.json
  -> 删除 session.json
  -> 退出
```

异常退出：

```text
local.json 不存在
session.json 可能残留
recovery.seal.json 存在
可信写入拒绝
```

恢复：

```text
awbs authority session recover --recovery-secret-stdin
  -> 解开 recovery.seal.json
  -> 写回 local.json
  -> 删除 stale session.json
  -> 删除 recovery.seal.json
```

错误的 recoverySecret 必须失败，不能写出伪成功的 `local.json`。

## Current Implementation

005 当前实现是同用户后台 session daemon：

```text
CLI
  -> hidden local IPC request
  -> session daemon
  -> SealedAuthorityAdapter(memoryLocal)
```

session daemon 不暴露 raw key，不提供 `sign(rawHash)`。它只执行 AWBS authority 语义接口，例如读取 view contract、创建 view、撤销 view、封存 changeset receipt、记录 changeset apply 和修复 mirror。

为了保持第一版简单，IPC 使用本机回环 TCP endpoint，并把 endpoint 记录为 `session.json.socketPath`。这不是远程服务，也不是网络信任模型；它只是本机 CLI 和同用户 daemon 之间的通信方式。
daemon 启动后绑定到启动仓库；请求 root 只能是该仓库，或同一 Git common dir 下的 AWBS 临时 worktree。复制 repoId / session.json 到另一个仓库不能让 daemon 服务该仓库。

## Not In 005

005 不实现：

- OS 用户隔离。
- Windows DPAPI / Credential Manager。
- Linux keyring / Secret Service。
- 独立系统服务 `awbsd`。
- remote signer。
- admin/root 防护。

B 模式和独立 Authority Service 仍然是后续方向。

## Verification

005 增加测试覆盖：

- session start 后 `local.json` 被删除。
- `session.json` 不含 key / token / recoverySecret。
- 无 controller token 的可信写入被拒绝。
- raw controller token 不能直接作为 IPC 请求通过。
- controller proof 不能重放。
- 未带 response proof 的伪成功响应会被 CLI 拒绝。
- 复制 session.json/repoId 到另一个 Git 仓库不能复用 session。
- session active 时可完成 bootstrap、view create、collect、apply。
- session stop 后 `local.json` 写回，session/recovery 状态清理。
- 模拟 session 崩溃后可信写入拒绝。
- 错误 recoverySecret 恢复失败。
- 正确 recoverySecret 能恢复 `local.json`。

回归命令：

```text
npm test
node src\cli.ts --help
npm pack --dry-run
```
