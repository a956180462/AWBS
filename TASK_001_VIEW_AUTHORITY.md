# TASK 001: View Authority / 视图鉴权器

## 目标

在 AWBS v0 的工作空间视图机制之上，增加一套视图鉴权器，使每个衍生工作区的读写声明成为可验证、不可篡改、可追溯的视图契约。

本任务不追求操作系统级文件权限，也不做细粒度文件 ACL。它要解决的是 AWBS 自身的写入制度问题：

> 只读路径被修改时，changeset 永远不能自动入仓；如果要修改该路径，必须重新申请一个新的视图，并在新视图中把该路径声明为可写。

本任务也不追求绝对安全边界。它的目标不是让 agent 在理论上永远拿不到签名能力，而是提高 agent 绕过 AWBS 工作流的成本：正常工作空间中没有现成的 key；正常任务链路中不会暴露签名能力；agent 如果要伪造视图契约，必须主动偏离任务、跨越多层实现细节并寻找派生链路。

## 术语说明

本文档中提到的 seal，统一理解为“密封包”或“密封契约”。

它不是一个神秘的新数据库，也不是普通压缩包。它指的是：

> 系统真正读取和信任的那份数据，被加密保存，并且带有完整性校验。明文展示文件可以给人看，但系统不信明文展示文件。

也就是说：

```text
明文镜像
  给人看，可以被重新生成，不作为事实源。

密封包
  给系统信，不能被随便改；一旦被改，解密或校验会失败。
```

## 核心规则

- 每个 view 创建时生成唯一 UUID。
- view 的读写权限形成 view contract。
- view contract 只能由 AWBS View Authority 创建。
- view contract 创建后不可修改。
- view 只允许 create 和 revoke，不允许 update。
- revoke 不应物理删除历史 contract，而应追加撤销事件。
- `changeset collect` 和 `changeset apply` 都必须回查 view contract。
- 只要某个路径不在 contract 的 `writePaths` 中，该路径变化就永远不能 apply。
- 人类审阅不能 override 只读路径修改；要修改只读路径，只能重新创建新 view。

## 建议目录

```text
.awbs/
  authority/
    catalog.seal.json
    catalog.mirror.json
    repo.json
    views/
      <viewId>/
        contract.seal.json
        mirror.json
        receipt.json
    view-events.jsonl

  private/
    local.json
```

`authority/` 应进入 Git，成为长期事实源。

`private/` 必须进入 `.gitignore`，用于保存本地派生材料或运行状态。这里不应保存最终 K，也不应提供一个名为 `authority.key` 的明文钥匙文件。

## Authority Catalog / 鉴权目录总账

001 的 View Authority 不应只记录“某一个 view 的 read/write 权限”。它应该承担更接近数据库 catalog 的职责。

在普通数据库里，系统会知道：

```text
这个数据库有哪些表
每个表有哪些列
每个列是什么类型
哪些结构当前有效
```

AWBS 是文件系统数据库，所以它对应的 catalog 应该记录：

```text
当前数据库有哪些受管理目录
这些目录叫什么名字
目录之间是什么层级关系
每个目录在 AWBS 中的资源身份是什么
每个目录默认是什么权限语义
哪些 view 使用了哪些目录
每个 view 中这些目录分别是 read 还是 write
哪些 view 仍然 active
哪些 view 已经 revoked
```

因此，001 的鉴权器应当维护一份“鉴权目录总账”：

```text
.awbs/authority/catalog.seal.json
  系统真正读取和信任的密封 catalog。

.awbs/authority/catalog.mirror.json
  给人类和工具查看的明文 catalog 镜像，不作为事实源。
```

`catalog.seal.json` 可以理解为 AWBS 文件系统数据库的结构描述和权限描述。它不是业务内容本身，不保存正文、报告、图片或仿真结果；它保存的是 AWBS 对数据库结构、资源和视图权限的认知。

建议 catalog 解密后的逻辑内容包括：

```json
{
  "schemaVersion": 1,
  "repoId": "uuid",
  "catalogVersion": 1,
  "createdAt": "2026-05-20T00:00:00.000Z",
  "resources": [
    {
      "resourceId": "res_A",
      "path": "A",
      "kind": "directory",
      "parent": null,
      "defaultMode": "read"
    },
    {
      "resourceId": "res_B",
      "path": "B",
      "kind": "directory",
      "parent": null,
      "defaultMode": "read"
    }
  ],
  "views": [
    {
      "viewId": "uuid",
      "status": "active",
      "baseCommit": "abc123",
      "readPaths": ["A"],
      "writePaths": ["B"]
    }
  ]
}
```

这里的 `defaultMode` 不是操作系统权限，而是 AWBS 生成 view 时的默认语义。真正某次工作能不能写，仍然以该 view contract 中的 `writePaths` 为准。

catalog 的明文镜像可以被人看，也可以被工具展示；但如果人或 agent 手动修改 `catalog.mirror.json`，不会改变系统行为。系统行为只以 `catalog.seal.json` 解密和校验后的内容为准。

catalog 也不应该随意原地修改。对于结构变化和 view 变化，优先采用事件化记录：

```text
RESOURCE_ADDED
RESOURCE_REMOVED
VIEW_CREATED
VIEW_REVOKED
CATALOG_RESEALED
```

这样未来可以追溯：某个目录什么时候进入 AWBS 管理，某个 view 什么时候创建，什么时候撤销。

001 的具体 JSON 字段由实现固定，后续不应随意改名或改语义。为了保留演化空间，catalog、view contract 和 receipt 都应保留 `ext` 字段，用于未来扩展非核心信息。

## 视图契约

视图契约的逻辑内容应当可以通过明文镜像查看，便于审计和排错。但系统不应直接信任明文镜像。真正的不可篡改性由密封契约保证。

示例：

```json
{
  "schemaVersion": 1,
  "viewId": "uuid",
  "baseCommit": "abc123",
  "createdAt": "2026-05-19T00:00:00.000Z",
  "status": "active",
  "readPaths": ["A"],
  "writePaths": ["B"],
  "sources": [
    {
      "path": "A",
      "sha256": "...",
      "mode": "read"
    },
    {
      "path": "B",
      "sha256": "...",
      "mode": "write"
    }
  ]
}
```

## 密封视图契约

在进一步设计中，AWBS 可以把 view contract 分成两个层次：

```text
sealed contract
  系统真正读取和信任的密封契约。

mirror contract
  给人类和工具查看的明文镜像，不作为事实源。
```

建议目录：

```text
.awbs/
  authority/
    views/
      <viewId>/
        contract.seal.json
        mirror.json
        receipt.json
```

其中：

- `contract.seal.json` 是真正的视图契约事实源。
- `mirror.json` 是展示缓存，可以被系统从 seal 重新生成。
- `receipt.json` 保存非敏感元信息，例如 viewId、算法版本、创建时间、contract hash。

系统规则：

- `changeset collect` 和 `changeset apply` 永远读取 `contract.seal.json`。
- `mirror.json` 只用于展示，不参与权限判断。
- 人类或 agent 修改 `mirror.json` 没有写入效果。
- 如果 `mirror.json` 与 seal 解出的 contract 不一致，系统应报告 mirror drift，或者用 seal 自动重建 mirror。
- 001 默认采用自动重建策略：一旦发现 mirror drift，系统直接用密封契约解出的真实内容覆盖 mirror。
- 如果 `contract.seal.json` 被修改，解密或认证应失败，该 view 立即不可用。
- seal 损坏后，如果 Git 历史中有未损坏版本，可以通过 Git 恢复。

密封契约不应只是普通加密，而应使用带完整性认证的加密方式，例如：

```text
sealed = AES-256-GCM(K, canonical_json(view_contract), aad)
```

或：

```text
sealed = ChaCha20-Poly1305(K, canonical_json(view_contract), aad)
```

这里的 `aad` 是不加密但参与认证的上下文，例如：

```text
viewId
repoId
schemaVersion
baseCommit
algorithmVersion
```

这样，密文或认证上下文只要被改动，验证就会失败。系统不能在失败时 fallback 到 `mirror.json`。

这套设计的核心是：

> 明文给人看，密文给系统信。

它不宣称强安全隔离，而是提高 agent 绕过 AWBS 视图契约的成本。agent 想伪造权限，不能只改一个明文 JSON；它必须主动理解 sealed contract 的格式、密钥派生链、canonical JSON、AEAD 算法和本机派生材料。

## 签名与密封机制

v1 可以先采用 HMAC-SHA256 作为完整性校验基础。如果采用密封契约，则在此基础上使用带认证的加密方式，例如 AES-256-GCM。

```text
K = derive_authority_key(repo_context, local_context, runtime_context)
signature = HMAC_SHA256(K, canonical_json(view_contract))       # 签名模式
sealed = AES-256-GCM(K, canonical_json(view_contract), aad)     # 密封模式
```

其中：

- `K` 是运行时派生出来的签名 key，不落盘保存。
- `repo_context` 来自 `.awbs/authority/repo.json`，例如 `repoId`、`authoritySalt`、算法版本。
- `local_context` 来自仓库外或 `.awbs/private/local.json` 中的本机材料，不进入 Git，也不投影到 workspace。
- `runtime_context` 来自 AWBS authority 的内部实现和运行环境。
- `view_contract` 是视图契约的逻辑内容。
- 在签名模式中，`view_contract` 可以明文进入 Git，并由 `.sig` 校验。
- 在密封模式中，系统信任的是 `contract.seal.json`，明文 `mirror.json` 只是展示缓存。
- `canonical_json` 是稳定序列化后的 JSON，避免字段顺序或空格变化影响签名。
- `.sig` 文件或 seal envelope 保存算法、key id、contract hash、nonce、认证 tag 等必要元信息。

这套机制不是强安全边界，而是高摩擦鉴权机制。只要 agent 拥有与 authority 完全相同的本机读写和执行权限，并且主动寻找所有派生材料和派生逻辑，它理论上可以复现 K。AWBS v1 的目标是让这种行为不出现在正常 agent 工作流中，而不是宣称本地同权限强 agent 永远无法破解。

后续如果需要多人协作或跨机器验证，可以升级为 Ed25519 非对称签名：

```text
private key 签名
public key 验证
```

## 验证流程

创建 view 时：

```text
生成 viewId
生成 view contract
authority 在内存中派生 K
使用 K 对 contract 进行签名或密封
写入 .awbs/authority/views/<viewId>/contract.seal.json
写入 .awbs/authority/views/<viewId>/mirror.json
更新 catalog.seal.json
更新 catalog.mirror.json
追加 VIEW_CREATED 事件
copy 生成 workspace
workspace/.awbs-view.json 只记录 viewId 和展示信息
```

收集 changeset 时：

```text
读取 workspace/.awbs-view.json 得到 viewId
读取 authority/views/<viewId>/contract.seal.json
解密并认证 sealed contract
回查 catalog.seal.json
确认 view 未被 revoke
使用 contract 中的 writePaths 判断每个 change 是否 allowed
```

应用 changeset 时：

```text
读取 changeset manifest
根据 viewId 回查 view contract
再次解密并认证 sealed contract
再次回查 catalog.seal.json
再次检查每个 change.path 是否在 writePaths 中
若存在只读路径变化，永远拒绝 apply
若 view 已 revoke，拒绝 apply
```

## 被篡改时的行为

如果 `authority/views/<viewId>/contract.seal.json` 被人手动修改：

- 解密或认证失败。
- 该 view 进入不可用状态。
- 基于该 view 的 workspace 不能 collect 出可用 changeset。
- 基于该 view 的 changeset 不能 apply。
- 系统应明确报错，不得伪装成功。

如果 `authority/views/<viewId>/mirror.json` 被人手动修改：

- 不改变系统行为。
- 系统发现 mirror drift 后，应直接用密封契约重新生成 mirror。
- collect/apply 不能 fallback 到 mirror。

如果 Git 历史中有未被篡改的旧版本，可以通过 Git 恢复该 contract 文件。

如果本地派生材料丢失：

- 可能导致旧签名无法继续验证。
- 应视为本机 authority 损坏或迁移不完整。
- 可以从备份恢复本地派生材料，或执行明确的 authority rotate / reissue 流程。

如果 agent 主动找到全部派生材料和派生逻辑：

- 它可能复现 K。
- 这属于同权限强 agent 绕过流程，不是 AWBS v1 要宣称完全防住的范围。
- 后续如果要继续提高强度，应将 authority 移到 agent 无法直接读取的进程、用户、服务或机器边界之外。

## v1 实现边界

- 不实现操作系统只读属性。
- 不实现文件级 ACL。
- 不实现人类 override。
- 不允许 update view contract。
- 只实现 create / revoke / verify。
- collect 和 apply 都必须 verify。
- apply 不能只相信 changeset 自己的 `status` 字段，必须重新按 contract 验证。
- 不保存最终 K。
- 不把 authority 派生材料投影到 workspace。
- 不把签名能力暴露给普通 agent 命令链路。

## Revoke 边界

撤销 view 只改变这个 view 未来是否还能作为工作入口和写入依据，不处理任何历史数据。

也就是说：

- 不删除旧 workspace。
- 不删除旧 changeset。
- 不回滚已经 apply 的 changeset。
- 不修改 Git 历史。
- 不删除或修改已经入仓的数据。

这和 SQL 删除 view 不会删除底层 table 是同一个道理。view 是访问视图，不是数据本体。撤销 view 只意味着：

```text
以后基于该 view 的 collect / apply 必须拒绝。
如果还要继续工作，必须重新创建一个新的 view。
```

## 当前实现状态

001 已按第一版落地为可运行 CLI 能力。

已完成：

- `awbs init` 初始化 `.awbs/authority` 和 `.awbs/private/local.json`。
- `awbs view create` 创建 UUID view，并写入密封视图契约、明文镜像、receipt 和鉴权目录总账。
- `awbs view inspect <viewId>` 读取密封契约并展示 view 状态。
- `awbs view revoke <viewId>` 通过更新鉴权目录总账撤销 view。
- `awbs authority verify` 验证 catalog 和所有 view contract，并自动修复 mirror drift。
- `awbs authority repair-mirrors` 从密封包重建所有明文镜像。
- `changeset collect` 不再信任 workspace manifest 的权限字段，而是回查密封 view contract。
- `changeset apply` 再次回查密封 view contract，并重新判断每个变更是否落在 writePaths 内。
- `changeset apply` 会验证 authority 状态，并把合法的 `.awbs/authority` 变更一起纳入 Git commit。

测试已覆盖：

- view 创建后 authority 文件齐全。
- workspace `.awbs-view.json` 被改写也不能扩大权限。
- view `mirror.json` 被修改后会自动从密封契约重建。
- `contract.seal.json` 被篡改后 collect/apply 失败。
- 只读路径修改产生 invalid changeset，不能 apply。
- view revoke 后，后续 collect/apply 拒绝。
- 已经 apply 的数据不会因为 revoke 被回滚或删除。
- authority verify / repair-mirrors 能检查并修复明文镜像。

## 后续索引与摘要接口补充

001 完成后，索引层又补了一次边界拆分，并在 002 中升级为磁盘 SQLite + FTS5：

- 索引查询走嵌入式磁盘 SQLite。
- 索引持久文件是 `.awbs/index/files.sqlite`。
- FTS5 索引 `path` 和 `summary`。
- 旧 `.awbs/index/files.jsonl` 只作为 v0 迁移输入使用。
- 摘要不由 AWBS 内置 AI 模型生成。
- AWBS 只提供摘要读写接口，由外部业务应用或 agent 写入摘要。

新增 CLI：

```text
awbs summary set <path> --text <summary>
awbs summary set <path> --file <file>
awbs summary get <path> [--json]
awbs summary list [--json]
```

外部摘要保存在：

```text
.awbs/summaries/files.jsonl
```

`index rebuild` 会优先使用外部摘要；没有外部摘要时，只生成机械 fallback 摘要，不在底座里伪装业务理解。
