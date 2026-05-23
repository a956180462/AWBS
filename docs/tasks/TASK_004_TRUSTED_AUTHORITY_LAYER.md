# AWBS 004：可信事实层与 Authority Service

## Summary

004 的目标是把 003 已经实现的 `sealed ledger + refs/awbs/trusted`，从“可用的可信链”提升为完整的 **AWBS Trusted Authority Layer / AWBS 可信事实层** 设计。

核心定性是：

```text
文件系统保存开放内容。
Git 保存全部历史。
Trusted Authority Layer 决定 AWBS 承认哪条数据库事实链。
```

AWBS 不靠隐藏算法可信。公开仓库意味着 agent 可以阅读源码、理解规则、知道 hash 如何计算、知道 ledger 如何验证。真正的设计目标不是“让 agent 不知道”，而是：

```text
agent 知道规则，也不能仅凭 repo 文件和普通工作权限伪造 trusted chain。
```

004 要把普通 agent 绕过 AWBS 的行为，从“改一个文件、改一个 JSON、重算一段 hash”，提升为显式、高成本、可审计的 authority 攻击。

## Design Position

AWBS 可信事实层不是沙箱系统，也不是操作系统权限系统。它回答的是一个更底层的问题：

```text
AWBS 到底承认什么？
```

003 后，AWBS 已经有：

```text
sealed view contract
sealed ledger
refs/awbs/trusted
db audit
clean-rebuild
```

004 要把它们统一成一个整体：

```text
Trusted Authority Layer
  = repo identity
  + sealed view contracts
  + hash-linked trusted ledger
  + trusted head
  + verified operation apply
  + audit / rebuild rules
  + signer / trust anchor
```

这层统一回答四个问题：

```text
1. 当前 AWBS 认证数据库是哪一个 trusted commit？
2. 某个 workspace / view 是不是 AWBS 承认的？
3. 某个 changeset / operation 能不能推进认证数据库？
4. 当前目录偏离可信链后，如何回到 AWBS 承认的状态？
```

## Trusted State Model

AWBS 的认证数据库状态应当被理解为一条可信状态推进链：

```text
Trusted State T0
  -> apply verified operation O1
  -> Trusted State T1
  -> apply verified operation O2
  -> Trusted State T2
```

在文件系统数据库中：

```text
trusted state
  = trusted commit 对应的 Git tree

verified operation
  = 被 Authority 验证并接受的状态转换

ledger entry
  = 对这次状态转换的认证记录
```

普通 Git `HEAD`、当前工作区、外部 commit、未提交文件，都不是 AWBS 认证数据库头。AWBS 当前认证数据库头由：

```text
refs/awbs/trusted
sealed trusted ledger
```

共同确认。

## Operation As The Trusted Unit

AWBS 可信链的最小推进单元不是文件，也不是普通 Git commit，而是：

```text
verified operation
```

当前最主要的 operation 是：

```text
data changeset apply
```

也就是说：

```text
changeset
  = 状态变化请求

apply
  = 状态转换动作

trusted commit
  = 转换后的数据库状态

ledger entry
  = 对这次转换的认证记录
```

004 设计上允许未来扩展 operation 类型：

```text
genesis
data changeset apply
authority update
view revoke
summary update
clean rebuild receipt
```

这些 operation 都应当进入同一条可信事实链，但它们的语义不同：

- `genesis`：创建初始 AWBS 认证数据库状态。
- `data changeset apply`：把业务文件变化写入可信数据库。
- `authority update`：更新 AWBS 自身的可信事实层。
- `view revoke`：撤销 view，使未来 collect / apply 拒绝该 view。
- `summary update`：记录上层业务写入的摘要变化。
- `clean rebuild receipt`：记录一次可信重建行为，但不把备份目录删除当作自动动作。

## Hash-Linked Ledger

003 的 ledger 已经能记录可信写入。004 要把它进一步设计成真正的 hash-linked ledger。

每条 entry 应当包含：

```text
entryId
entryType
previousEntryHash
entryHash
operationHash
parentTrustedCommit
currentTrustedCommit
appliedPaths
appliedPathStates
createdAt
```

其中：

- `previousEntryHash` 指向上一条 ledger entry 的 hash。
- `entryHash` 是当前 entry 的 canonical hash。
- `operationHash` 是本次 operation 全部关键材料的 hash。
- `parentTrustedCommit` 是本次操作基于的上一个 trusted commit。
- `currentTrustedCommit` 是 `refs/awbs/trusted` 当前指向的 commit；实现上不把 result commit 自引用写入同一个 sealed entry，而是通过 ref、commit parent、commit message、diff path 和 `appliedPathStates` 共同验证。
- `appliedPathStates` 记录本次 operation 后关键业务路径的最终状态，用来阻止复制旧 ledger 后替换文件内容的伪造 commit。

链式关系是：

```text
entryHash(Tn)
  = hash(canonical entry at Tn)

entryHash(Tn+1)
  = hash(canonical entry at Tn+1, previousEntryHash = entryHash(Tn))
```

这样，如果有人改了中间某条 entry，后续 entry 的 hash 链会断。AWBS 不能阻止别人乱改文件，但可以拒绝承认对不上的链。

## Operation Hash

`operationHash` 不应只 hash 一个 changeset id，而应覆盖这次状态转换的全部关键材料。

对于 `data changeset apply`，至少应覆盖：

```text
view contract hash
changeset manifest hash
changeset payload hash
allowed applied paths
parentTrustedCommit
operation type
authority policy version
```

Authority 验证 operation 时，必须重新计算这些 hash，而不是相信请求方提交的 hash。

## Authority Service

004 的主方向是引入 **AWBS Authority Service**。

005 的实现选择先落 A 模式：同用户的 **Ephemeral Key Session / 运行期本地钥匙托管**。它不创建 OS 用户，不接系统 keychain，不实现独立系统服务。B 模式，也就是独立 OS 身份、系统级 key 存储和真正的 `awbsd` 服务，仍然是后续方向。

它是一个独立运行的本地可信服务：

```text
awbsd / AWBS Authority Service
  以独立 OS 身份运行
  持有 signer / trust anchor
  验证 operation
  写入 sealed ledger
  推进 refs/awbs/trusted
```

agent、Codex、Claude Code 或普通 CLI 不持有根信任。它们只提交请求：

```text
agent / CLI
  -> create workspace
  -> collect changeset
  -> submit operation request

Authority Service
  -> verify operation
  -> sign operation
  -> apply operation
  -> advance trusted chain
```

关键规则：

```text
Authority Service 不能提供 sign(rawHash)。
Authority Service 只能提供 applyVerifiedOperation / applyVerifiedChangeset。
```

也就是说，服务不能变成“给任意字符串盖章”的接口。它必须自己读取 sealed view contract、changeset manifest、payload、trusted head 和 policy，然后重新计算 operation hash。只有验证通过，才允许签名和推进可信链。

## Authority Bootstrap

AWBS core 不应该在没有 authority session 的情况下进入可信写入状态。

启动顺序应当是：

```text
1. 检测运行平台
   Windows / Linux / unknown

2. 检测 authority mode
   repo-local sealed key
   ephemeral key session
   OS key store
   local Authority Service
   remote signer

3. 建立 trust anchor
   获取解封能力、签名能力或 authority service session

4. 验证 repo authority
   repoId
   sealed catalog
   sealed ledger
   refs/awbs/trusted
   trusted commit binding

5. 启动 AWBS core
   只有 authority ready 后，可信写入才允许执行
```

如果任一关键步骤失败，系统不能伪成功。它必须进入明确状态：

```text
ready
  可以执行可信读写。

degraded-readonly
  可以读取、审计、诊断，但不能推进 trusted chain。

unavailable
  不能打开可信事实层，需要人工修复或重新建立 authority。
```

对应失败原因包括：

```text
platform unsupported
authority mode unavailable
key file missing
key already checked out by another session
OS key store unavailable
Authority Service unreachable
ledger cannot be opened
trusted head cannot be verified
```

004 要把这个启动过程定义成 AWBS 核心的一部分，而不是某个外围工具命令。因为 AWBS 真正管理的是：

```text
输入如何变成 verified operation。
输出如何永久记录进 trusted chain。
```

没有 authority session，就没有可信写入。

## Independent OS Identity

Authority Service 应当支持以独立 OS 用户身份运行。

Windows 方向：

```text
本地用户：awbs-authority
服务进程：awbsd
密钥存储：DPAPI / Credential Manager / CNG KSP / TPM-backed provider
通信方式：named pipe / localhost IPC
```

Linux 方向：

```text
system user：awbs
服务进程：awbsd
密钥存储：kernel keyring / Secret Service / TPM trusted key
通信方式：Unix socket
```

这样，普通用户身份下运行的 agent 即使能读仓库、读源码、写 workspace，也不能直接读取 `awbs-authority` 身份下的 signer key。

这不等于对 admin/root 绝对安全。它的目标是把普通 agent 的绕过成本提高到：

```text
攻击 Authority Service
攻击 OS 用户边界
攻击 signer / trust anchor
```

这已经明显不同于“改一个 JSON 就能绕过”。

## Ephemeral Key Session

004 还应当记录一个轻量但很有价值的模式：**Ephemeral Key Session / 运行期钥匙托管**。

它的核心思路是：

```text
应用初始化时：
  AWBS 生成或读取 key 文件。
  应用把 key 读入内存。
  应用立即删除磁盘上的 key 副本。

应用运行中：
  key 只存在于当前 AWBS authority session 的内存中。
  agent 在自己的工作生命周期中无法通过文件系统直接读取 key。

应用收尾时：
  AWBS 停止接受新的可信写入。
  authority session 把 key 写回持久位置。
  应用退出。
```

这个模式的价值不是对抗 admin/root，也不是替代 Authority Service。它解决的是一个非常实际的问题：

```text
不要让强 agent 在普通任务中顺手读到 repo 里的 key 文件。
```

如果 agent 的生命周期发生在 key 已经被读入内存、磁盘副本已经删除之后，那么对这个 agent 来说，key 在文件系统层面就是不可见的。它即使知道 AWBS 源码，也不能只靠搜索 repo 文件拿到 key。

因此，运行期钥匙托管可以作为 004 的中间层：

```text
Level 1: repo-local sealed key
Level 1.5: ephemeral key session
Level 2: OS secret store / OS keychain
Level 3: local Authority Service
```

这个模式的边界也必须写清：

- 它依赖应用正确管理生命周期。
- 它要求 key 装载后删除磁盘副本，退出前再写回。
- 如果进程崩溃，必须有恢复策略，例如人工恢复、备份密封包或重新建立 authority。
- 如果另一个不受控 agent 在 AWBS 应用未运行时扫整个机器并读取 key 文件，这不属于 AWBS 单独能解决的问题。
- 如果应用构建者让 agent 在整个文件系统中无边界乱跑，那属于上层应用的 agent 管理失败，不应由 AWBS 假装兜底。

这不是放弃安全，而是明确职责边界：

```text
AWBS 负责让自己的可信写入链路不暴露 key。
上层应用负责约束自己启动的 agent 何时运行、能访问哪里、能不能在 AWBS 未托管 key 时乱扫文件。
```

在产品形态上，可以把它理解为：

```text
awbs authority session start --control-stdin
  -> load key into memory
  -> remove persisted key copy
  -> mark authority ready

awbs authority session stop --control-token-stdin
  -> stop trusted writes
  -> persist key
  -> mark authority unavailable
```

005 已经实现了 A 模式的 session 生命周期。恢复因子由上层应用的非 AI 控制层通过 stdin 注入，不由 agent 工作流持有，也不默认要求人类在第一次运行时交互输入。

## Trust Anchor Levels

004 采用服务优先的路线，但设计上保留分级能力：

```text
Level 0: Hash chain only
  只做 hash-linked ledger。
  防误改、防损坏、防低级伪造。
  不防强 agent 全量重算链。

Level 1: Repo-local sealed key
  key 派生材料在本地 repo 或本机上下文中。
  提高绕过成本，但同用户强 agent 仍可能寻找材料。

Level 1.5: Ephemeral key session
  应用启动时把 key 读入内存并删除磁盘副本。
  应用结束时再把 key 写回持久位置。
  适合单应用会话，能阻止 agent 在任务生命周期中顺手读 key 文件。

Level 2: OS secret store / OS keychain
  key 不明文落在 repo。
  使用 Windows DPAPI / Credential Manager，或 Linux keyring / Secret Service。

Level 3: Local Authority Service
  独立 OS 身份运行。
  CLI 和 agent 只请求验证 operation，不持有 signer。

Level 4: Remote signer / external append-only checkpoint
  信任锚移出当前机器。
  用远程 signer、protected environment 或外部 append-only log 做 checkpoint。
```

AWBS 不需要一开始就实现全部级别，但文档和接口设计不能把系统锁死在 Level 1。

## Security Boundary

AWBS 可信事实层的承诺是：

```text
源码公开不破坏安全。
普通权限 agent 不能仅凭 repo 文件伪造 trusted chain。
绕过 trusted chain 的行为会变成显式、高成本、可审计的 authority 攻击。
```

AWBS 不承诺：

```text
在 agent 拥有 admin/root 后仍然不可伪造。
```

拥有 admin/root 的 actor 理论上可以：

```text
替换服务程序
读取服务进程内存
修改服务配置
切换到 authority 用户
拦截 IPC
调用 signer 帮它签
修改系统策略
```

这属于主机最高信任边界被攻破。AWBS 的正确表述应当是：

```text
AWBS trusted chain protects against untrusted workflow actors.
It does not protect against a fully compromised host administrator.
```

中文表述：

```text
AWBS 可信链防的是不可信工作流执行者，
不防已被完全攻破的主机管理员。
```

## Relation To Blockchain

004 不引入币、共识、挖矿、P2P 网络、经济激励或链上资产。

AWBS 只借用区块链中最适合本系统的一部分：

```text
后一条记录承认前一条记录。
任何人改了中间记录，后面的链都会对不上。
```

在 AWBS 中：

```text
区块链交易
  -> AWBS verified operation / changeset

区块链状态
  -> AWBS trusted commit 对应的文件系统数据库状态

区块链区块头
  -> AWBS ledger entry hash
```

AWBS 不需要全网共识，因为 AWBS 的问题不是“多人无中心共识”，而是“本地 agent 工作流中，哪些状态被 AWBS 承认”。

## Summary Boundary

摘要仍然永远由上层写入，AWBS 不内置 AI 摘要。

Trusted Authority Layer 可以记录 summary update 这种 operation，但它不负责生成摘要、不配置模型、不保存 API key、不理解业务语义。

正确边界是：

```text
上层业务生成摘要。
AWBS 保存摘要记录。
Trusted Authority Layer 决定摘要记录是否进入可信链。
```

## Future Implementation Direction

004 只写设计文档，不实现代码。

后续实现可以拆成：

```text
005: hash-linked ledger schema
006: AuthoritySignerPort
007: local Authority Service prototype
008: OS key store integration
009: external checkpoint / remote signer
```

实现时应保持一个原则：

```text
不要让 CLI 成为事实上的 root authority。
CLI 是客户端；Authority Service 才是可信状态推进者。
```
