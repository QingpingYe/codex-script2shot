# AI 视频提示词 Codex 插件与知识库架构

状态：Draft
日期：2026-10-20
最近修订：2026-10-20（按最小修正清单收敛同步、检索和阶段契约）

## 1. 背景

本项目要开发一个用于生成 AI 视频提示词的 Codex 插件。用户在 Codex 会话中提交剧本片段、一集剧本或多集剧本，插件通过剧本解析、镜头规划和知识检索，为 Seedance 2.0 或 Seedance 2.5 生成视频提示词。

知识来源使用两个飞书知识库：

- 飞书知识库 A：用户维护的原始知识，包括通用知识和项目知识。
- 飞书知识库 B：由插件根据知识库 A 生成的结构化知识卡，供机器检索。

### 1.1 已确定的约束

1. 用户输入可以是一段剧本、一集剧本或多集剧本，不要求输入整部剧。
2. 当前主要视频生成模型是 Seedance 2.0 和 Seedance 2.5。
3. 知识库 A 到知识库 B 的归纳不需要人工审核。
4. 知识卡不需要状态机制，知识库 B 中的所有知识卡默认生效。
5. 知识库 B 只保留最新版，不保存历史版本。
6. 知识库 B 不提供面向人的阅读页面，只保存结构化知识卡和机器检索所需信息。
7. 多人共用同一套飞书知识库，所有人都可以修改知识库 A，并触发知识库 B 更新。
8. 知识库 B 的同步状态必须保存在知识库 B 中，不能把本地状态作为同步依据。
9. 人为约定同一时间只有一个人执行知识库 B 同步，插件不实现并发锁。
10. 知识库 A 只由用户维护，插件只读取，不写入。
11. 剧本不进入知识库 A。剧本只在用户使用插件的会话或工作区中传入。
12. 整个架构尽量简单直观，不引入不必要的服务端和复杂流程。
13. 一次运行只生成一个用户指定模型的提示词。
14. 第一版只做关键词检索和规则排序，不引入向量索引。

## 2. 设计原则

### 2.1 知识库 A 和 B 的职责分离

知识库 A 保存通用知识和项目知识。知识库 B 保存由 A 归纳出的结构化知识卡。B 是 A 的结果，不承担原始资料管理职责。

### 2.2 剧本和知识库分离

剧本是当前任务的输入，不写入知识库 A。知识库只提供拆镜方法、分镜规则、提示词技巧、角色圣经、场景说明和视觉风格。

### 2.3 知识库 B 只保留当前有效知识

知识库 B 没有草稿、审核、发布版本和历史版本。每次同步完成后，B 中保存的就是最新有效知识。

### 2.4 同步状态以知识库 B 为准

知识库 B 中维护一个 `SyncState` 表，记录知识库 A 中每个原始文档的同步状态。所有用户先读取这个表，再决定是否需要刷新本地缓存。本地缓存标记只用于性能，不作为同步事实。

### 2.5 增量同步优先

每次同步先扫描知识库 A 的文档节点元数据，只比较节点身份、
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
│ 飞书知识库 A                                                  │
│                                                              │
│ 通用知识                                                      │
│   拆镜方法、分镜知识、提示词技巧、Seedance 使用经验             │
│                                                              │
│ 项目知识                                                      │
│   角色圣经、场景说明、视觉风格、项目术语                        │
│                                                              │
│ 用户直接维护，插件只读取                                      │
└──────────────────────────────────────────────────────────────┘
                         │
                         │ 节点元数据扫描 + 变更文档读取
                         ▼
┌──────────────────────────────────────────────────────────────┐
│ Codex 本地插件                                                │
│                                                              │
│ knowledge-sync Skill                                         │
│   读取 A -> AI 归纳 -> 生成结构化知识卡 -> 写入 B              │
│                                                              │
│ script2shot Skill（入口编排）                                │
│   刷新本地索引 -> 顺序调用三个阶段 Skill -> 聚合输出         │
│                                                              │
│ script-breakdown：剧本 -> script_analysis.json               │
│ shot-planning：解析 + 项目知识 -> shot_plan.json             │
│ shot-prompting：镜头计划 + 知识 -> PromptIR -> 提示词        │
│                                                              │
│ 本地 MCP Server                                              │
│   lark-cli 适配器                                             │
│   本地缓存和本地关键词索引                                   │
│   关键词检索和规则排序                                       │
│   阶段产物校验、PromptIR 校验和 Seedance 渲染                │
│   运行目录与阶段状态管理                                     │
└──────────────────────────────────────────────────────────────┘
                         │
                         │ 写入知识卡并更新 SyncState
                         ▼
┌──────────────────────────────────────────────────────────────┐
│ 飞书知识库 B                                                  │
│                                                              │
│ 数据表 KnowledgeCards                                        │
│   只保存最新结构化知识卡                                      │
│                                                              │
│ 数据表 SyncState                                             │
│   保存知识库 A 每个文档的同步状态                             │
└──────────────────────────────────────────────────────────────┘
```

## 4. 飞书知识库 A

### 4.1 用途

知识库 A 由用户直接维护，插件只读取。A 不保存剧本，不保存生成结果，也不保存插件运行状态。

A 是一个飞书知识库（Wiki 空间）：每个文档是一个 Wiki 节点，节点下挂 docx 文档，
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

为了让插件能从文档位置推断知识范围和项目归属，知识库 A 建议使用稳定目录：

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

### 4.5 用户操作

用户可以随时修改知识库 A。修改后，由约定的同步人员运行 `knowledge-sync` Skill，把最新知识重新归纳到知识库 B。

插件不监听知识库 A，不自动写入知识库 A，也不修改用户原始知识。

## 5. 飞书知识库 B

### 5.1 用途

知识库 B 只服务机器检索和提示词生成。它不提供人类阅读页面，不保存历史版本，不保存草稿。

B 的物理形态是一个飞书多维表格（Base），不是 Wiki 文档。一个 Base 下面挂两张数据表：

| 数据表 | 用途 | 访问方式 |
| --- | --- | --- |
| `KnowledgeCards` | 保存最新结构化知识卡 | `base_b` 加 `table_id` |
| `SyncState` | 保存知识库 A 每个文档的同步状态 | `base_b` 加 `table_id` |

说明：

- 表是多维表格里的数据表：字段有类型，记录有记录 ID，支持按字段过滤和分页，插件按记录读写。
- 表名固定为 `KnowledgeCards` 和 `SyncState`。`setup` 首次运行时按表名解析
  `table_id`，确认后写入本地配置；后续运行使用配置中的固定 `table_id`。
- B 不要求放进 Wiki 空间。如果希望人在知识库里能找到入口，可以把同一个多维表格作为 Wiki 节点挂载；插件访问时先从节点解析出 `obj_token`，再按多维表格接口读写，多一步解析。
- 不用 docx 文档里的表格承载这两张表：文档表格没有记录级接口，字段无类型，过滤和批量更新都要靠文档块解析，不适合做机器读写的事实来源。

### 5.2 知识卡模型

知识卡是知识库 B 的最小检索单位。

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
| `source_path` | 来源文档在知识库 A 中的路径 |
| `source_title` | 来源文档标题 |
| `source_revision` | 来源文档版本 |
| `source_block_id` | 来源内容块 ID |
| `updated_at` | 最近更新时间 |

知识卡没有 `status` 字段。知识库 B 中的所有知识卡默认生效。

`tags`、`entities` 和 `target_models` 在 Base 中统一存为 JSON 文本数组，
由插件写入和解析。这样不需要为动态标签维护 Base 多选选项。

Base 字段类型固定为：上述三个数组字段使用长文本；`priority` 和
`source_revision` 使用数字；`updated_at` 使用日期时间；其他字段使用文本。

同一个来源文档生成的知识卡必须带有相同的 `source_doc_token`。当该文档发生变化时，插件可以只删除并重建这个 `source_doc_token` 对应的知识卡。

### 5.3 同步状态模型

`SyncState` 是知识库 B 的同步事实来源。

建议一个知识库 A 文档对应一条记录：

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
| `source_doc_token` | 知识库 A 文档对象 token，作为主键 |
| `source_node_token` | 知识库 A Wiki 节点 token |
| `source_path` | 文档在知识库 A 中的路径 |
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

## 6. 知识库 B 增量更新流程

知识库 B 没有人工编辑和人工审核。B 的知识卡完全由知识库 A 生成，因此一个 A 文档可以独立同步，不需要处理其他文档。

### 6.1 增量判断

插件使用以下信息判断文档是否变化：

| 信息 | 来源 |
| --- | --- |
| `node_token` | `wiki +node-list` |
| `obj_token` | `wiki +node-list` |
| `obj_edit_time` | `wiki +node-list` |
| `title` | `wiki +node-list` |
| `parent_node_token` | `wiki +node-list` |

上表只用于扫描阶段。确认文档需要处理后，插件调用 `docs +fetch`，再保存
返回的 `revision_id` 作为 `source_revision`。

### 6.2 增量同步算法

```text
1. 读取知识库 B 的 SyncState 全表
2. 分页扫描知识库 A 的 Wiki 节点元数据
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

如果知识库 A 中只有一个文档新增或修改：

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

### 6.5 失败处理

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
profile = "default"
space_a = "wiki-space-a"
base_b = "base-token-b"
knowledge_cards_table_id = "tbl..."
sync_state_table_id = "tbl..."

[retrieval]
default_top_k = 12
```

### 7.4 本地缓存和索引

本地缓存和索引是从知识库 B 派生出来的临时数据。

刷新流程：

```text
读取知识库 B 的 SyncState 全表
  -> 与本地每个 source_doc_token 的缓存状态比较
  -> 比较 source_revision 和 last_synced_at
  -> 未变化的文档不刷新
  -> 只拉取变化文档对应的知识卡
  -> 只更新这些文档在本地关键词索引中的数据
```

本地缓存标记不是同步状态，只用于避免重复下载和重复建索引。知识库 B 的 `SyncState` 始终是权威同步状态。

## 8. MCP Tool

本地 MCP Server 只负责确定性操作，不负责 LLM 归纳。

| Tool | 作用 |
| --- | --- |
| `health` | 检查 lark-cli、登录状态、知识库配置和本地索引 |
| `scan_knowledge_a` | 只扫描知识库 A 的节点元数据，不读取文档正文 |
| `fetch_knowledge_a_doc` | 只读取一个指定文档的正文和 revision |
| `read_sync_state` | 读取知识库 B 的按文档 SyncState |
| `init_knowledge_b` | 创建或校验 `KnowledgeCards` 和 `SyncState`，返回固定 table_id |
| `replace_doc_cards` | 接收 Skill 生成的新卡，按旧 record_id 集合完成单文档卡片替换 |
| `update_doc_sync_state` | 只更新一个来源文档的 SyncState 记录 |
| `delete_doc_cards` | 删除已移除文档对应的知识卡和状态 |
| `refresh_local_index` | 只刷新发生变化的文档对应的本地索引 |
| `search_knowledge` | 执行过滤、关键词检索和 priority 排序 |
| `load_knowledge_pack` | 加载通用知识、项目知识和 Seedance 规则 |
| `init_run` | 创建运行目录和 `run.json`，记录输入模式、项目 ID 和目标模型 |
| `read_run` | 读取 `run.json` 和阶段状态，用于续跑和聚合输出 |
| `update_run_state` | 更新阶段状态、产物路径和警告 |
| `validate_stage_artifact` | 按 schema 校验 `script_analysis.json` 和 `shot_plan.json` |
| `validate_prompt` | 校验 PromptIR 和 Seedance 硬规则 |
| `render_prompt` | 渲染 Seedance 2.0 或 Seedance 2.5 提示词 |

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
- 配置知识库 A 和知识库 B。
- 创建或校验 `KnowledgeCards` 和 `SyncState`，保存固定 `table_id`。
- 初始化本地目录。
- 可选地执行第一次知识库 B 同步和本地索引构建。

### 9.2 knowledge-sync

负责：

- 扫描知识库 A 的 Wiki 节点元数据。
- 对比知识库 B 的按文档 `SyncState`。
- 只读取新增或修改文档的正文。
- 只为这些变化文档生成结构化知识卡。
- 只替换这些文档对应的知识卡。
- 只更新这些文档的 `SyncState` 记录。
- 处理已删除文档对应的知识卡和状态。

支持指定文档同步模式：

```text
$knowledge-sync 只同步这个文档：<飞书文档 URL 或 token>
```

该 Skill 不写知识库 A，不读取用户剧本，不包含人工审核步骤。

### 9.3 script2shot

入口编排 Skill，本身不做创作判断。

负责：

- 接收一段剧本、一集剧本或多集剧本。
- 要求用户提供 `project_id` 和单一 `target_model`，并识别输入模式。
- 读取知识库 B 的按文档 SyncState。
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

输入：`shot_plan.json` 和知识包。

输出：`prompts.ir.json` 和 `prompts.<model>.md`。`prompts.ir.json`
包含按镜头记录的知识引用；`knowledge_refs.json` 由入口最后聚合。

- 为每个镜头构造检索查询，执行过滤和关键词检索，按镜头组装知识上下文。
- 生成 PromptIR。
- 调用 `validate_prompt` 校验硬规则，失败时按结构化错误重新生成。
- 调用 `render_prompt` 渲染目标模型提示词。
- 依赖提示词技巧、Seedance 2.0 和 2.5 软知识和模型规则文件。

职责边界：不修改镜头计划。需要改镜头时回到 `shot-planning`。

独立使用场景：用户自带镜头计划，只出提示词。

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

1. 入口读取剧本文本，识别输入模式，要求用户提供 `project_id` 和单一
   `target_model`。
2. 入口读取知识库 B 的 `SyncState`，只刷新发生变化文档对应的本地索引。
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

`run.json` 记录一次运行的上下文和阶段状态：

```json
{
  "run_id": "run-20261020-120000",
  "input_mode": "single_episode",
  "project_id": "demo",
  "target_model": "seedance-2.5",
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
  "camera_movement": "handheld tracking",
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

知识库 A 和 B 可以保存 Seedance 的软知识、经验和技巧。硬规则由插件规则文件负责，避免只依赖模型记忆。

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

`run.json` 记录本次运行的输入模式、项目、目标模型和各阶段状态，用于续跑和排查。

`knowledge_refs.json` 由入口根据三个阶段产物中的引用记录生成，只包含
`used` 和 `dropped_by_budget`。

## 12. 多用户模式

所有用户共用同一套飞书知识库。

每个用户可以：

- 修改知识库 A。
- 运行插件生成提示词。
- 在约定允许时触发知识库 B 同步。

同步约定：

- 同一时间只有一个人执行知识库 B 同步。
- 同步人员只处理发生变化的文档。
- 同步人员完成一个文档的同步后，更新该文档对应的 `SyncState` 记录。
- 其他用户通过读取知识库 B 的按文档 `SyncState` 判断哪些文档需要刷新本地缓存。
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
| 知识库 B 不存在 SyncState | 提示先运行 `knowledge-sync` |
| 知识库 B 不可达 | 有本地缓存时继续运行并写 warning；无缓存时停止 |
| 知识库 A 元数据读取失败 | 停止扫描并提示失败原因 |
| 单个文档正文读取失败 | 跳过该文档，其他文档继续同步 |
| 单个文档知识卡写入失败 | 不更新该文档 SyncState，下次只重试该文档 |
| 本地缓存过期 | 只刷新发生变化文档对应的索引数据 |
| 关键词索引不可用 | 按 `priority` 降序回退并写 warning |
| 阶段产物缺失或 schema 校验失败 | 停止该阶段，提示缺少的上游产物或字段，不进入下一阶段 |
| 阶段产物被人工修改 | 重新校验通过后，从该阶段之后继续运行 |
| `run.json` 与产物不一致 | 以产物为准重新校验，并修正 `run.json` 的阶段状态 |
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
- 配置知识库 A 和知识库 B。
- 记录 lark-cli 版本，并检查 Wiki 节点扫描、文档读取和 Base 批量记录写入能力。
- 在实现 MCP Server 前确定其语言、构建工具和运行方式并写入第 7.1 节。

### Phase 2：知识库同步

- 由 `setup` 建立或校验知识库 B 的 `KnowledgeCards` 和 `SyncState`。
- 实现知识库 A 节点元数据扫描和变化比较。
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
  「某项目的角色圣经是否已同步」，只读知识库 B，不参与主流程。
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

