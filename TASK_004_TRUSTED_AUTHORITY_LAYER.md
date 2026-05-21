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
createdAt
```

其中：

- `previousEntryHash` 指向上一条 ledger entry 的 hash。
- `entryHash` 是当前 entry 的 canonical hash。
- `operationHash` 是本次 operation 全部关键材料的 hash。
- `parentTrustedCommit` 是本次操作基于的上一个 trusted commit。
- `currentTrustedCommit` 是本次操作推进后的 trusted commit。

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

