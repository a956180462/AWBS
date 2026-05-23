# AWBS 产品文档

AWBS 是 **Agent Work Base Space** 的缩写。

一句话定位：

```text
AWBS 是面向 agent 工作流的文件系统数据库底座。
```

它把普通文件系统作为数据库主体，把 Git 作为版本管理器，把某一步工作需要的文件投影成独立工作空间，再用 changeset 和 trusted authority layer 控制哪些变更能进入认证数据库。

## AWBS 解决什么问题

传统应用常常假设：

- 数据结构稳定。
- 表结构清晰。
- 写入入口固定。
- 用户行为可枚举。

但 agent 工作流经常不是这样：

- 输入开放。
- 文件类型复杂。
- 任务上下文不断变化。
- agent 可能读写大量文件。
- 上层业务不一定能提前设计好所有表结构。

AWBS 解决的是：

```text
如何让 agent 在一个明确的工作空间里工作，
并把它的产出以可审计、可拒绝、可重放的方式写回文件系统数据库。
```

## AWBS 不是什么

AWBS 不是：

- 沙箱系统。
- 操作系统权限系统。
- 传统 SQL 数据库。
- AI 摘要服务。
- 模型调度框架。
- workflow 编排器。

AWBS 不阻止人或程序直接修改磁盘文件。它只定义 AWBS 自己承认的数据库事实链。

## 核心产品概念

### 文件系统数据库

业务数据就是普通目录和普通文件。

```text
project/
  A/
  B/
  assets/
  reports/
```

AWBS 不规定业务目录应该怎么组织。上层应用可以按小说、仿真、文档、代码、素材等业务自由设计目录。

### Git 版本管理

Git 保存文件历史、diff、commit 和 tree。

AWBS 不重新发明文件版本系统，而是借用 Git 已经成熟的能力。

### 工作空间视图

某一步工作不一定需要看到整个数据库。

AWBS 可以创建 copy-based workspace view：

```text
database trusted commit
  -> selected paths
  -> workspace
```

agent 在 workspace 中工作。workspace 可以混乱，但正式写回必须经过 changeset。

### Changeset

changeset 是 AWBS 的最小变更单元。

它包含：

- manifest。
- diff。
- payload files。
- payloadHash。
- operationHash。
- sealed receipt。

增、删、改都统一为 changeset。

### Trusted Authority Layer

AWBS 认证数据库不等于普通 Git HEAD。

AWBS 认证数据库等于：

```text
refs/awbs/trusted
+ sealed authority ledger
```

只有 authority 承认的 changeset apply 才能推进 trusted chain。

### Authority Session

A 模式 authority session 会把本机 key 从磁盘移到后台 daemon 内存中。

可信写入必须由 host controller 提供 controller capability。

普通 workflow agent 可以生成请求和 changeset，但不能直接推进 AWBS 可信事实。

## 当前已实现能力

当前初版已经实现：

- CLI 初始化。
- Git repo 初始化。
- 磁盘 SQLite + FTS5 索引。
- 外部摘要读写接口。
- copy-based view create / inspect / revoke。
- sealed view contract。
- changeset collect / inspect / apply。
- read/write path 权限判断。
- readonly violation 拒绝 apply。
- changeset payload 防篡改。
- hash-linked trusted ledger。
- `refs/awbs/trusted` 可信链头。
- authority verify / repair-mirrors。
- A 模式 authority session。
- controller proof / response proof。
- db audit。
- db clean-rebuild。
- npm CLI 包形态。

## 典型用户

AWBS 适合：

- 想让 agent 处理复杂项目文件的人。
- 想把“文件系统作为数据库”产品化的人。
- 需要 agent 分步读写上下文的工具作者。
- 小说、仿真、文档、代码、素材等混合型工作流系统。
- 想研究 agent trusted workflow 的开发者。

AWBS 不适合：

- 只需要简单 CRUD 表单的系统。
- 需要强隔离安全沙箱的系统。
- 需要高并发 OLTP 的业务数据库。
- 希望内置 AI 摘要或模型服务的应用。

## 产品边界

长期边界：

- AWBS 永远不内置 AI 摘要。
- AWBS 不规定业务目录结构。
- AWBS 不默认兼容开发期旧仓库，除非明确开 migration 任务。
- AWBS 不把普通 Git HEAD 当作认证数据库。
- AWBS 不承诺对抗 admin/root。

## 当前阶段

当前阶段可以称为：

```text
AWBS v0 trusted CLI prototype
```

它已经能作为公开初版发布、学习和试用。

后续方向包括：

- workflow / run / step 记录层。
- 更强的 Authority Service。
- OS keychain / 独立 OS 身份的 B 模式。
- 更多业务写回策略和视图投影策略。
- 更好的包发布和版本化流程。
