# AWBS 使用文档

本文档面向想直接试用 AWBS CLI 的用户。

## 1. 环境要求

需要：

- Node.js `>=24.0.0`
- Git
- 一个可以运行 shell 命令的终端

查看版本：

```powershell
node --version
git --version
```

## 2. 安装

从 npm 安装：

```powershell
npm install -g awbs
awbs --help
```

从本地 checkout 安装：

```powershell
npm install -g .
awbs --help
```

开发时直接运行：

```powershell
node src\cli.ts --help
npm run awbs -- --help
```

## 3. 初始化数据库

进入一个项目目录：

```powershell
mkdir my-awbs-db
cd my-awbs-db
```

初始化 AWBS：

```powershell
awbs init
```

创建一些业务目录：

```powershell
mkdir A
mkdir B
"read only context" | Set-Content A\context.md
"first draft" | Set-Content B\draft.md
```

创建初始 Git commit：

```powershell
git add .
git commit -m "initialize database"
```

如果 Git 还没有用户名和邮箱，需要先配置：

```powershell
git config user.name "AWBS User"
git config user.email "awbs@example.test"
```

## 4. 启动 Authority Session

开发试用时可以用简单字符串。正式应用中，`recoverySecret` 和 `controllerToken` 应由上层应用的非 AI 控制层管理。

```powershell
'{"recoverySecret":"dev-recovery","controllerToken":"dev-controller"}' |
  awbs authority session start --control-stdin
```

检查状态：

```powershell
awbs authority session status
```

## 5. 启动 Trusted Chain

```powershell
'dev-controller' | awbs ledger bootstrap --control-token-stdin
```

检查 ledger：

```powershell
awbs ledger inspect
awbs ledger verify
```

## 6. 建立索引

```powershell
awbs index rebuild
awbs index query
awbs index query draft
```

输出来自 `.awbs/index/files.sqlite`。索引可删除重建，不是事实源。

## 7. 写入外部摘要

AWBS 不生成 AI 摘要。摘要由上层业务写入。

```powershell
awbs summary set B/draft.md --text "A draft document owned by the business layer."
awbs summary get B/draft.md
awbs summary list
awbs index rebuild
awbs index query business
```

## 8. 创建工作空间视图

创建一个 workspace：

```powershell
'dev-controller' |
  awbs view create --out ..\my-awbs-workspace --read A --write B --control-token-stdin
```

含义：

- `A` 被投影进 workspace，但只读。
- `B` 被投影进 workspace，可写。
- workspace 保持原目录结构。

查看 view：

```powershell
awbs view inspect <viewId>
```

## 9. 在 workspace 中工作

修改可写目录：

```powershell
"second draft" | Set-Content ..\my-awbs-workspace\B\draft.md
```

如果修改只读目录，例如：

```powershell
"changed context" | Set-Content ..\my-awbs-workspace\A\context.md
```

AWBS 不会阻止你在 workspace 中这么做，但 collect 后 changeset 会是 invalid，apply 会拒绝。

## 10. 收集 Changeset

```powershell
awbs changeset collect --workspace ..\my-awbs-workspace
```

输出类似：

```text
Changeset collected: changeset_...
Status: valid
```

查看：

```powershell
awbs changeset inspect <changesetId>
awbs changeset inspect <changesetId> --json
```

## 11. 应用 Changeset

```powershell
'dev-controller' |
  awbs changeset apply <changesetId> --control-token-stdin
```

成功后：

- 文件写回 AWBS 数据库。
- Git 创建 commit。
- trusted chain 前进。
- `refs/awbs/trusted` 更新。

## 12. 撤销 View

```powershell
'dev-controller' |
  awbs view revoke <viewId> --control-token-stdin
```

撤销只影响未来 collect/apply，不删除旧 workspace，不删除已提交数据，不改 Git 历史。

## 13. 审计数据库

```powershell
awbs db audit
```

它会报告：

- 当前 HEAD。
- trusted commit。
- 工作树是否 dirty。
- 是否存在外部 commit。
- authority / ledger 是否可验证。

## 14. 从 Trusted Chain 重建干净数据库

如果普通工作区被污染，可以执行：

```powershell
awbs db clean-rebuild
```

注意：

- 运行前需要停止 authority session。
- 原目录会被整体改名为 backup。
- 干净目录从 trusted commit 重建。
- backup 不会自动删除。

停止 session：

```powershell
'dev-controller' | awbs authority session stop --control-token-stdin
```

## 15. Session 崩溃恢复

如果 session daemon 崩溃，`local.json` 不存在，但 `recovery.seal.json` 仍在：

```powershell
'dev-recovery' | awbs authority session recover --recovery-secret-stdin
```

错误 recovery secret 会失败，不会写出伪成功文件。

## 16. 常用命令总览

```text
awbs init
awbs index rebuild
awbs index query [term] [--status active|removed|all] [--json]
awbs summary set <path> (--text <summary> | --file <file>)
awbs summary get <path> [--json]
awbs summary list [--json]
awbs view create --out <workspace> [--read A] [--write B] --control-token-stdin
awbs view inspect <viewId> [--json]
awbs view revoke <viewId> --control-token-stdin
awbs changeset collect --workspace <workspace>
awbs changeset inspect <changesetDir|id> [--json]
awbs changeset apply <changesetDir|id> --control-token-stdin
awbs ledger bootstrap [--json] --control-token-stdin
awbs ledger inspect [--json]
awbs ledger verify [--json]
awbs db audit [--json]
awbs db clean-rebuild [--json]
awbs db backups list [--json]
awbs authority session start --control-stdin [--json]
awbs authority session status [--json]
awbs authority session stop --control-token-stdin [--json]
awbs authority session recover --recovery-secret-stdin [--json]
awbs authority verify [--json]
awbs authority repair-mirrors --control-token-stdin [--json]
```

## 17. 发布前检查

开发者发布前建议运行：

```powershell
npm test
node src\cli.ts --help
npm pack --dry-run
git diff --check
```
