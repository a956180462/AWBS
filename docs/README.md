# AWBS 文档目录

这个目录收纳 AWBS 的产品文档、使用文档、设计参考和任务记录。

根目录只保留 `README.md`、`LICENSE`、包配置、源码入口和工程配置；历史设计材料统一放在 `docs/` 下，避免新用户一进入仓库就被任务文档淹没。

## 标准入口

- [标准手册](./MANUAL.md)：基于 003 可信数据链的正式使用、接入和维护手册。
- [产品文档](./PRODUCT.md)：AWBS 是什么、解决什么问题、不解决什么问题。
- [使用文档](./USAGE.md)：从安装、初始化、创建 view 到 apply changeset 的操作手册。
- [全链路文档](./FULL_CHAIN.md)：AWBS 从 init 到 trusted chain 推进的完整数据流。
- [开发学习文档](./DEVELOPMENT_LEARNING.md)：源码分层、关键机制和学习顺序。

## 参考文档

- [当前特性总览](./reference/AWBS_CURRENT_FEATURES.md)：当前系统已实现特性的集中总览。
- [核心设计文档](./reference/AWBS_CORE_DESIGN.md)：核心思想、当前能力、技术架构、索引设计和长期边界。

## 任务记录

- [TASK 001：视图鉴权器](./tasks/TASK_001_VIEW_AUTHORITY.md)
- [TASK 003：可信数据链与可信重建](./tasks/TASK_003_AUTHORITY_LEDGER_AND_DB_AUDIT.md)
- [TASK 004：可信事实层与 Authority Service](./tasks/TASK_004_TRUSTED_AUTHORITY_LAYER.md)
- [TASK 005：A 模式 Authority Session](./tasks/TASK_005_AUTHORITY_SESSION.md)
- [TASK 006：可信边界加固](./tasks/TASK_006_TRUST_BOUNDARY_HARDENING.md)
- [TASK 007：可信操作入口与只读/修复拆分](./tasks/TASK_007_TRUSTED_OPERATION_ENTRY.md)
