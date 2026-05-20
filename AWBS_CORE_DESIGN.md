# AWBS 核心设计文档

AWBS 是 Agent Work Base Space 的缩写，指面向 agent 工作流的基础工作空间系统。

## 1. 系统定性

AWBS 的设计核心，应当类似于 SQL 之于传统数据库系统：它不是某一个具体业务的文件组织规范，而是一个更底层的数据库式能力集合。

SQL 不要求业务必须如何设计自己的表、字段、关系和状态流转；同样，AWBS 也不要求业务必须如何组织自己的项目目录、文档、资产、职责边界和产物位置。每个业务如何思考自己的数据应该存到哪里、不应该存到哪里、什么时候存、以什么形式存，都是业务自己的事情，不是 AWBS 底座要替它决定的事情。

AWBS 要提供的是面向文件系统数据库的基础能力。它仍然可以类比为传统数据库里的增删改查，但在文件系统和 Git 的语境下，增、删、改这三件事应当收束成同一个写入概念：变更集，也就是 diff。

对文件资源来说：

- 新增文件，是 diff 中出现了新路径。
- 删除文件，是 diff 中移除了已有路径。
- 修改文件，是 diff 中改变了已有路径的内容。

因此，AWBS 的写入侧不需要分别设计三套机制来处理增、删、改，而应当统一为一套围绕 diff 的变更处理能力。Git 已经非常擅长描述、比较、记录和回放这种文件变更，AWBS 应当优先复用 Git 的这一能力。

这里的 diff 指的是文件系统层面的变更集。对于文本文件，Git 可以提供较细的内容级差异；对于图片、音频、视频、压缩包、二进制表格等非文本或复杂格式文件，Git 仍然可以表达文件的新增、删除和整体变化，但不负责解释文件内部语义。这种内部语义解析不是 AWBS 底座必须承担的问题，应当由具体业务或专用工具在需要时自行处理。

与之相对，AWBS 的读取侧则主要体现为查询和视图生成：

- 查询：从已有文件系统和运行记录中找到某一步工作需要的文件资源。
- 视图：把查询结果组合、整理并物化成某个 agent 工作步骤可以直接使用的工作空间。

AWBS 的底层存储基于标准文件系统。它不要求业务把内容塞进某种专有数据库，也不要求业务先把文件转换成统一格式。无论是文档、源码、配置、图片、表格、仿真结果、报告，还是其他类型的资产，它们首先都是文件系统中的文件和目录。

AWBS 的主要管理方式基于 Git。Git 对文档、源码和文件资产的版本管理、差异比较、历史记录、分支协作和回退能力已经非常成熟，AWBS 应当优先复用这些能力，而不是重新发明一套平行的版本系统。

因此，AWBS 可以被定性为：

> 一个基于标准文件系统和 Git 的、面向 agent 工作流的文件系统数据库底座。

它的核心能力不是规定业务文件应该长什么样，而是为业务项目提供一套稳定的输入、输出、查询、写入和工作空间视图生成机制，使普通 agent、强 agent、脚本工具或人类操作者，都可以围绕同一套文件事实源进行工作。

在 AWBS 语境中，可以把由文件系统和 Git 共同管理的后端存储整体称为数据库。这个数据库不是传统 SQL 数据库，而是由目录、文件、Git 历史和 AWBS 元数据共同构成的文件系统数据库。

## 2. 为什么需要文件系统数据库

AWBS 不是因为传统数据库不好才选择文件系统，而是因为 agent 工作流面对的是开放输入、开放产物和开放任务形态。

传统 SQL 数据库适合结构清晰、关系稳定、功能边界相对确定的业务系统。例如人员管理、订单管理、内容平台、交互功能明确的产品系统，都可以通过表、字段、关系、索引和迁移来持续演化。它们的复杂度很高，但业务动作和数据结构通常仍然可以被稳定建模。

agent 工作流面对的问题不同。它可能处理小说灵感、章节草稿、仿真配置、实验结果、运行日志、报告、源码、图片、表格、临时想法、混合题材、跨项目材料和各种尚未形成稳定结构的工作产物。今天进入系统的是一段话，明天可能是一组实验文件，后天可能是多个题材、多个版本、多个运行结果混在一起的材料。

如果强行把这些东西过早塞进结构化表，系统很容易腐烂。尤其是大量 JSON 大字段或临时扩展字段，短期看起来灵活，长期会变成难以理解、难以查询、难以维护、难以给 AI 使用的半结构化黑箱。

对 agent 来说，文件系统反而是更自然的上下文形态。agent 可以直接阅读目录、文件名、说明文档、输入材料和输出产物；强 agent 可以在目录中运行工具；小 agent 也可以通过 host 系统拿到命名文件资源。文件系统保留了开放性，而 Git 又提供了成熟的版本管理能力。

因此，AWBS 的定位不是替代 SQL 的所有场景，而是为传统数据库难以稳定建模的 agent 工作流，提供一种基于文件系统和 Git 的数据库底座。

## 3. 工作空间视图与隔离

AWBS 查询数据之后，不应当直接让 agent 在数据库本体中工作，而应当生成一个独立的工作空间视图。

这个工作空间视图可以理解为数据库视图的文件系统版本：它不是完整复制整个数据库，而是根据上层业务或 workflow step 的请求，把本次工作需要的文件、目录和说明材料组织成一个独立的工作目录。

第一版实现应当优先采用 copy 方式生成工作空间视图。也就是说，AWBS 从数据库中把本次视图需要的文件复制到工作目录中，agent 只在这个复制出来的目录里工作。

这样做的核心原因是隔离。工作空间视图必须和数据库本体分开，避免 agent 在工作过程中直接污染后端存储。即使后续为了性能引入 hardlink、reflink、sparse checkout 或其他优化，也必须保持“agent 工作目录不直接等于数据库本体”的设计原则。

第一版工作空间视图应当保持朴素：上层业务指定需要复制哪些目录或文件，AWBS 按原有目录结构复制到目标工作空间中。稳定运行阶段不应默认做路径重命名、目录改名或复杂结构变形。

这条原则很重要。AWBS 的数据库本体应当像稳定运行的数据库 schema 一样被尊重：开发阶段可以调整结构，但稳定运行后，不应让工作空间视图随意改变底层目录语义。第一版视图生成的重点不是发明一套复杂映射语言，而是可靠地把业务指定的文件和目录 copy 出来。

例如，数据库根目录下有：

```text
A/
B/
C/
D/
E/
F/
```

上层业务请求 `A + B`，AWBS 就生成：

```text
workspace/
  A/
  B/
```

上层业务请求 `B + C + D`，AWBS 就生成：

```text
workspace/
  B/
  C/
  D/
```

这就是第一版工作空间视图的基本语义：选择、复制、保持结构。

## 4. 变更包

AWBS 的写入侧不应当直接把 agent 工作目录中的内容写回数据库，而应当先生成一个变更包。

变更包是对 Git diff 的二次打包。它不只是一个裸 diff 文件，而是一次数据库变更所需要的全部材料集合。

一个变更包至少应当包含：

- 本次工作基于的数据库版本，例如 Git commit、文件 hash 或视图 manifest。
- 工作空间视图的生成记录，包括本次视图包含哪些源文件、这些源文件被放到了工作目录中的什么位置。
- 文本文件的可读 diff。
- 新增文件、修改后文件或二进制文件的实际文件内容。
- 删除、移动或重命名的路径记录。
- agent 或执行者的运行记录、说明和必要元数据。

因此，AWBS 对数据库的写入可以理解为：

```text
工作空间视图
  -> agent 工作
  -> 收集差异
  -> 生成变更包
  -> 交给业务层决定如何进入数据库
```

变更包表达的是“这次工作对数据库提出了什么变更”。至于这些变更最终如何解释、如何放置、是否进入业务自己的目录结构，应当由上层业务决定。

## 5. 如何存入数据

AWBS 的存入数据，本质上不是“把某个业务对象写入某张表”，而是把一次文件系统变化整理成变更包，并让这个变更包进入文件系统数据库。

在 AWBS 中，数据库由业务文件、AWBS 元数据和 Git 历史共同构成。因此，存入数据可以分成两个层次：

1. 业务层决定数据应该成为哪些文件、目录和元数据。
2. AWBS 负责把这些文件系统变化组织成可追踪、可记录、可提交的变更包。

最常见的存入流程是：

```text
生成工作空间视图
  -> agent / 脚本 / 人类操作者在视图中工作
  -> AWBS 比较视图初始状态和完成状态
  -> AWBS 生成变更包
  -> 业务层解释变更包并决定写入位置
  -> 文件系统数据库发生变化
  -> Git 记录这次变化
```

这里的关键是，AWBS 不直接规定产物应该写到业务项目的哪个目录。比如同一个 `outputs/result.md`，在小说项目中可能被收纳为章节草稿，在仿真项目中可能被收纳为实验报告，在代码项目中可能被收纳为设计文档。这个解释过程属于业务层。

AWBS 需要保证的是：

- 能记录这次工作基于哪个数据库版本。
- 能记录工作空间视图是如何生成的。
- 能收集工作前后的文件差异。
- 能把新增、删除、修改、移动等变化统一表达为变更包。
- 能把变更包交给业务层处理。
- 能在数据库实际变化后，通过 Git 留下版本记录。

因此，AWBS 的写入模型可以概括为：

```text
写入 = 变更包 + 业务解释 + Git 记录
```

其中，变更包是 AWBS 的通用写入载体；业务解释决定这些变化如何进入具体项目；Git 负责保存最终进入数据库的文件变化历史。

## 6. 如何查询数据

AWBS 的查询数据，也不是查询某个固定业务表，而是从文件系统数据库中找到某个工作步骤需要的文件资源，并把这些资源组织成工作空间视图。

AWBS 的查询应当建立在两层之上：

```text
文件系统 + Git
  事实源，保存真实文件、目录和历史。

索引层
  可重建的查询加速层，例如 SQLite、全文索引、摘要索引或其他文件索引。
```

索引层不是事实源。它可以被删除、重建、更新和替换。它的职责是让 AWBS 更快地知道数据库里有哪些文件、这些文件大致是什么、它们属于哪些资源、最近如何变化，以及它们能否被某个 workflow step 使用。

一个基础文件索引可以记录：

- 文件路径。
- 文件类型。
- 文件大小。
- 修改时间。
- 文件 hash。
- 所属 Git commit 或最后变更记录。
- 资源名称或资源集合。
- 标签、注释和业务元数据。
- 文件摘要。

其中，文件摘要很重要。因为 AWBS 的查询结果最终经常要提供给 AI 使用，AI 不一定应该直接读取整个数据库。索引中可以保存“这个文件是什么”的摘要，帮助上层应用或 agent 在生成工作空间视图之前先进行选择。

查询流程可以概括为：

```text
上层应用提出查询请求
  -> AWBS 查询索引层
  -> AWBS 找到候选文件和资源
  -> AWBS 回到文件系统事实源确认实际文件
  -> AWBS 按视图要求 copy 文件
  -> AWBS 生成工作空间视图
  -> AWBS 写入视图 manifest
```

查询结果不应该只是返回一组路径。对于 agent 工作流来说，更重要的结果是一个已经生成好的工作目录。

例如，文件系统数据库中有：

```text
A/
B/
C/
D/
E/
F/
```

上层业务可以请求不同的工作空间视图：

```text
view_ab   = A + B
view_ad   = A + D
view_bcd  = B + C + D
view_bdf  = B + D + F
view_bde  = B + D + E
```

AWBS 根据这些视图请求，只把对应文件和目录 copy 到目标工作空间中。agent 看到的不是完整数据库，而是本次工作需要的那一部分文件系统视图。

因此，AWBS 的读取模型可以概括为：

```text
查询 = 文件索引检索 + 文件系统确认 + 工作空间视图生成
```

## 7. 索引与摘要如何建立

AWBS 的索引层分成两类能力：基础文件索引和摘要读写接口。

基础文件索引负责记录文件系统中客观存在的信息，例如路径、类型、大小、修改时间、hash、所属 Git commit 和当前状态。这类索引由系统扫描文件系统和 Git 自动建立，属于可重建查询层，不是事实源。

摘要负责记录“这个文件或目录大致是什么”。但 AWBS 不在底座里配置 AI 模型、API 地址或密钥，也不替业务理解文件语义。AWBS 只提供摘要读写接口，摘要内容由上层业务应用、外部 agent 或人类工具生成后写入。

因此，AWBS 的索引系统可以理解为：

```text
基础索引
  文件系统和 Git 自动扫描生成。

摘要接口
  AWBS 提供读写能力。
  上层业务负责生成和写入摘要。

业务注释
  由业务层决定是否写成元数据文件。
```

索引层仍然不能替代文件系统数据库本体。它负责让查询更快、更适合 agent 使用，但数据库真实内容仍然是文件、目录和 Git 历史。

当前索引至少包含三个核心信息：

- 摘要：说明这个文件、目录或资源大致是什么，主要供 agent 和上层应用查询上下文。
- 版本号：记录这条索引关联的是哪一次 Git commit，或者说它是基于数据库的哪个版本生成的。
- 是否废弃：记录这个文件或资源在当前数据库版本中是否仍然存在。

这里的“废弃”不是指从 Git 仓库历史中彻底消失。Git 的能力之一就是保留历史版本。一个文件即使在后续提交中被删除，它仍然可以通过 Git 历史找回。因此，AWBS 的索引不应简单丢弃这些历史文件记录，而应当把它们标记为当前版本中已移除。

可以理解为：

```text
active
  当前数据库版本中仍然存在。

removed
  当前数据库版本中已经不存在，但 Git 历史中仍然可追溯。
```

## 8. 读写声明与变更处理

工作空间视图不只是复制一组文件，它还应当带有本次工作的读写声明。

读写声明描述本次工作空间中哪些文件或目录只是输入材料，哪些文件或目录允许产生变化。它不是业务内容判断，也不是替业务决定文件应该如何组织，而是本次工作视图的操作约束。

例如，数据库中有：

```text
A/
B/
```

某次工作请求生成 `A + B` 视图，但声明：

```text
A/ 只读
B/ 可写
```

那么 agent 仍然可以在复制出来的工作空间中看到 `A/` 和 `B/`，但 AWBS 在收集变更包时会检查变化是否落在可写范围内。如果变更包中出现了对 `A/` 的修改，系统不能把它当成正常写入。

不同业务可以选择不同处理方式：

- 宽松模式：忽略只读范围内的变化，只收集可写范围内的变化。
- 严格模式：只要出现只读范围变化，就标记本次变更包不可接受。
- 审阅模式：保留完整变更包，但要求业务层或人类操作者确认如何处理。

这里的关键不是阻止 agent 在临时目录中产生任何文件变化，而是 AWBS 必须能够识别这些变化是否符合本次工作声明。agent 可能在工作中误改输入材料、误写不该写的目录，AWBS 需要把这种情况显式记录下来，而不是让它悄悄污染数据库。

因此，工作空间视图至少需要记录：

```text
本次视图包含哪些源文件和目录
每个源文件和目录在工作空间中的位置
哪些路径是只读输入
哪些路径是可写输出或可修改区域
本次视图基于哪个数据库版本
```

变更包生成时，AWBS 根据这个声明判断每一项变化属于正常写入、越界变化、还是需要业务层解释的特殊变化。

## 9. 并发与单线生长

AWBS 面向文件系统数据库，因此必须定义并发写入规则。

读取可以并发。多个工作空间视图可以同时从同一个数据库版本或相近版本生成，只要它们只是读取文件，就不会破坏数据库本体。

写入不能无序并发。对同一个逻辑目录、资源或业务对象的修改，必须按单线顺序进入数据库。也就是说，一个工作空间基于某个版本生成之后，它的变更包如果要写回数据库，必须确认目标资源没有在这期间被其他变更先行修改。

可以概括为：

```text
同一目标资源：
  先生成视图
  -> 完成工作
  -> 提交变更包
  -> 写入完成
  -> 后续工作再基于新版本生成视图
```

AWBS 不鼓励在同一个目录或资源上形成隐式多分支生长。因为一旦同一个 `B/` 在两个不同工作空间中各自修改，并且都试图作为 `B/` 写回，就会引入复杂合并问题。AWBS 的底座原则应当是单线、单次、单一生长。

如果业务确实需要多个方向并行发展，那么它不应当在同一个 `B/` 上制造隐式分支，而应当显式派生新的目录或资源。例如：

```text
B/
B_variant_alpha/
B_variant_beta/
```

或者由业务定义其他命名方式。这个动作类似于数据库设计中的新增表、新增列或 schema 演化：它是显式的业务结构变化，而不是 AWBS 在写入时偷偷帮业务合并分支。

因此，AWBS 的并发原则是：

- 查询可以并发。
- 不同资源或不同目录的写入可以并行处理。
- 同一目标资源的写入必须串行。
- 变更包必须记录生成时的 base version。
- 如果目标资源已经变化，旧 base 的变更包不能直接写入，必须重新基于新版本生成视图，或由业务显式派生新资源。
- 多线发展必须通过目录复制、资源派生或业务结构变更来表达。

这个原则保证 AWBS 的数据库像文件系统数据库一样稳定生长，而不是在不透明的自动合并中逐渐失控。

## 10. 工作空间视图生成的回答

查询结果如何生成工作空间视图，目前第一版已经可以确定：直接 copy。

AWBS 根据上层业务或 workflow step 的视图请求，从文件系统数据库中选择需要的文件和目录，然后按照原有目录结构复制到目标工作空间中。agent 进入的是这个复制出来的工作空间，而不是数据库本体。

例如：

```text
数据库：
  A/
  B/
  C/
  D/
  E/
  F/

视图请求：
  A + B

生成工作空间：
  workspace/
    A/
    B/
```

这就是第一版视图生成原则：

```text
选择需要的文件和目录
  -> 按原结构 copy
  -> 写入视图 manifest
  -> agent 在 workspace 中工作
```

第一版不需要复杂映射语言，也不默认做重命名。目录结构本身就是数据库结构的一部分，应当被稳定尊重。

## 11. agent 完成工作后的写入交互

agent 在工作空间中完成工作后，AWBS 的处理逻辑应当类似一次数据库写操作。

上层应用或 workflow step 拿到 agent 工作后的目录，不应当直接把它覆盖回数据库本体，而应当向 AWBS 提交一次写入请求。这个写入请求的核心载体是变更包。

可以理解为：

```text
前端 / 上层应用 / workflow step
  -> 提交工作空间结果
  -> AWBS 收集变更
  -> AWBS 生成变更包
  -> 业务层解释变更包
  -> 写入文件系统数据库
  -> Git 记录版本
```

这和普通应用通过 API 向后端提交数据库写操作类似。区别在于，传统后端的写入通常是结构化数据，而 AWBS 的写入是一个文件系统变更包。

因此，agent 完成工作后的交互可以概括为：

```text
工作完成
  -> 提交 workspace
  -> 生成 changeset
  -> 应用 changeset
  -> Git 记录
```

## 12. Git 的职责

Git 是 AWBS 文件系统数据库的核心管理器。

AWBS 借用 Git 已经成熟的能力来管理文件系统数据库的增删改和版本记录。它不重新发明一套平行的版本系统。

Git 在 AWBS 中至少承担这些职责：

- 记录文件和目录的历史版本。
- 表达新增、删除、修改、移动等文件变更。
- 提供 diff 能力，帮助 AWBS 生成和检查变更包。
- 提供 commit 作为数据库版本点。
- 支持回退、比较、审查和追溯。
- 帮助判断某个变更包基于哪个版本生成。

因此，Git 不是 AWBS 的附属工具，而是 AWBS 后端数据库管理方式的核心组成部分。

## 13. 当前能力清单

AWBS 当前已经具备一个可运行的 CLI 闭环：

```text
初始化项目
  -> 建立索引
  -> 写入/读取摘要
  -> 创建工作空间视图
  -> agent 或人类在 workspace 中工作
  -> 收集 changeset
  -> 检查 changeset
  -> 应用 changeset
  -> Git commit 记录版本
```

当前 CLI 能力包括：

```text
awbs init
awbs index rebuild
awbs index query
awbs summary set / get / list
awbs view create / inspect / revoke
awbs changeset collect / inspect / apply
awbs authority verify / repair-mirrors
```

后续仍然可以继续扩展 workflow / run / step 记录结构，但这不影响当前 AWBS 作为文件系统数据库底座的最小闭环。

## 14. 第一版实现形态

AWBS 第一版优先考虑 CLI 形态。

CLI 对人类和 AI agent 都更容易调试。强 agent 可以直接在命令行中调用 AWBS，观察输出、检查目录、生成工作空间视图、收集变更包；人类开发者也可以通过 CLI 快速验证底层机制是否正确。

第一版可以先围绕这些命令能力展开：

```text
awbs init
awbs index rebuild
awbs index query
awbs view create
awbs changeset collect
awbs changeset inspect
awbs changeset apply
```

其中，API、UI 和更复杂的应用集成可以后续建立在 CLI 已验证的核心能力之上。

## 15. v0 代码架构

AWBS v0 的代码实现应当保持“机制清楚、实现可替换”的结构。第一版不能继续把 Git、文件系统、索引、视图生成和变更包逻辑都放在一个大文件里，否则后续接入 SQLite、AI 摘要、workflow / run / step、自定义 adapter 时，会让底层机制和具体实现互相缠住。

v0 代码分为四层：

```text
CLI Adapter
  只负责解析命令、调用 use case、格式化输出。

Application Use Cases
  负责编排 init、index、view、changeset 的业务流程。

Domain Contracts
  保存 manifest 类型、变更记录、索引记录、路径规则和错误类型。

Infrastructure Adapters
  负责 Git CLI、标准文件系统、磁盘 SQLite 索引、摘要文件和鉴权密封包等具体实现。
```

这四层对应的目录结构是：

```text
src/
  cli.ts
  runtime.ts

  domain/
    types.ts
    errors.ts
    constants.ts
    paths.ts

  ports/
    git.ts
    file-database.ts
    index-store.ts
    summary-store.ts

  adapters/
    git-cli.ts
    local-file-database.ts
    sqlite-index-store.ts
    file-summary-store.ts
    sealed-authority.ts

  usecases/
    authority.ts
    init.ts
    index.ts
    view.ts
    changeset.ts
```

其中四类 port 是长期扩展点：

- `GitPort`：封装 Git 初始化、HEAD、status、add、commit 和 diff 能力。
- `FileDatabasePort`：封装路径校验、copy、hash、snapshot、JSON 读写和目录扫描。
- `IndexStorePort`：封装索引持久读写和查询实现。
- `SummaryStorePort`：封装摘要读写接口。

`runtime.ts` 负责组装默认实现：

```text
createDefaultRuntime()
  -> GitCliAdapter
  -> LocalFileDatabaseAdapter
  -> SqliteIndexStoreAdapter
  -> FileSummaryStoreAdapter
  -> SealedAuthorityAdapter
  -> use cases
```

这样，CLI 不直接依赖具体基础设施实现。当前默认索引后端是磁盘 SQLite + FTS5；如果未来要替换成其他嵌入式索引，只需要替换 `IndexStorePort` 的实现。如果上层业务要用 AI 生成摘要，也应当通过 `SummaryStorePort` 写入摘要，而不是把模型配置塞进 AWBS 底座。如果未来要增加新的 view materializer 或 changeset adapter，也应当先进入 use case 和 adapter 层，而不是把 CLI 写成事实上的系统核心。

## 16. 001 视图鉴权器与鉴权目录总账

001 在 v0 的基础上增加一层 `Authority`。这层不是沙箱，也不是操作系统权限系统，而是 AWBS 文件系统数据库自己的结构鉴权层。

v0 中，工作空间的 `readPaths` / `writePaths` 主要记录在 workspace 的 `.awbs-view.json` 里。001 之后，这个明文文件只作为索引和展示，不再作为权限事实源。系统真正信任的是 `.awbs/authority/` 下的密封数据。

001 的目录结构是：

```text
.awbs/
  authority/
    repo.json
    catalog.seal.json
    catalog.mirror.json
    view-events.jsonl
    views/<viewId>/
      contract.seal.json
      mirror.json
      receipt.json
  private/
    local.json
```

其中：

- `catalog.seal.json` 是系统真正读取的鉴权目录总账。
- `catalog.mirror.json` 是给人看的明文镜像，可以被系统自动重建。
- `contract.seal.json` 是某个 view 的密封视图契约。
- `mirror.json` 是某个 view 的明文镜像，可以被系统自动重建。
- `receipt.json` 保存非敏感收据，例如 viewId、算法和内容 hash。
- `.awbs/private/local.json` 保存本机派生材料，不进入 Git，不投影到 workspace。

密封包使用带完整性认证的加密方式。001 实现采用 AES-256-GCM：

```text
K = derive_authority_key(repo_context, local_context, runtime_context)
sealed = AES-256-GCM(K, canonical_json(contract_or_catalog), aad)
```

这套机制的目标不是宣称强安全隔离，而是高摩擦鉴权：agent 不能只改一个明文 JSON 就扩大权限。明文给人看，密文给系统信。

001 的硬规则是：

- 每个 view 有唯一 UUID。
- view 只允许 create / revoke，不允许 update。
- workspace 明文 manifest 不能扩大权限。
- mirror 被改后，系统从密封包自动重建 mirror。
- 密封包被改后，解密或认证失败，相关 view 不可用。
- collect / apply 都必须回查 authority 中的密封 view contract。
- 只读路径变化永远不能 apply。
- 如果要修改只读路径，必须重新创建新 view，并把该路径声明为可写。
- revoke view 只影响未来 collect / apply，不删除旧 workspace、旧 changeset、已入仓数据，也不修改 Git 历史。

001 还引入了新的 CLI 能力：

```text
awbs view inspect <viewId> [--json]
awbs view revoke <viewId>
awbs authority verify [--json]
awbs authority repair-mirrors [--json]
```

`changeset apply` 在提交业务文件变更时，会先验证 authority 状态。如果 authority 有合法的未提交变更，例如新建 view 产生的密封契约和目录总账更新，apply 会把 `.awbs/authority` 一起纳入 Git commit。这样 AWBS 不会出现“业务数据进了 Git，但视图契约没有进入 Git”的隐藏旁路。

## 17. 索引查询与摘要读写接口

AWBS 的索引层拆成两个部分：

```text
索引存储 / 查询
摘要读写接口
```

索引存储负责记录文件系统数据库中有哪些路径、类型、hash、大小、mtime、commit、状态和摘要。当前默认索引后端是磁盘 SQLite + FTS5：

```text
.awbs/index/files.sqlite
```

它是嵌入式、本地持久化、依赖链少的方案：不需要启动服务，不需要额外 npm 依赖，直接使用 Node 24 内置的 `node:sqlite`。

SQLite 索引库包含两张核心表：

```text
files
  保存 path、kind、sha256、size、mtime、commit、status、summary、summarySource 和完整 JSON。

files_fts
  FTS5 全文索引，索引 path 和 summary。
```

`awbs index rebuild` 会扫描文件系统数据库，生成或重建 `.awbs/index/files.sqlite`。`awbs index query` 直接查询这个磁盘 SQLite 文件，不再把全量索引加载进内存 SQLite。旧 v0 项目如果存在 `.awbs/index/files.jsonl`，第一次 rebuild 会读取旧 JSONL，用于保留 removed 记录，然后写入新的 SQLite 索引。

摘要不由 AWBS 内置 AI 模型生成。AWBS 是文件系统数据库底座，它不知道业务文件真正意味着什么，因此不应该在底座里配置模型、API 地址或密钥来替业务理解内容。

摘要由上层业务应用、外部 agent 或人类工具生成，再通过 AWBS 的摘要接口写入：

```text
awbs summary set <path> --text <summary>
awbs summary set <path> --file <file>
awbs summary get <path> [--json]
awbs summary list [--json]
```

摘要持久化在：

```text
.awbs/summaries/files.jsonl
```

每条摘要记录绑定：

- path
- kind
- sha256
- commit
- summary
- updatedAt
- source

`index rebuild` 时，如果目标路径和当前 hash 有外部摘要，索引使用外部摘要，并把 `summarySource` 标记为 `external`。如果没有外部摘要，AWBS 只生成机械 fallback 摘要，例如“这是一个目录”“这是一个文本文件”“这是一个二进制文件”，不伪装理解业务语义。

这样，AWBS 保持数据库底座的边界：

- 查询层使用磁盘 SQLite + FTS5 加速。
- 摘要接口由 AWBS 提供。
- 摘要内容由业务层负责。
- AI 模型、API 密钥、提示词和业务理解都留在上层应用中。

`.awbs/index/files.sqlite` 是可重建索引，默认不进入 Git。`.awbs/summaries/files.jsonl` 是业务可写的摘要文件，可以进入 Git。

## 18. npm 包形态

AWBS 当前已经具备 npm CLI 包形态。

`package.json` 中声明：

```text
bin:
  awbs -> ./src/cli.ts

engines:
  node >= 24.0.0
```

本地开发可以这样调用：

```text
node src/cli.ts --help
npm run awbs -- --help
```

本地全局试用可以使用：

```text
npm link
awbs --help
```

也可以打包后安装：

```text
npm pack
npm install -g awbs-0.0.1.tgz
```

当前 npm 包通过 `files` 白名单只携带运行源码和核心设计文档，不把测试文件和讨论稿打进包里。
