# AI 视频提示词 Codex 插件与知识库架构

状态：Draft
日期：2026-10-20
最近修订：2026-10-22（统一知识库称呼为原始库 / AI 库；2026-10-20 按最小修正清单收敛同步、检索和阶段契约）

## 1. 背景

本项目要开发一个用于生成 AI 视频提示词的 Codex 插件。用户在 Codex 会话中提交剧本片段、一集剧本或多集剧本，插件通过剧本解析、镜头规划和知识检索，为 Seedance 2.0 或 Seedance 2.5 生成视频提示词。

知识来源使用两个飞书知识库，本文档统一使用以下名称：

| 全称 | 简称 | 说明 |
| --- | --- | --- |
| 飞书知识库（原始资料） | 原始库 | 用户维护的原始知识，包括通用知识和项目知识。 |
| 飞书知识库（AI） | AI 库 | 由插件根据原始库生成的结构化知识卡，供机器检索。 |

下文使用简称。为兼容已有配置和工具契约，内部标识仍保留 `space_a`、`base_b`、
`scan_knowledge_a`、`init_knowledge_b` 等 A/B 命名；它们只是实现标识，不是文档称谓。

### 1.1 已确定的约束

1. 用户输入可以是一段剧本、一集剧本或多集剧本，不要求输入整部剧。
2. 当前主要视频生成模型是 Seedance 2.0 和 Seedance 2.5。
3. 原始库到 AI 库的归纳不需要人工审核。
4. 知识卡不需要状态机制，AI 库中的所有知识卡默认生效。
5. AI 库只保留最新版，不保存历史版本。
6. AI 库不提供面向人的阅读页面，只保存结构化知识卡和机器检索所需信息。
7. 多人共用同一套飞书知识库，所有人都可以修改原始库，并触发 AI 库更新。
8. AI 库的同步状态必须保存在 AI 库中，不能把本地状态作为同步依据。
9. 人为约定同一时间只有一个人执行 AI 库同步，插件不实现并发锁。
10. 原始库只由用户维护，插件只读取，不写入。
11. 剧本不进入原始库。剧本只在用户使用插件的会话或工作区中传入。
12. 整个架构尽量简单直观，不引入不必要的服务端和复杂流程。
13. 一次运行只生成一个用户指定模型的提示词。
14. 第一版只做关键词检索和规则排序，不引入向量索引。

## 2. 设计原则

### 2.1 原始库和 AI 库的职责分离

原始库保存通用知识和项目知识。AI 库保存由原始库归纳出的结构化知识卡。AI 库是原始库的结果，不承担原始资料管理职责。

### 2.2 剧本和知识库分离

剧本是当前任务的输入，不写入原始库。知识库只提供拆镜方法、分镜规则、提示词技巧、角色圣经、场景说明和视觉风格。

### 2.3 AI 库只保留当前有效知识

AI 库没有草稿、审核、发布版本和历史版本。每次同步完成后，AI 库中保存的就是最新有效知识。

### 2.4 同步状态以 AI 库为准

AI 库中维护一个 `SyncState` 表，记录原始库中每个原始文档的同步状态。所有用户先读取这个表，再决定是否需要刷新本地缓存。本地缓存标记只用于性能，不作为同步事实。

### 2.5 增量同步优先

每次同步先扫描原始库的文档节点元数据，只比较节点身份、
`obj_edit_time`、路径、标题和父节点。只有新增、修改、移动、重命名或删除的
文档才会被处理。未变化的文档不会读取正文，也不会重新生成知识卡。

`source_revision` 在读取正文后获得，用于来源追踪和本地缓存刷新。它不参与
扫描阶段的变更判断。第一版不使用 `content_hash`。

如果一次同步只影响一个文档，插件只读取这个文档的正文，只删除并重建这个文档对应的知识卡，不处理其他文档。

### 2.6 插件不在服务端运行

插件由 Codex 本地加载。飞书读写通过用户电脑上的 `lark-cli` 完成，不增加独立服务端。

### 2.7 简单优先

不引入人工审核、发布版本、历史快照、冲突队列、预构建索引工件和复杂的多用户同步协议。

## 3. 总体架构

```text
┌──────────────────────────────────────────────────────────────┐
│ 飞书知识库（原始资料）                                       │
│                                                              │
│ 通用知识                                                     │
│   拆镜方法、分镜知识、提示词技巧、Seedance 使用经验          │
│                                                              │
│ 项目知识                                                     │
│   角色圣经、场景说明、视觉风格、项目术语                     │
│                                                              │
│ 用户直接维护，插件只读取                                     │
└──────────────────────────────────────────────────────────────┘
                         │
                         │ 节点元数据扫描 + 变更文档读取
                         ▼
┌──────────────────────────────────────────────────────────────┐
│ Codex 本地插件                                               │
│                                                              │
│ knowledge-sync Skill                                         │
│   读取原始库 -> AI 归纳 -> 生成结构化知识卡 -> 写入 AI 库    │
│                                                              │
│ script2shot Skill（入口编排）                                │
│   刷新本地索引 -> 顺序调用三个阶段 Skill -> 聚合输出         │
│                                                              │
│ script-breakdown：剧本 -> script_analysis.json               │
│ shot-planning：解析 + 项目知识 -> shot_plan.json             │
│ shot-prompting：镜头计划 + 知识 -> PromptIR -> 提示词        │
│                                                              │
│ 本地 MCP Server                                              │
│   lark-cli 适配器                                            │
│   本地缓存和本地关键词索引                                   │
│   关键词检索和规则排序                                       │
│   阶段产物校验、PromptIR 校验和 Seedance 渲染                │
│   运行目录与阶段状态管理                                     │
└──────────────────────────────────────────────────────────────┘
                         │
                         │ 写入知识卡并更新 SyncState
                         ▼
┌──────────────────────────────────────────────────────────────┐
│ 飞书知识库（AI）                                             │
│                                                              │
│ 数据表 KnowledgeCards                                        │
│   只保存最新结构化知识卡                                     │
│                                                              │
│ 数据表 SyncState                                             │
│   保存原始库每个文档的同步状态                               │
└──────────────────────────────────────────────────────────────┘
```

## 4. 飞书知识库（原始资料）

### 4.1 用途

原始库由用户直接维护，插件只读取。原始库不保存剧本，不保存生成结果，也不保存插件运行状态。

原始库是一个飞书知识库（Wiki 空间）：每个文档是一个 Wiki 节点，节点下挂 docx 文档，
插件按节点元数据扫描、按文档读取正文。

### 4.2 通用知识

通用知识适用于所有项目，包括：

- 如何拆分剧本和镜头。
- 分镜基础知识。
- 视频提示词结构。
- 运镜、景别、光线和构图术语。
- Seedance 2.0 和 Seedance 2.5 的使用经验。
- 常见错误和修正方法。
- 正例和反例。

### 4.3 项目知识

项目知识只适用于某个项目，包括：

- 项目概述：类型定位、目标受众、整体基调和创作边界。
- 角色圣经。
- 角色外观和服装规范。
- 场景说明。
- 世界观设定。
- 视觉风格。
- 色彩和光线规范。
- 项目术语和命名规则。
- 项目级提示词偏好。

### 4.4 建议目录结构

为了让插件能从文档位置推断知识范围和项目归属，原始库建议使用稳定目录：

```text
通用知识/
  拆镜方法/
  分镜知识/
  提示词技巧/
  Seedance/

项目知识/
  <project_id>/
    项目概述/
    角色圣经/
    场景说明/
    视觉风格/
    项目术语/
```

插件从节点路径推导：

| 路径 | 推导结果 |
| --- | --- |
| `通用知识/...` | `scope=general` |
| `项目知识/<project_id>/...` | `scope=project`、`project_id=<project_id>` |

每个 Wiki 文档是一个独立同步单元。一个文档只生成属于该文档的知识卡。

#### 实现约定（2026-10-21 实测）

- 节点扫描使用原始 API `wiki nodes list`（`--space-id` / `--parent-node-token` /
  `--page-size` / `--page-token` 手动翻页）。快捷命令 `wiki +node-list` 的输出会被裁剪，
  实测不含 `obj_edit_time`，不能用于增量判断。
- `scope` / `project_id` 按根节点映射给出：「通用知识」根节点 → `scope=general`；
  其他 origin docx 根节点 → `scope=project`，`project_id` 由配置中的 `project_roots`
  给出（结构与语义见 §7.3）。未映射根节点与非 docx 节点跳过并写 warning。
- 上面的路径推导规则保留为建议目录：路径继续用于 `source_path` 展示与人工组织，
  不再作为 `scope` / `project_id` 的唯一推导依据。

### 4.5 用户操作

用户可以随时修改原始库。修改后，由约定的同步人员运行 `knowledge-sync` Skill，把最新知识重新归纳到 AI 库。

插件不监听原始库，不自动写入原始库，也不修改用户原始知识。

## 5. 飞书知识库（AI）

### 5.1 用途

AI 库只服务机器检索和提示词生成。它不提供人类阅读页面，不保存历史版本，不保存草稿。

AI 库的物理形态是一个飞书多维表格（Base），不是 Wiki 文档。一个 Base 下面挂两张数据表：

| 数据表 | 用途 | 访问方式 |
| --- | --- | --- |
| `KnowledgeCards` | 保存最新结构化知识卡 | `base_b` 加 `table_id` |
| `SyncState` | 保存原始库每个文档的同步状态 | `base_b` 加 `table_id` |

说明：

- 表是多维表格里的数据表：字段有类型，记录有记录 ID，支持按字段过滤和分页，插件按记录读写。
- 表名固定为 `KnowledgeCards` 和 `SyncState`。`setup` 首次运行时按表名解析
  `table_id`，确认后写入本地配置；后续运行使用配置中的固定 `table_id`。
- AI 库不要求放进 Wiki 空间。如果希望人在知识库里能找到入口，可以把同一个多维表格作为 Wiki 节点挂载；插件访问时先从节点解析出 `obj_token`，再按多维表格接口读写，多一步解析。
- 不用 docx 文档里的表格承载这两张表：文档表格没有记录级接口，字段无类型，过滤和批量更新都要靠文档块解析，不适合做机器读写的事实来源。

### 5.2 知识卡模型

知识卡是 AI 库的最小检索单位。

建议的知识卡分类：

| 分类 | 内容 |
| --- | --- |
| `shot_breakdown` | 拆镜方法、镜头切分、动作单元 |
| `storyboard` | 分镜结构、镜头顺序和转场 |
| `prompt_technique` | 提示词组织方法和表达技巧 |
| `camera_lexicon` | 景别、机位、焦段、运镜和灯光术语 |
| `character_bible` | 角色外观、服装、性格和一致性要求 |
| `scene_description` | 场景空间、时间、天气和环境状态 |
| `visual_style` | 色彩、材质、光线和整体视觉风格 |
| `project_rule` | 项目级命名、术语和创作偏好 |
| `seedance_rule` | Seedance 2.0 和 Seedance 2.5 的软知识 |
| `example` | 正例、反例和改写样例 |

知识卡示例：

```json
{
  "card_id": "src:source-doc-token:visual_style:001",
  "scope": "project",
  "project_id": "demo",
  "category": "visual_style",
  "title": "雨夜视觉风格",
  "content": "低照度、冷色反光、湿润材质、手持跟拍。",
  "tags": ["night", "rain", "neo-noir"],
  "entities": ["角色A", "旧城区"],
  "target_models": ["seedance-2.0", "seedance-2.5"],
  "priority": 80,
  "source_doc_token": "source-doc-token",
  "source_node_token": "source-node-token",
  "source_path": "项目知识/demo/视觉风格/雨夜风格",
  "source_title": "雨夜视觉风格",
  "source_revision": 12,
  "source_block_id": "source-block-id",
  "updated_at": "2026-10-20T12:00:00+08:00"
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `card_id` | 稳定知识卡 ID，建议包含 `source_doc_token` |
| `scope` | `general` 或 `project` |
| `project_id` | 项目知识所属项目，通用知识可为空 |
| `category` | 知识卡分类 |
| `title` | 知识卡标题 |
| `content` | 知识卡正文 |
| `tags` | 检索标签 |
| `entities` | 角色、地点、道具等项目实体 |
| `target_models` | `seedance-2.0`、`seedance-2.5` |
| `priority` | 检索排序优先级 |
| `source_doc_token` | 来源文档 token |
| `source_node_token` | 来源 Wiki 节点 token |
| `source_path` | 来源文档在原始库中的路径 |
| `source_title` | 来源文档标题 |
| `source_revision` | 来源文档版本 |
| `source_block_id` | 来源内容块 ID |
| `updated_at` | 最近更新时间 |

知识卡没有 `status` 字段。AI 库中的所有知识卡默认生效。

`tags`、`entities` 和 `target_models` 在 Base 中统一存为 JSON 文本数组，
由插件写入和解析。这样不需要为动态标签维护 Base 多选选项。

Base 字段类型固定为：上述三个数组字段使用长文本；`priority` 和
`source_revision` 使用数字；`updated_at` 使用日期时间；其他字段使用文本。

同一个来源文档生成的知识卡必须带有相同的 `source_doc_token`。当该文档发生变化时，插件可以只删除并重建这个 `source_doc_token` 对应的知识卡。

### 5.3 同步状态模型

`SyncState` 是 AI 库的同步事实来源。

建议一个原始库文档对应一条记录：

```json
{
  "source_doc_token": "source-doc-token",
  "source_node_token": "source-node-token",
  "source_path": "项目知识/demo/视觉风格/雨夜风格",
  "source_title": "雨夜视觉风格",
  "scope": "project",
  "project_id": "demo",
  "obj_edit_time": "1760000000",
  "source_revision": 12,
  "card_count": 3,
  "last_synced_at": "2026-10-20T12:00:00+08:00",
  "last_sync_user": "张三",
  "last_run_id": "sync-20261020-120000"
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `source_doc_token` | 原始库文档对象 token，作为主键 |
| `source_node_token` | 原始库 Wiki 节点 token |
| `source_path` | 文档在原始库中的路径 |
| `source_title` | 文档标题 |
| `scope` | 从路径推导出的 `general` 或 `project` |
| `project_id` | 项目知识所属项目，通用知识可为空 |
| `obj_edit_time` | Wiki 节点元数据中的最近编辑时间 |
| `source_revision` | 文档正文读取时返回的 revision |
| `card_count` | 该文档生成的知识卡数量 |
| `last_synced_at` | 该文档最近一次成功同步时间 |
| `last_sync_user` | 该文档最近一次同步执行人 |
| `last_run_id` | 该文档最近一次同步运行 ID |

本地缓存刷新以 `SyncState` 中各文档的 `source_revision` 和
`last_synced_at` 为判断依据。本地不保存权威同步状态。

`SyncState` 只记录当前文档的增量同步状态，不保存知识历史，也不构成知识版本系统。

Base 字段类型固定为：`obj_edit_time` 保存原始时间字符串；
`source_revision` 和 `card_count` 使用数字；`last_synced_at` 使用日期时间；
其他字段使用文本。

## 6. AI 库增量更新流程

AI 库没有人工编辑和人工审核。AI 库的知识卡完全由原始库生成，因此一个原始库文档可以独立同步，不需要处理其他文档。

### 6.1 增量判断

插件使用以下信息判断文档是否变化：

| 信息 | 来源 |
| --- | --- |
| `node_token` | `wiki nodes list`（原始 API） |
| `obj_token` | `wiki nodes list`（原始 API） |
| `obj_edit_time` | `wiki nodes list`（原始 API） |
| `title` | `wiki nodes list`（原始 API） |
| `parent_node_token` | `wiki nodes list`（原始 API） |

来源以原始 API `wiki nodes list` 为准（2026-10-21 实测）：快捷命令 `wiki +node-list`
会裁剪字段，实测不含 `obj_edit_time`，不得用于扫描阶段。

扫描命令固定为（`--parent-node-token` 在根层省略，`--page-token` 在每页首页省略）：

```bash
lark-cli wiki nodes list --space-id <space_a> [--parent-node-token <token>] \
  --page-size 50 [--page-token <token>] --as user --format json
```

扫描规则（2026-10-21 固定）：

- 手动翻页 + BFS：跟随响应中的 `has_more` / `page_token` 遍历整棵节点树；不使用
  `--page-all`（其翻页范围有上限）。
- 根节点映射决定归属（配置结构见 §7.3）：根节点标题为「通用知识」⇒
  `scope=general`、`project_id` 为空；其他 origin docx 根节点 ⇒ `scope=project`、
  `project_id` 取 `lark.project_roots` 中该根节点的映射。子节点继承所属根节点的
  `scope` / `project_id`。
- 跳过规则（写 warning，不中断扫描）：根节点不在 `project_roots` 中且标题不是
  「通用知识」⇒ `UNMAPPED_ROOT_NODE_SKIPPED`（整个子树不再扫描）；
  `node_type=shortcut` ⇒ `SHORTCUT_NODE_SKIPPED`（快捷方式不作为独立同步单元）；
  `obj_type != docx` ⇒ `NON_DOC_NODE_SKIPPED`（该节点及其子树都不再扫描；控制方
  裁决 2026-10-21：真实原始库的非 docx 节点均为叶子，即使将来其下挂 docx 子节点，
  漏扫也只会走 `to_delete`，而删除必须经过整批 dry-run 预览并由用户确认，不会
  静默删除数据）。
- 变化分类按固定优先级：SyncState 有、扫描结果没有 ⇒ 删除；扫描结果有、SyncState
  没有 ⇒ 新增；`obj_edit_time` 不同 ⇒ 修改（即使同时移动或改名）；`obj_edit_time`
  相同但 `path` 或 `title` 不同 ⇒ 移动或改名（只更新元数据）；其余 ⇒ 未变化。

上表只用于扫描阶段。确认文档需要处理后，插件调用 `docs +fetch`，再保存
返回的 `revision_id` 作为 `source_revision`。

正文标题的提取顺序固定为（2026-10-22）：正文中的 `<title>` 标签 → 首个 Markdown
标题行 → 节点标题（写 `DOC_TITLE_FROM_NODE` warning）→ 空字符串（写
`DOC_TITLE_MISSING` warning）。飞书文档的正文里通常带 `<title>`，优先取它才能
与 Wiki 节点标题保持一致。

### 6.2 增量同步算法

```text
1. 读取 AI 库的 SyncState 全表
2. 分页扫描原始库的 Wiki 节点元数据
3. 根据 source_doc_token 与 SyncState 比较
4. 只读取发生变化的文档正文
5. 只为变化文档重新生成知识卡
6. 只替换该文档对应的知识卡
7. 只更新该文档对应的 SyncState 记录
8. 删除文档时，删除该文档对应的知识卡和 SyncState 记录
```

这里的“扫描”只读取 Wiki 节点元数据，不读取文档正文。正文只会在文档新增或修改时读取。

扫描完成后先生成整批 dry-run 清单，列出待新增、修改、移动、重命名和删除的
文档；用户确认后一次执行整批，不逐文档重复确认。

变化分类：

| 情况 | 判断依据 | 处理 |
| --- | --- | --- |
| 新增文档 | `source_doc_token` 不在 SyncState | 读取正文，生成知识卡 |
| 修改文档 | `obj_edit_time` 与 SyncState 不同 | 读取正文，重新生成知识卡 |
| 移动或重命名 | `source_path` 或 `source_title` 不同 | 更新知识卡和 SyncState 元数据 |
| 删除文档 | SyncState 中存在，但当前节点列表中不存在 | 删除知识卡和 SyncState 记录 |
| 未变化 | `obj_edit_time` 和元数据都相同 | 跳过，不读取正文 |

### 6.3 单文档同步规则

如果原始库中只有一个文档新增或修改：

1. 插件只读取这个文档的正文。
2. 插件只调用一次 AI 归纳，生成这个文档的知识卡。
3. 插件先记录该 `source_doc_token` 当前所有知识卡的 Base `record_id`。
4. 插件写入这个文档的新知识卡。
5. 插件只删除第 3 步记录的旧知识卡 `record_id`。
6. 插件更新这个文档的 SyncState 记录。

其他文档的正文、知识卡和 SyncState 都不处理。

写入新卡失败时，旧卡仍然存在。新卡写入后删除或更新 SyncState 失败时，
SyncState 保留旧值，下一次同步会再次处理该文档并通过重新记录的旧卡集合
完成清理。第一版不引入事务、补偿队列或并发锁。

### 6.4 指定文档同步

除了扫描变化，用户可以在 `$knowledge-sync` 请求中指定一个文档：

```text
$knowledge-sync 只同步这个文档：<飞书文档 URL 或 token>
```

该模式直接读取指定文档并更新对应的知识卡和 SyncState，不扫描其他文档。适合用户明确知道只修改了一个文档的场景。

当 `obj_edit_time` 因为时间精度或其他原因没有变化时，也可以使用该模式强制同步指定文档。

### 6.5 文档引用展开（2026-10-22）

原始库的 Wiki 文档可以只是「链接占位」：正文只有一条外部引用，真正的知识在引用
目标里。同步时先展开这些引用、读取目标正文，再与文档正文一起归纳成知识卡。

支持的引用形态：

| 形态 | 识别方式 | 读取方式 |
| --- | --- | --- |
| 飞书云文档引用卡片 | 正文中的 `<cite doc-id="..." file-type="docx" ...>` | lark-cli `docs +fetch` |
| 飞书文档链接 | `/docx/<token>`、`/wiki/<token>` 形式的 URL | 同上；`/wiki/<token>` 先解析节点 |
| 网页链接 | 正文中的 `http(s)://` URL 或 Markdown 链接 | HTTP GET + HTML 转纯文本 |

规则：

- 只展开一层：不递归展开引用文档内部的引用。需要更深内容时，把内容并入 Wiki 文档
  后重新同步。
- 引用数量上限 10 条、单条正文上限 200000 字符、单页 HTTP 响应上限 2 MB、HTTP 超时
  30 秒；超过上限写 warning，截断时在返回值里标记 `truncated`，不静默丢弃。
- 网页只接受 `http` / `https`；图片、PDF 等二进制链接跳过并写 warning。
- 网页是 JS 渲染、静态 HTML 里取不到正文时，返回 `needs_render` 状态与
  `REFERENCE_NEEDS_RENDER` warning，由 Skill 用会话内的网页/浏览器工具读取全文后
  继续归纳。
- 引用目标发生变化不会改变 Wiki 节点的 `obj_edit_time`，因此不会自动触发重同步；
  需要刷新时用指定文档模式（§6.4）强制重算。

溯源要求：知识卡仍以该 Wiki 文档为同步单元（`source_doc_token`、`source_node_token`、
`source_path`、`source_title`、`source_revision` 都取 Wiki 文档本身）；引用内容必须在
卡片 `content` 中写明来源（飞书文档 token 或网页 URL）与检索日期。

### 6.6 失败处理

单文档同步失败时：

- 不更新该文档的 SyncState。
- 该文档下一次同步时会再次进入待处理集合。
- 失败信息写入同步结果并提示用户；不静默使用部分写入结果。
- 其他文档的同步结果不受影响。
- 可以只重试该文档，不需要重跑整个知识库。

## 7. 本地插件

### 7.1 插件组成

```text
codex-script2shot/
  plugin.json
  mcp.json
  skills/
    setup/
      SKILL.md
    knowledge-sync/
      SKILL.md
    script2shot/
      SKILL.md
    script-breakdown/
      SKILL.md
    shot-planning/
      SKILL.md
    shot-prompting/
      SKILL.md
  references/
    stage-conventions.md
  scripts/
    launch_script2shot_mcp.cmd
    launch_script2shot_mcp
  server/
    src/
    tests/
    dist/
  schemas/
    knowledge_card.schema.json
    sync_state.schema.json
    run.schema.json
    script_analysis.schema.json
    shot_plan.schema.json
    prompt_ir.schema.json
  rules/
    models/
      seedance-2.0.json
      seedance-2.5.json
  tests/
    fixtures/
  assets/
```

根目录 `plugin.json` 是唯一主清单。`.codex-plugin/plugin.json` 不进入第一版
目录，避免两份元数据同时维护。

MCP Server 技术栈（2026-10-20 确认）：

- 语言与运行时：TypeScript，Node.js >= 24。Codex 桌面端自带 Node 24.19.0
  （本机实测），开发机使用系统 Node。
- 构建：esbuild 打包为单文件 `server/dist/server.mjs`，命令
  `npm --prefix server run build`。
- 运行：`scripts/launch_script2shot_mcp.cmd`（Windows）与
  `scripts/launch_script2shot_mcp`（POSIX）定位 Node 运行时后启动
  `server/dist/server.mjs`。解析顺序与官方插件启动脚本一致
  （codex-app-tools 0.1.6 启动脚本，2026-10-20 核对本机插件缓存）：
  `CODEX_MCP_NODE_PATH` -> Codex 资源目录中的 Node -> Codex 缓存 runtime
  -> 系统 `node`；全部缺失时提示更新 Codex 或安装 Node.js >= 24。
- 依赖：`@modelcontextprotocol/sdk`、`ajv`、`smol-toml` 打包进单文件；
  关键词索引使用 Node 内置 `node:sqlite`，不引入原生编译模块；
  开发依赖为 `typescript`、`esbuild`、`vitest`、`@types/node`。
- 测试：`npm --prefix server test -- <过滤词>`（`test` 脚本为 `vitest run`）。
- 目录补充：`scripts/`（启动脚本）、`server/tests/`（含 fixtures）、
  `tests/fixtures/`（跨模块 fixture）。

### 7.2 本地数据目录

```text
~/.codex-script2shot/
  config.toml
  cache/
    cards.json
  index/
    knowledge.sqlite
  logs/
```

工作区运行产物：

```text
.script2shot/
  outputs/
    <run_id>/
      run.json
      script_analysis.json
      shot_plan.json
      prompts.ir.json
      prompts.<model>.md
      knowledge_refs.json
      warnings.md
```

### 7.3 本地配置

插件不写死 `lark-cli` 路径。Setup Skill 按以下顺序查找：

1. 环境变量 `LARK_CLI_PATH`。
2. 用户配置 `~/.codex-script2shot/config.toml`。
3. 系统 `PATH`。
4. 常见安装目录。
5. 找不到时提示用户安装或指定路径。

配置示例：

```toml
[lark]
cli_path = "D:\\lark-cli\\lark-cli.exe"
profile = "cli_aa20f40faa785d11"
space_a = "wiki-space-a"
base_b = "base-token-b"
knowledge_cards_table_id = "tbl..."
sync_state_table_id = "tbl..."

[[lark.project_roots]]
node_token = "wikcn-project-root-a"
project_id = "demo"

[[lark.project_roots]]
node_token = "wikcn-project-root-b"
project_id = "another-project"

[retrieval]
default_top_k = 12
```

`project_roots` 是原始库根节点到项目 ID 的映射表，用于把非「通用知识」的
origin docx 根节点归入 `scope=project`：每项包含 `node_token`（根节点 token）与
`project_id`（该根节点下文档所属项目）。该结构的字段与语义以本节为准；缺省值由
插件默认配置提供，用户可整体替换。

`lark.profile` 表示插件期望当前生效的 lark-cli 活动 profile，不是每命令参数。
lark-cli 的 profile 由全局 `lark-cli profile use` 切换，且 CLI 明确要求 AI agents
不得自行切换或删除 profile；插件只通过只读的 `lark-cli profile list` 读取活动
profile 并与配置比对，不调用 `profile use` / `profile remove`。不一致时 `health`
返回 warning，提示用户本人确认后运行 `lark-cli profile use <name>`。

**默认知识库（2026-10-21）。** 插件自带默认知识库配置，默认值唯一来源是
`server/src/setup_defaults.ts` 的 `SETUP_DEFAULTS`：

- `lark.profile` = `"cli_aa20f40faa785d11"`（取本机 lark-cli 活动 profile，
  2026-10-21 核对；更换机器或账号时需相应调整，插件不自动切换）；
- `lark.space_a` = `"7695983197091302359"`（原始库空间）；
- `lark.base_b` = `"WRrVblDbqaEFOSs39P0cFzilnfd"`（AI 库的 Base obj_token；
  完整值只出现在源码与配置文件里，运行期输出仍按掩码规则处理）；
- `lark.project_roots` = 一项映射：`node_token = "Ou9Vw0emviJajPklYjQc4fqjnie"`
  （《五夫临门》影游项目知识根节点）→ `project_id = "wufu-linmen"`；
- `retrieval.default_top_k` = `12`。

默认知识库可替换：在 `~/.codex-script2shot/config.toml` 中改对应字段，或在 setup
时提供新值；setup Skill 与 `write_config` 都引用 `SETUP_DEFAULTS`，不重复硬编码。

`write_config` 的缺省填充语义：`lark.profile`、`lark.space_a`、`lark.base_b`、
`lark.project_roots`、`retrieval.default_top_k` 为 `undefined` 时套用上述默认值；
显式提供（包括显式空数组）的值优先。填充后仍校验 `lark.space_a` 与
`lark.base_b` 非空，返回值通过 `applied_defaults[]` 列出本次实际套用的默认
键路径。`config` 必须提供且为普通对象；`lark`、`retrieval` 容器出现时也必须是
普通对象（fail-closed），否则返回 `CONFIG_INVALID` 并在 `details.field` 指明字段。
`dry_run` 与 `create_local_dirs` 只接受布尔值，字符串或数字均按 `CONFIG_INVALID`
拒绝；所有字符串字段在写入前 trim。`project_roots` 同样按 trim 后的值校验与保存。

`lark.project_roots` 非法时按 `CONFIG_INVALID` 处理：字段缺省视为 `[]` 且不产生
warning；条目非表，或 `node_token` / `project_id` 非字符串或为空时，在 `details.field`
中返回出错字段路径（如 `lark.project_roots[0].node_token`）。

### 7.4 本地缓存和索引

本地缓存和索引是从 AI 库派生出来的临时数据。

刷新流程：

```text
读取 AI 库的 SyncState 全表
  -> 与本地每个 source_doc_token 的缓存状态比较
  -> 比较 source_revision 和 last_synced_at
  -> 未变化的文档不刷新
  -> 只拉取变化文档对应的知识卡
  -> 逐卡校验卡片的 source_revision 与 SyncState.source_revision 一致
  -> 只更新这些文档在本地关键词索引中的数据
```

本地缓存标记不是同步状态，只用于避免重复下载和重复建索引。AI 库的 `SyncState` 始终是权威同步状态。

本地缓存的 wire format：`<home>/cache/cards.json` 顶层是 `version: 1` 与 `docs`，
`docs` 以 `source_doc_token` 为键，每个条目记录 `source_revision`、`last_synced_at`
和该文档的全部知识卡 `cards[]`（卡片字段与索引行同源）。缓存文件损坏、版本不受
支持或读不到时，`load_cache()` 返回 `rebuild_needed: true` 与对应 warning
（`CACHE_CORRUPT` / `CACHE_VERSION_UNSUPPORTED` / `CACHE_UNREADABLE`），并把
`docs` 视为空；它绝不自动覆盖缓存文件，是否重建（重新拉取全部文档）由
`refresh_local_index` 决定。

本地关键词索引固定为 `<home>/index/knowledge.sqlite`，是 AI 库的派生临时数据。
`index_status()` 只按路径做只读探测，不创建或修复文件、不执行 DDL、不抛异常，
并返回以下状态：

| 状态 | 判定 | 消费方式 |
| --- | --- | --- |
| `missing` | 索引文件不存在 | 检索与知识包回退到本地缓存；写路径按派生数据重建 |
| `ready` | 文件可读且 `cards` 表存在 | 读取索引；若随后的实际查询失败，按索引临时不可用处理 |
| `corrupt` | 路径不是普通文件、0 字节、SQLite 结构损坏或缺少 `cards` 表 | 检索与知识包回退到本地缓存；写路径可删除旧文件后重建 |
| `unreadable` | `stat`、只读打开或验证查询遇到权限、占用、IO 等临时失败 | 检索与知识包回退到本地缓存；写路径 fail-closed，不删除索引文件 |

写路径在索引为 `unreadable`，或探测为 `ready` 但 `doc_state` 读取失败时返回
`INDEX_UNAVAILABLE`，并在 `details` 中保留 `index_state` / `index_read_failed`，
绝不删除仍可能恢复的索引文件。`replace_doc_rows` 还会在事务开始前校验每张
卡片的 `source_doc_token` 与目标 token 一致；不一致时拒绝整次替换并保持索引原样。

## 8. MCP Tool

本地 MCP Server 只负责确定性操作，不负责 LLM 归纳。

| Tool | 作用 |
| --- | --- |
| `health` | 检查 lark-cli、登录状态、知识库配置和本地索引 |
| `write_config` | dry-run 预览并写入本地配置、初始化本地目录 |
| `scan_knowledge_a` | 只扫描原始库的节点元数据，不读取文档正文 |
| `fetch_knowledge_a_doc` | 只读取一个指定文档的正文和 revision；可选展开正文里的飞书文档引用与网页链接，返回 `references[]`（§6.5） |
| `read_sync_state` | 读取 AI 库的按文档 SyncState |
| `build_sync_plan` | 纯函数工具：输入 `scan_knowledge_a` 的 `nodes[]` 与 `read_sync_state` 的 `records[]`，输出 `to_add` / `to_update` / `to_move` / `to_delete` / `unchanged` / `warnings` |
| `init_knowledge_b` | 创建或校验 `KnowledgeCards` 和 `SyncState`，返回固定 table_id |
| `replace_doc_cards` | 两种模式（二选一）：①替换模式接收 Skill 生成的新卡，执行顺序固定为「先记录该 `source_doc_token` 现有卡片的 `record_id` 集合 → 写入新卡（每 200 条一批）→ 只删除第 ① 步记录的旧 `record_id`」，写入失败不执行删除；②`metadata_patch` 模式只批量更新现有卡片的来源元数据（`source_path`/`source_title`/`scope`/`project_id`），不写新卡、不删卡 |
| `update_doc_sync_state` | 只更新一个来源文档的 SyncState 记录 |
| `delete_doc_cards` | 删除已移除文档对应的知识卡和状态 |
| `refresh_local_index` | 只刷新发生变化的文档对应的本地索引 |
| `search_knowledge` | 执行过滤、关键词检索和 priority 排序 |
| `load_knowledge_pack` | 加载通用知识、项目知识和 Seedance 规则 |
| `init_run` | 在显式 `workspace_root` 下创建运行目录和 `run.json`，记录输入模式、项目 ID、目标模型和可选画幅 |
| `read_run` | 在显式 `workspace_root` 下读取 `run.json` 和阶段状态，用于续跑和聚合输出；同时核对产物身份字段与 `run.json` 及产物之间是否一致，冲突时写 `RUN_STATE_RECONCILED` warning（`details.conflicts[]`）并把冲突产物所属阶段置 `failed`，不重写身份字段 |
| `update_run_state` | 在显式 `workspace_root` 下更新阶段状态、产物路径和警告 |
| `validate_stage_artifact` | 按 schema 校验 `script_analysis.json` 和 `shot_plan.json`；模型规则文件缺失、损坏或与请求的模型不一致（安装损坏）时返回文档级 `MODEL_RULES_UNAVAILABLE` |
| `validate_prompt` | 校验 PromptIR 和 Seedance 硬规则；同类安装损坏同样返回文档级 `MODEL_RULES_UNAVAILABLE` |
| `render_prompt` | 渲染 Seedance 2.0 或 Seedance 2.5 提示词 |
| `aggregate_knowledge_refs` | 入参 `run_id`、三个阶段产物路径与 `output_path`；按阶段固定顺序聚合三个阶段引用写出 `knowledge_refs.json`，PromptIR 的逐镜头引用按镜头顺序展平，成功返回 `{ output_path, counts }` |
| `write_warnings` | 入参 `run_id`、`run.json` 路径、三个阶段产物路径与 `output_path`；汇总 `run.json` 的运行级 warnings 与阶段产物 `missing_info`（按 `code` + `message` 去重）写出中文 `warnings.md`，成功返回 `{ output_path, count }`；没有 `warnings` 入参，工具 warning 必须先用 `update_run_state` 持久化；写入前压平 CR/LF 并转义反斜杠、反引号与行首块级前缀，warning 文本不能改写 `warnings.md` 结构 |

`aggregate_knowledge_refs` 与 `write_warnings` 成功时只带 `output_path` 等字段，**不带
`ok: true`**；只有失败才返回 `{ ok: false, error }`，调用方按 `error` / `output_path`
是否存在分支，不要用 `ok` 的真值判断。

写操作默认先 dry-run。批量同步先生成整批影响清单，用户确认后执行整批；
不逐文档反复确认。

阶段产物校验由 MCP Tool 完成，Skill 不自行实现 schema 校验。

## 9. Skills

Skill 分三层：入口编排（`script2shot`）、创作阶段（`script-breakdown`、`shot-planning`、
`shot-prompting`）和运维（`setup`、`knowledge-sync`）。

Skill 是 Codex 读取并执行的流程说明，不是可执行 CLI。用户通过 `$skill-name`
或自然语言触发 Skill；阶段之间的确定性状态由文件产物和 MCP Tool 维持。

拆分原则：只有产物稳定、知识域独立、值得单独重跑的创作步骤才成为 Skill；
索引刷新、检索、校验和渲染等确定性操作留在 MCP Tool 中。

排查类技能（例如 `knowledge-inspect`）不参与主流程，见第 14 章 Phase 5。

### 9.1 setup

负责：

- 查找本机 `lark-cli`。
- 检查登录状态。
- 配置原始库和 AI 库。
- 创建或校验 `KnowledgeCards` 和 `SyncState`，保存固定 `table_id`。
- 初始化本地目录。
- 提示用户可在需要时运行 `$knowledge-sync` 完成首次同步与本地索引构建，不在 setup 内自动执行。

### 9.2 knowledge-sync

负责：

- 扫描原始库的 Wiki 节点元数据。
- 对比 AI 库的按文档 `SyncState`。
- 扫描后由 `build_sync_plan` 生成整批清单，用户确认后一次执行整批。
- 只读取新增或修改文档的正文。
- 只为这些变化文档生成结构化知识卡。
- 只替换这些文档对应的知识卡。
- 只更新这些文档的 `SyncState` 记录。
- 处理已删除文档对应的知识卡和状态。

支持指定文档同步模式：

```text
$knowledge-sync 只同步这个文档：<飞书文档 URL 或 token>
```

该 Skill 不写原始库，不读取用户剧本，不包含人工审核步骤。

### 9.3 script2shot

入口编排 Skill，本身不做创作判断。

负责：

- 接收一段剧本、一集剧本或多集剧本。
- 要求用户提供 `project_id`、单一 `target_model` 和可选 `aspect_ratio`，并识别输入模式。
- 读取 AI 库的按文档 SyncState。
- 只刷新发生变化文档对应的本地索引。
- 创建运行目录和 `run.json`。
- 按顺序读取并执行 `script-breakdown`、`shot-planning`、`shot-prompting`
  的 `SKILL.md`。
- 每个阶段结束后校验产物并更新 `run.json`。
- 聚合提示词、知识引用和警告。

不负责：

- 不解析剧本、不规划镜头、不生成 PromptIR。
- 不实现检索、索引、校验和渲染逻辑。

支持从任意阶段续跑。以下内容是用户请求中的参数示例，不是 shell 命令：

```text
$script2shot 从 shot-planning 继续，run_id 是 <run_id>
$script2shot 只执行 shot-prompting，run_id 是 <run_id>
```

### 9.4 script-breakdown

负责把剧本变成结构化解析结果。

输入：剧本文本和 `project_id`。运行上下文可以携带 `target_model`，但本阶段
检索不使用目标模型过滤。

输出：`script_analysis.json`，其中包含本阶段的 `knowledge_refs`。

- 判定输入模式：片段、单集或多集。
- 拆成集、场景、节拍、动作单元、情绪单元、对白单元和镜头组建议。
- 保持原文边界，不新增剧情、角色、事件和结局。
- 输出缺失信息警告。
- 开场加载一次通用知识 `剧本解析`（`shot_breakdown`），不按目标模型过滤。
- 按角色或场景首次出现检索项目知识中的角色、场景、风格和项目术语。

职责边界：解析到镜头组建议为止。具体镜头数量、时长和组接交给 `shot-planning`。

独立使用场景：只要场次表、角色表或时长估算，不要提示词。

### 9.5 shot-planning

负责把结构化解析结果变成镜头计划。

输入：`script_analysis.json` 和当前项目知识。

输出：`shot_plan.json`，其中包含本阶段的 `knowledge_refs`。

- 把镜头组建议落实为镜头清单：景别、机位、运镜、时长、转场和连贯性。
- 检查目标模型的时长和镜头拆分边界。
- 记录每个镜头的进入状态和离开状态。
- 依赖通用知识 `镜头语言` 和 `Seedance 模型提示词说明`。

职责边界：只产出镜头计划，不写提示词正文。

独立使用场景：分镜讨论，或人工修改镜头计划后继续生成提示词。

### 9.6 shot-prompting

负责把镜头计划变成 PromptIR 和模型提示词。

输入：`shot_plan.json`、同 run 的 `script_analysis.json`（只读，提供
`subject`/`action`/`setting`/`time`/`lighting`/`color`/`style` 等画面文本要素，
必须先通过 `validate_stage_artifact(script_breakdown)`）和知识包。

输出：`prompts.ir.json` 和 `prompts.<model>.md`。`prompts.ir.json`
包含按镜头记录的知识引用；`knowledge_refs.json` 由入口最后聚合。

- 为每个镜头构造检索查询，执行过滤和关键词检索，按镜头组装知识上下文。
- 生成 PromptIR。
- 调用 `validate_prompt` 校验硬规则，失败时按结构化错误重新生成。
- 调用 `render_prompt` 渲染目标模型提示词。
- 依赖提示词技巧、Seedance 2.0 和 2.5 软知识和模型规则文件。

职责边界：不修改镜头计划。需要改镜头时回到 `shot-planning`。

独立使用场景：用户自带镜头计划，只出提示词；此时仍需要同一 run 里通过校验的
`script_analysis.json`，或由调用方提供等价的画面文本要素。

## 10. 检索设计

每阶段的查询配方、上下文上限和知识引用聚合规则见 `references/stage-conventions.md`。

### 10.1 过滤顺序

```text
知识范围过滤
  -> 项目过滤
  -> 知识分类过滤
  -> 目标模型过滤
  -> 关键词检索
  -> 规则排序
  -> 上下文组装
```

`script-breakdown` 的所有检索都不按目标模型过滤；其他阶段执行上表完整过滤。

过滤条件：

| 条件 | 示例 |
| --- | --- |
| `scope` | `general`、`project` |
| `project_id` | 当前项目 ID |
| `category` | 角色、场景、风格、拆镜、分镜、技巧 |
| `target_model` | `seedance-2.0`、`seedance-2.5` |

插件不做用户权限过滤。飞书是否允许访问，由飞书和当前 `lark-cli` 登录态决定。

### 10.2 关键词检索和规则排序

第一版只做关键词检索，不引入向量索引、嵌入模型或模型重排。

排序规则固定为：

1. 标题或实体精确命中优先。
2. 标题或标签部分命中其次。
3. 正文命中再次。
4. 相同命中级别按 `priority` 降序。
5. 仍相同时按 `updated_at` 降序。

这样不引入权重参数，结果也可重复验证。

### 10.3 知识包

每次生成前加载一个知识包，范围包括：

- 通用知识。
- 当前项目知识。
- 与当前目标模型兼容的 Seedance 软知识。
- 当前任务的模型选择。

知识包只包含当前项目需要的内容，避免其他项目知识混入。

Seedance 软知识是模型级条款，不受 `scope` / `project_id` 限定：`project_id` 不是
访问边界（见第 12 章），凡是 `category = "seedance_rule"` 且通过目标模型门
（`target_models` 含当前模型，或为空/缺失）的卡片都属于知识包的 Seedance 块，
无论它挂在 general 还是某个项目下；这类卡片也只由 Seedance 块承接，不再被
general / project 块重复归类。

### 10.4 诊断输出（explain）

`search_knowledge` 和 `load_knowledge_pack` 支持 `explain` 参数，默认关闭。

开启后，除候选卡片外返回每条候选的诊断信息：

- 命中级别：精确、部分或正文命中。
- 过滤结果：被哪一条过滤条件淘汰，取值 `scope`、`project_id`、`category` 或 `target_model`。
- 来源版本：`source_doc_token`、`source_revision` 和 `last_synced_at`。
- 回退路径：关键词索引不可用或检索为空时实际走的降级路径。

规则：

- `explain` 只返回给调用方，不写入运行产物，也不新增输出文件。
- 降级情况必须同时写进 warnings，不能只在 `explain` 中体现。

## 11. 剧本输入和提示词生成

### 11.1 支持的输入

| 输入类型 | 说明 |
| --- | --- |
| `script_segment` | 一段剧本或一个片段 |
| `single_episode` | 一集完整剧本 |
| `multiple_episodes` | 多集剧本，作为一次任务输入，不自动拆分为多个 run |

插件不要求用户输入整部剧，也不承担整部剧的世界观管理。跨集一致性主要依赖项目知识中的角色圣经、场景说明和视觉风格。

多集输入不设置硬性镜头上限，也不做自动按集拆分。入口在识别到多集或长输入时
写入 warnings，建议用户按集运行以控制单次会话长度。

### 11.2 生成流程

端到端默认路径由 `script2shot` 入口编排，三个阶段各有一个稳定产物：

```text
剧本文本
  -> script-breakdown -> script_analysis.json
  -> shot-planning    -> shot_plan.json
  -> shot-prompting   -> prompts.ir.json -> prompts.<model>.md
```

1. 入口读取剧本文本，识别输入模式，要求用户提供 `project_id`、单一
   `target_model` 和可选 `aspect_ratio`。
2. 入口读取 AI 库的 `SyncState`，只刷新发生变化文档对应的本地索引。
3. 入口创建运行目录和 `run.json`。
4. `script-breakdown` 输出 `script_analysis.json`，入口调用 `validate_stage_artifact` 校验。
5. `shot-planning` 加载项目知识包，输出 `shot_plan.json`，入口校验。
6. `shot-prompting` 为每个镜头构造检索查询，执行过滤和关键词检索，组装知识上下文。
7. `shot-prompting` 生成 PromptIR，调用 `validate_prompt` 校验硬规则，失败时按结构化错误重新生成。
8. `shot-prompting` 调用 `render_prompt` 渲染目标模型提示词。
9. 入口读取三个阶段产物中的引用，生成 `knowledge_refs.json`，聚合提示词和
   警告，并更新 `run.json`。

#### 阶段契约与续跑

三个阶段只通过文件产物交接，不依赖会话上下文。

`run.json` 记录一次运行的上下文和阶段状态；`aspect_ratio` 是可选运行级参数，
取值为 `16:9`、`4:3`、`1:1`、`3:4`、`9:16`、`21:9`，缺失时由调用方在提示词阶段补充：

```json
{
  "run_id": "run-20261020-120000",
  "input_mode": "single_episode",
  "project_id": "demo",
  "target_model": "seedance-2.5",
  "aspect_ratio": "16:9",
  "stages": {
    "script_breakdown": {
      "status": "done",
      "artifact": "script_analysis.json",
      "updated_at": "2026-10-20T12:00:00+08:00"
    },
    "shot_planning": {
      "status": "done",
      "artifact": "shot_plan.json",
      "updated_at": "2026-10-20T12:05:00+08:00"
    },
    "shot_prompting": {
      "status": "pending",
      "artifact": null,
      "updated_at": null
    }
  }
}
```

规则：

- 每个阶段可以独立运行，但要求上游产物存在且通过 schema 校验。
- 用户请求中的 `from` 参数从指定阶段开始并复用上游产物；`only` 参数只执行一个阶段。
- 阶段产物被人工修改后，必须重新校验再运行后续阶段。
- `script_analysis.schema.json` 和 `shot_plan.schema.json` 是阶段之间的冻结接口，修改视为不兼容变更。
- 阶段之间的路径、命名和状态约定写在 `references/stage-conventions.md`，三个阶段 Skill 引用同一份。

### 11.3 PromptIR

```json
{
  "shot_id": "s01-sh03",
  "target_model": "seedance-2.5",
  "duration": 8,
  "aspect_ratio": "16:9",
  "subject": "角色A",
  "action": "在雨夜穿过旧城区巷道",
  "setting": "狭窄巷道，湿润砖墙，霓虹灯反射",
  "time": "night",
  "camera_angle": "low-angle",
  "camera_movement": "handheld",
  "lighting": "low-key neon lighting",
  "color": "cool cyan and red accents",
  "style": "neo-noir cinematic realism",
  "continuity": {
    "previous_shot": "s01-sh02",
    "character_state": "wet coat, holding black umbrella",
    "environment_state": "heavy rain"
  },
  "negative_prompt": [],
  "knowledge_refs": []
}
```

PromptIR 的结构化枚举和字段标识使用英文；最终渲染的 Seedance 提示词正文
统一使用中文。用户没有额外指定语言时不生成英文提示词。

### 11.4 Seedance 模型适配

插件内置两个模型规则文件：

- `rules/models/seedance-2.0.json`
- `rules/models/seedance-2.5.json`

规则文件负责：

- 模型名称和标识。
- 支持的输入字段。
- 时长和画幅等硬约束。
- 必填字段。
- 禁止项。
- 提示词渲染模板。
- `source`：规则来源。
- `checked_at`：规则核对日期。

原始库和 AI 库可以保存 Seedance 的软知识、经验和技巧。硬规则由插件规则文件负责，避免只依赖模型记忆。

### 11.5 输出

```text
.script2shot/outputs/<run_id>/
  run.json
  script_analysis.json
  shot_plan.json
  prompts.ir.json
  prompts.<model>.md
  knowledge_refs.json
  warnings.md
```

`run.json` 记录本次运行的输入模式、项目、目标模型、可选画幅和各阶段状态，用于续跑和排查。

`knowledge_refs.json` 由入口根据三个阶段产物中的引用记录生成，只包含
`used` 和 `dropped_by_budget`。

## 12. 多用户模式

所有用户共用同一套飞书知识库。

每个用户可以：

- 修改原始库。
- 运行插件生成提示词。
- 在约定允许时触发 AI 库同步。

同步约定：

- 同一时间只有一个人执行 AI 库同步。
- 同步人员只处理发生变化的文档。
- 同步人员完成一个文档的同步后，更新该文档对应的 `SyncState` 记录。
- 其他用户通过读取 AI 库的按文档 `SyncState` 判断哪些文档需要刷新本地缓存。
- 插件不实现用户权限控制。
- 插件不实现并发锁。
- 飞书权限由用户在飞书内自行管理。

插件不做项目级权限隔离。若项目之间需要隔离，应在飞书中使用独立 Base 或
Base 权限，而不是依赖 `project_id` 过滤承担访问控制。

## 13. 失败处理

| 场景 | 处理方式 |
| --- | --- |
| 找不到 lark-cli | 提示用户安装或配置路径 |
| 未登录飞书 | 引导用户执行 `lark-cli auth login` |
| AI 库不存在 SyncState | 提示先运行 `knowledge-sync` |
| AI 库不可达 | 有本地缓存时继续运行并写 warning；无缓存时停止 |
| SyncState 全表为空但本地有文档 | 删除行为不变；产生删除前写 `SYNC_STATE_EMPTY` warning，提示可能是 SyncState 表为空或 `lark.sync_state_table_id` 指向空表 |
| 卡片 `source_revision` 与 SyncState 不一致 | fail-closed 返回 `KB_READ_FAILED`，`details` 记录文档、行号与两侧 revision；不写本地缓存或索引 |
| 原始库元数据读取失败 | 停止扫描并提示失败原因 |
| 单个文档正文读取失败 | 跳过该文档，其他文档继续同步 |
| 单个文档知识卡写入失败 | 不更新该文档 SyncState，下次只重试该文档 |
| 本地缓存过期 | 只刷新发生变化文档对应的索引数据 |
| 关键词索引 missing / corrupt / unreadable | 回退到本地缓存并写 `INDEX_UNAVAILABLE` warning：`search_knowledge` 按 `priority` 降序返回缓存候选，`load_knowledge_pack` 用缓存卡片按同一套来源块 / target model 规则组装知识包；warning 与错误 `details` 保留 `index_state` / `index_read_failed`；缓存也不可用时才报错 |
| 关键词索引 ready 后读取失败 | 与索引 missing / corrupt / unreadable 一样回退缓存并写 `INDEX_UNAVAILABLE`；warning 说明并发重建或占用可能；`refresh_local_index` 写路径 fail-closed，保留索引文件 |
| 本地索引卡片归属不一致 | 索引写入在事务开始前拒绝并保持索引原样；工具层同时给出文档与行号上下文 |
| 阶段产物缺失或 schema 校验失败 | 停止该阶段，提示缺少的上游产物或字段，不进入下一阶段 |
| 阶段产物被人工修改 | 重新校验通过后，从该阶段之后继续运行 |
| `run.json` 与产物不一致 | 阶段状态以产物为准重新校验并修正；身份字段（`run_id`、`input_mode`、`project_id`、`target_model`）与产物冲突时 fail-closed：冲突产物所属阶段置 `failed`，写 `RUN_STATE_RECONCILED` warning（`details.conflicts[]` 逐条记录 `artifact` / `field` / 两侧取值），不重写 `run.json` 的身份字段 |
| 目标模型未知 | 只支持 `seedance-2.0` 和 `seedance-2.5` |
| 硬规则校验失败 | 返回结构化错误并重新生成 |

## 14. 最小落地顺序

### 验证基线

实现各阶段时至少建立以下验证：

- schema fixture 能拒绝缺失必填字段和错误枚举。
- 同一文档重复执行 `replace_doc_cards` 不产生重复卡。
- 分类、项目、目标模型过滤各有正例和反例。
- Seedance 2.0、2.5 渲染结果有快照测试。

### Phase 1：插件和飞书连接

- 创建 Codex 插件骨架。
- 实现 `setup` Skill。
- 实现 `health`。
- 支持 lark-cli 路径发现和登录检查。
- 配置原始库和 AI 库。
- 记录 lark-cli 版本，并检查 Wiki 节点扫描、文档读取和 Base 批量记录写入能力。
- 在实现 MCP Server 前确定其语言、构建工具和运行方式并写入第 7.1 节。

### Phase 2：知识库同步

- 由 `setup` 建立或校验 AI 库的 `KnowledgeCards` 和 `SyncState`。
- 实现原始库节点元数据扫描和变化比较。
- 实现单文档正文读取。
- 实现 `knowledge-sync` Skill。
- 实现 `replace_doc_cards` 和 `update_doc_sync_state`。
- 实现删除文档对应的知识卡和状态清理。

### Phase 3：本地检索

- 实现本地缓存。
- 实现 SQLite 关键词索引。
- 实现 `refresh_local_index`、`search_knowledge` 和 `load_knowledge_pack`。

### Phase 4：阶段技能与提示词生成

#### 4a：剧本解析

- 定义 `script_analysis.schema.json`。
- 实现 `script-breakdown` Skill，支持片段、单集和多集输入。
- 实现 `validate_stage_artifact` 的解析产物校验。

#### 4b：镜头规划

- 定义 `shot_plan.schema.json`。
- 实现 `shot-planning` Skill。
- 落地目标模型的时长和镜头拆分边界。

#### 4c：提示词生成

- 实现 PromptIR 和 Seedance 2.0、Seedance 2.5 规则文件。
- 实现 `shot-prompting` Skill。
- 实现硬规则校验、修复循环和提示词渲染。

#### 4d：入口编排

- 定义 `run.schema.json`。
- 实现 `init_run`、`read_run` 和 `update_run_state`。
- 实现 `script2shot` 入口编排、`from` 和 `only` 续跑。
- 跑通端到端输出聚合。

### Phase 5：可选增强

- 为 `search_knowledge` 和 `load_knowledge_pack` 实现 `explain` 输出，约定见 10.4。
- 可选实现 `knowledge-inspect` 诊断技能：回答「为什么这条知识没被用上」和
  「某项目的角色圣经是否已同步」，只读 AI 库，不参与主流程。
- `knowledge-inspect` 不进入第 9 章的 Skill 主列表，只在排查知识问题时按需加载。

## 15. 外部参考

- OpenAI Docs: Plugin architecture
  https://developers.openai.com/plugins/concepts/plugins
- OpenAI Docs: Skills
  https://developers.openai.com/plugins/concepts/skills
- OpenAI Docs: Build an MCP server
  https://developers.openai.com/plugins/build/mcp-server
- OpenAI Docs: Submit desktop-only plugins
  https://developers.openai.com/plugins/deploy/desktop-only
- OpenAI Docs: Package your plugin
  https://developers.openai.com/plugins/build/plugins

