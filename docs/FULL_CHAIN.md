# AWBS 全链路文档

本文档描述 AWBS 初版的完整运行链路。它关注一件事：

```text
开放文件系统中的业务内容
  -> 被投影成 agent 工作空间
  -> 产出 changeset
  -> 经过 authority 认证
  -> 推进 AWBS trusted chain
```

AWBS 不是沙箱系统。它不承诺阻止人或进程直接修改文件系统、Git HEAD 或工作区。AWBS 的承诺是：**只有 AWBS 可信链承认的 operation，才进入 AWBS 认证数据库事实。**

## 1. 核心事实源

AWBS 初版里有三类事实：

```text
业务事实
  普通目录和文件

版本事实
  Git commit / tree / diff

认证事实
  .awbs/authority/*
  refs/awbs/trusted
```

普通 Git `HEAD` 不等于 AWBS 认证数据库。当前工作区也不等于 AWBS 认证数据库。

AWBS 认证数据库定义为：

```text
refs/awbs/trusted 指向的 Git commit 对应的 tree
+ sealed authority ledger 中可验证的 head entry
```

这里的“可验证”不是只看 `refs/awbs/trusted` 是否存在。AWBS 会把 trusted commit 和 ledger head entry 绑定起来检查：

- trusted commit 的父提交必须等于 ledger entry 的 `parentTrustedCommit`。
- trusted commit message 必须包含对应的 ledger entry id、operation hash 和 parent trusted commit。
- trusted commit 相对 parent 的数据路径变更必须落在 ledger 声明的 `appliedPaths` 内。
- ledger 记录的 `appliedPathStates` 必须和 trusted commit 中最终文件内容 hash 一致。

## 2. 初始化链路

命令：

```powershell
awbs init
```

发生的事情：

- 如果当前目录不是 Git repo，执行 `git init`。
- 创建 `.awbs/` 基础结构。
- 初始化 `.awbs/authority/repo.json`。
- 生成 `.awbs/private/local.json`。
- 创建 sealed authority catalog。
- 写入 `.awbs/.gitignore`，忽略 index、views、changesets、private。

随后用户需要创建初始 Git commit：

```powershell
git add .
git commit -m "initialize database"
```

AWBS 不自动创建 initial commit，因为初始数据库内容应该由上层应用或用户明确决定。

## 3. Authority Session 链路

命令：

```powershell
'{"recoverySecret":"dev-recovery","controllerToken":"dev-controller"}' |
  awbs authority session start --control-stdin
```

发生的事情：

- host controller 通过 stdin 注入 `recoverySecret` 和 `controllerToken`。
- AWBS 读取 `.awbs/private/local.json`。
- 用 `recoverySecret` 加密 local material，写入 `recovery.seal.json`。
- 启动同用户后台 session daemon。
- 删除磁盘上的 `local.json`。
- key 只保留在 daemon 内存中。

可信写入命令不把 raw `controllerToken` 发给 daemon。CLI 会生成：

```text
controller proof
  = HMAC(controllerToken, requestHash + nonce + createdAt)
```

daemon 会拒绝重复 nonce。可信写入成功响应必须带 response proof，CLI 验证后才承认成功。

## 4. Trusted Chain Bootstrap

命令：

```powershell
'dev-controller' | awbs ledger bootstrap --control-token-stdin
```

前提：

- Git HEAD 存在。
- 工作树干净。
- authority session 可用。
- controller capability 有效。

发生的事情：

- 当前 Git HEAD 被作为 `parentTrustedCommit`。
- authority 创建第一条 ledger entry。
- Git commit 写入 sealed ledger。
- bootstrap commit message 写入 ledger entry id、operation hash 和 parent trusted commit。
- `refs/awbs/trusted` 指向 bootstrap 后的 commit。

从这一刻起，AWBS 认证数据库不再跟着普通 HEAD 自动变化。

## 5. 索引链路

命令：

```powershell
awbs index rebuild
awbs index query [term]
```

发生的事情：

- AWBS 读取并验证 `refs/awbs/trusted`。
- 从 trusted commit 创建临时 Git worktree。
- 扫描 trusted tree，而不是当前污染工作区。
- 写入 `.awbs/index/files.sqlite`。
- 使用 FTS5 索引 path 和 summary。

索引是可重建材料，不是事实源。

## 6. 摘要链路

命令：

```powershell
awbs summary set B/draft.md --text "业务层写入的摘要"
awbs summary get B/draft.md
awbs summary list
```

原则：

- AWBS 永远不内置 AI 摘要。
- AWBS 不保存 AI API key。
- AWBS 不配置模型、提示词或 provider。
- 摘要由上层业务生成后写入 AWBS。

`summary set` 会基于当前 trusted commit 计算目标文件 sha。文件内容变化后，旧 exact summary 不会静默套到新内容上。

## 7. View Projection 链路

命令：

```powershell
'dev-controller' |
  awbs view create --out ..\awbs-workspace --read A --write B --control-token-stdin
```

发生的事情：

- AWBS 读取当前 trusted commit。
- 从 trusted tree 复制 `A/`、`B/` 到 workspace。
- 保持原目录结构，不重命名。
- 保存 baseline 到 `.awbs/views/<viewId>/baseline/`。
- 创建 sealed view contract。
- workspace 中写入 `.awbs-view.json`。

权限事实源不是 workspace 里的 `.awbs-view.json`，而是 sealed view contract。

系统路径永远不能作为业务路径投影：

```text
.git
.awbs
.awbs-view.json
```

大小写变体也会被拒绝。

## 8. Workspace 工作链路

agent 只在 workspace 中工作。它可以：

- 新增允许写路径下的文件。
- 修改允许写路径下的文件。
- 删除允许写路径下的文件。
- 误改只读路径。
- 误建 `.git` / `.awbs` 等保留路径。

AWBS 不阻止 workspace 中出现混乱。AWBS 控制的是：哪些变化可以进入认证数据库。

## 9. Changeset Collect 链路

命令：

```powershell
awbs changeset collect --workspace ..\awbs-workspace
```

发生的事情：

- 读取 workspace `.awbs-view.json` 取得 viewId。
- 回查 sealed view contract。
- 比较 baseline 和 workspace。
- 生成 `.awbs/changesets/<changesetId>/`。
- 写入 `manifest.json`、`diff.patch`、`files/`。
- 计算 `payloadHash` 和 `operationHash`。
- 生成 sealed changeset receipt。

只读路径或保留路径变化会进入 violations，changeset 状态为 `invalid`。

## 10. Changeset Apply 链路

命令：

```powershell
'dev-controller' |
  awbs changeset apply <changesetId> --control-token-stdin
```

apply 前检查：

- authority verify 无 sealed error。
- changeset manifest 完整。
- payload 文件 sha256 匹配。
- payloadHash 匹配。
- operationHash 匹配。
- sealed receipt 匹配 manifest / payload。
- view contract 未撤销。
- changeset baseCommit 等于当前 trusted commit。
- 所有变更都在 writePaths 内。

成功后：

- 将允许的文件变化写入目标 tree。
- authority 记录 changeset apply ledger entry，其中包含 appliedPaths 和 appliedPathStates。
- 修复 mirror。
- Git commit，commit message 写入 ledger entry id、operation hash 和 parent trusted commit。
- 推进 `refs/awbs/trusted`。

如果当前工作区被污染，AWBS 不在污染 HEAD 上继续写，而是从 trusted commit 创建临时 worktree 完成可信 apply。

## 11. Audit 与 Clean Rebuild

命令：

```powershell
awbs db audit
awbs db clean-rebuild
```

`db audit` 报告：

- HEAD 是否等于 trusted commit。
- 工作树是否 dirty。
- 是否存在外部 commits。
- ledger 是否可验证。
- trusted ref 指向的 commit 是否真的匹配 ledger head entry。

`db clean-rebuild`：

- 从 trusted commit 克隆/检出干净目录。
- 复制 `.awbs/private`。
- 校验 authority。
- 原目录整体改名为 backup。
- 干净目录接管原路径。

它不在污染目录里做复杂递归删除，也不自动 purge backup。

## 12. 失败语义

AWBS 初版坚持：

```text
失败不能伪装成功。
```

典型拒绝情况：

- 未启动 trusted chain。
- authority session 不可用。
- controller proof 无效。
- response proof 缺失或无效。
- view 被 revoke。
- changeset 修改只读路径。
- changeset payload 被篡改。
- `refs/awbs/trusted` 被手工指到未被 ledger 解释的 commit。
- 有人复制合法 ledger 但伪造了最终文件内容。
- sealed contract 被篡改。
- base commit stale。
- symlink 触达不明确文件边界。

这些情况会显式失败，保留诊断，不推进 trusted chain。
