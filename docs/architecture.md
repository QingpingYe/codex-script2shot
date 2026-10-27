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
剧本 + 可选参考素材
  → script-breakdown
      script_analysis.json（实体、参考图占位、原文单元、完整过程）
  → shot-planning
      shot_plan.json（scenes[] → clips[] → shots[]、对白轨、AudioCue）
  → shot-prompting
      prompts.ir.json（clips[]）→ prompts.<model>.md（五模块）
  → knowledge_refs.json + warnings.md
```

最终交付单位是一个待生成视频的一段提示词。一个 clip 可以包含多个电影镜头，以完成
一个独立、连续的叙事过程为优先；只有超过模型时长或参考素材上限时，才在自然节点拆分。
四个基础产物统一使用 `schema_version: 2`，并用 SHA-256 内容指纹检查上游失效。
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

- `artifact_version.ts`：v2 版本识别；旧版本返回 `ARTIFACT_VERSION_UNSUPPORTED`。
- `artifact_hash.ts`：递归排序对象键、保留数组顺序的内容指纹；运行输入单独取
  `hash_run_context`。
- `artifact_semantics.ts`：实体、素材、过程、clip、shot、对白分片、AudioCue 和跨产物
  链接的语义校验。
- `schemas.ts` / `validate_stage_artifact.ts`：schema 校验、阶段语义校验和
  `content_hash` 返回。
- `validate_prompt.ts` / `render_prompt.ts`：PromptIR 校验、五模块渲染和失败前不写输出。
- `init_run.ts` / `read_run.ts` / `update_run_state.ts`：v2 run 生命周期、输入指纹和
  下游待重跑判断。
- `aggregate.ts`：带 `clip_id` 的知识引用聚合与 warning 汇总。
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
4. 常见安装目录，其中包含私有 prefix：
   `~/.codex-script2shot/cli/node_modules/@larksuite/cli/bin`。
5. 找不到时由 `$setup` 的 `install-cli` 子命令安装到私有 prefix，不要求用户执行命令。

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
profile **没有默认值**：setup 先用 `profile` 子命令解析活动 profile，再把结果
显式传给 `write_config`。lark-cli 的 profile 由全局 `lark-cli profile use` 切换，
且 CLI 明确要求 AI agents 不得自行切换或删除 profile；插件只通过只读的
`lark-cli profile list` 读取活动 profile 并与配置比对，不调用 `profile use` /
`profile remove`。不一致时 `health` 返回 warning（`LARK_PROFILE_MISMATCH`，
结构化差异），处置是运行 `$setup` 重新解析活动 profile 并更新本地配置值；插件
不得把任何 profile 切换命令转交给用户。

**默认知识库（2026-10-21）。** 插件自带默认知识库配置，默认值唯一来源是
`server/src/setup_defaults.ts` 的 `SETUP_DEFAULTS`：

- `lark.space_a` = `"7695983197091302359"`（原始库空间）；
- `lark.base_b` = `"WRrVblDbqaEFOSs39P0cFzilnfd"`（AI 库的 Base obj_token；
  完整值只出现在源码与配置文件里，运行期输出仍按掩码规则处理）；
- `lark.project_roots` = 一项映射：`node_token = "Ou9Vw0emviJajPklYjQc4fqjnie"`
  （《五夫临门》影游项目知识根节点）→ `project_id = "wufu-linmen"`；
- `retrieval.default_top_k` = `12`。

默认知识库可替换：在 `~/.codex-script2shot/config.toml` 中改对应字段，或在 setup
时提供新值；setup Skill 与 `write_config` 都引用 `SETUP_DEFAULTS`，不重复硬编码。

`write_config` 的缺省填充语义（**显式 > 既有 > 默认**）：显式传入的值（包括
显式空数组）优先；未显式传入且 `preserve_existing`（缺省 `true`）为真时，磁盘
配置里该字段的非空值被保留；仍然缺省时套用上述 `SETUP_DEFAULTS`。返回值用
`applied_defaults[]` 列出本次实际套用默认值的键路径，用 `preserved_existing[]`
列出被保留的既有键路径。`lark.profile` **没有默认值**：未显式传入且磁盘也没有
时返回 `CONFIG_INVALID`，`details.missing_keys` 含 `lark.profile`。显式传
`preserve_existing: false` 时忽略磁盘值、按纯默认语义覆盖（用于显式重写）；磁盘
配置 TOML 损坏时返回 `CONFIG_INVALID`，不静默丢弃。填充后仍校验 `lark.space_a`
与 `lark.base_b` 非空。`config` 必须提供且为普通对象；`lark`、`retrieval` 容器
出现时也必须是普通对象（fail-closed），否则返回 `CONFIG_INVALID` 并在
`details.field` 指明字段。`dry_run`、`create_local_dirs` 与 `preserve_existing`
只接受布尔值，字符串或数字均按 `CONFIG_INVALID` 拒绝；所有字符串字段在写入前
trim。`project_roots` 同样按 trim 后的值校验与保存。

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

运行工具：

- `init_run`：创建 v2 run，接收 `input_references`、`display_timeline`，返回
  `run_context_hash`。
- `read_run`：先做版本检查，再校验阶段产物、身份、上游指纹；返回
  `run_context_hash`，内容变化时把下游标为待重跑。
- `update_run_state`：只更新状态和 warning，不改变运行输入。

校验与渲染：

- `validate_stage_artifact`：解析/规划 schema 与语义校验；规划可传
  `script_analysis_path`；成功返回 `content_hash`。
- `validate_prompt`：PromptIR schema、模型规则、clip/shot/对白/素材/指纹校验；可传
  `shot_plan_path` 和 `script_analysis_path`；错误形状为
  `{ clip_id, shot_id, field, code, message }`。
- `render_prompt`：一个 clip 渲染一份五模块 Markdown；2.5 强制秒数，2.0 按
  `display_timeline`；失败不创建或覆盖输出。

聚合工具继续生成 `knowledge_refs.json` 和 `warnings.md`。
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

- 由 AI 执行确定性自举脚本（`scripts/setup_bootstrap.mjs` 的八个子命令），人类只
  做浏览器操作与同意 / 拒绝；技能不得要求用户执行终端命令、填写路径或参数。
- 查找或安装 `lark-cli`、编排设备登录、解析活动 profile。
- 配置原始库和 AI 库。
- 创建或校验 `KnowledgeCards` 和 `SyncState`，保存固定 `table_id`。
- 初始化本地目录。
- 提示用户可在需要时运行 `$knowledge-sync` 完成首次同步与本地索引构建，不在 setup
  内自动执行。

**执行顺序（2026-10-23）。** `doctor` → `ensure-runtime` → `build-server` →
`install-cli` → `ensure-app` → `auth-login`（人类只做浏览器操作）→ `profile` →
组装配置 → `call-tool read_config` 读既有配置 → `call-tool health(pending_config)`
只读可达性预检 → `write_config` / `init_knowledge_b` 的 dry-run 预览 → **一次写入
确认** → 执行 → `health` 复查。配置写入与建表都经 `call-tool` 完成，因此本会话
MCP 连接未建立时 setup 也能走完；构建完成后新开会话即可正常使用其余技能。

**人类动作与验收口径。** 人类动作只有三类：浏览器操作（应用创建、设备授权，常规
路径 1–2 次）、写入确认（常规路径 1 次）、授权决策（提权申请、允许系统级 npm
安装、`--force-init` 同意；仅异常路径，按需各 1 次）。常规路径（本机已有应用、
网络与提权可用、默认知识库可达）下只出现前两类；授权决策只在结构化错误码触发时
出现，由 AI 发起并附一句话影响说明（改什么、风险是什么、不做的后果），由用户在
对话里回答，而不是被要求去执行命令。另有一类**可选**的人类输入：默认知识库不可达
且用户主动要求替换时，用户可粘贴 Wiki / Base 链接（只粘贴链接，不填 token、不填
路径），由 AI 用 lark-cli 解析并回显确认。

**既有配置优先。** 重跑 setup 时按 **用户显式替换 > 既有非空值（保留）>
`SETUP_DEFAULTS`（默认）** 决定每个字段，由 `write_config` 的 `preserve_existing`
在服务端落地：AI 只传显式替换项与解析出的 `profile` / `cli_path`，两个
`table_id`、`base_b`、`space_a`、`project_roots`、`retrieval.default_top_k` 由工具
保留，掩码字段不经过对话。预览必须同时展示 `preserved_existing[]` 与
`applied_defaults[]`。

**默认知识库不可达。** 写入前的只读预检 `health(pending_config)` 先检查可达性；
报 `KB_A_UNREACHABLE` / `KB_B_UNREACHABLE` 时**不进入写入确认**，走两条合法路径
之一：权限类（应用未被加入该空间 / Base）停止，用一句话说明"需要管理员把本机自建
应用加入该资源"以及所需 scope，等用户处理后重跑；用户主动要求替换时，允许用户
粘贴 Wiki / Base 链接，由 AI 用 lark-cli 解析成 id 并回显确认（token 只显示前 6 位
加 `…`），然后重新走预览 + 确认。

**禁止项。** 不把命令、路径、参数交给用户代跑；不复述 token；不调用 `profile use` /
`profile remove`；技能消费 `health` 的 `detail.code`，不得把工具返回里的命令式文案
转述给用户。`build-server` 需要写插件目录，沙箱内被拒时按 `NEEDS_ESCALATION` 处理
（申请提权后重跑），不得改成让用户在终端里构建。`health` 报 profile 不一致时，AI
重新解析活动 profile 并用 `write_config` 更新本地配置值（预览 + 确认），把差异
消掉。

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

收集 `project_id`、单一目标模型、可选画幅、`input_references` 和
`display_timeline`；创建 v2 run 后依次执行三个创作 Skill。每阶段校验成功后才更新
`run.json`，并把工具返回的 `content_hash` 交给下游。续跑时先由 `read_run` 识别版本、
混合版本和内容指纹；v1 不迁移。入口最后汇总知识引用与 warning。

**参数收集是硬规则（入口 Skill 与代理共同遵守）。** 运行输入由用户给定，入口不得替用户假设：

- 必填项 `project_id`、`input_mode` 和单一 `target_model` 缺失时，先向用户确认再创建 run；
  不得用默认值、上一次 run 的值或推测顶替。用户一次给出多个目标模型时，先让用户选定一个，或按模型拆成多次 run。
- `aspect_ratio` 未指定时先问用户；只有在确实无法询问的运行方式下，才允许使用显式默认，
  并必须把默认值及其来源写进 run 级 warning，不得静默假设。
- `input_references` 与 `display_timeline` 属可选输入：缺省即「无外部素材」与「不显示时间轴」，交付说明里要写明本次取值。
- 这些字段参与 run 上下文指纹（`input_mode`、`project_id`、`target_model`、`aspect_ratio`、`input_references`、`display_timeline`），
  run 创建后不可修改；要改只能新建 run，并用新的 `run_context_hash` 重发三个阶段产物。
- 工具层不提供询问能力：`init_run` 只做参数校验与建目录，因此询问发生在调用 `init_run` 之前，由入口 Skill / 代理承担。

### 9.4 script-breakdown

把剧本解析为实体台账、参考素材槽、原文单元和完整过程。仅剧本输入时为每个角色、
场景、关键道具建立 image 占位；用户提供素材时记录真实来源和采用/排除职责。每个动作、
情绪、对白单元记录实体引用，每个应表现单元归入且仅归入一个过程。

### 9.5 shot-planning

按「完整过程 → 对白/动作时间 → 内部切镜 → 上限检查 → 自然拆段」规划
`scenes[].clips[].shots[]`。clip 总时长使用模型整数秒边界；内部 shot 允许小数秒。
规划对白轨、AudioCue、参考绑定和前后状态；完整过程默认一个 clip，切镜本身不拆段。

### 9.6 shot-prompting

为每个 clip 写 PromptIR，并渲染固定五模块：【生成目标】【参考素材职责】【主体与关系】
【事件脚本】【保持一致】。Seedance 2.5 每个视觉镜头、对白片段和 AudioCue 都有秒数；
2.0 按运行偏好显示。素材标签按本段连续编号，asset ID 跨视频稳定；台词按 UTF-16 offset
切片但逐字保真。PromptIR 和 Markdown 均由确定性工具校验/渲染，最多两轮定点修复。
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

一次 run 支持片段、单集或多集剧本，指定一个 `project_id`、一个目标模型和可选
`aspect_ratio`。用户可以补充 `input_references[]`（本地路径或素材标识、职责、排除范围）
和 `display_timeline`。没有实际素材时仍继续，由解析阶段生成参考图占位并写入 warning。

### 11.2 生成流程与续跑

1. `read_run` / `init_run` 返回 `run_context_hash`。
2. 解析阶段写 `script_analysis.json` 和 `input_hashes.run_context`。
3. 规划阶段读取解析校验返回的 `content_hash`，写
   `input_hashes.script_analysis`。
4. 提示词阶段写入解析和规划两个指纹。
5. `read_run` 在任何状态写回前检查四个 schema 版本、身份和指纹；上游变化未同步时，
   受影响的规划或提示词阶段标为待重跑，原文件保留。
6. v1、缺版本、未来版本或混合版本返回 `ARTIFACT_VERSION_UNSUPPORTED`，不自动迁移。

### 11.3 PromptIR v2

顶层为 `clips[]`，每个 clip 对应一份视频提示词，包含生成目标、素材职责、主体关系、
多镜头事件脚本、对白轨、AudioCue、连续性、风格和 negative_prompt。PromptIR 不另存
自由文本时间轴；渲染完全从结构化的 clip/shot/dialogue/audio 数据生成。

### 11.4 Seedance 模型适配

时长、画幅、参考图片上限和时间轴强制只以 `rules/models/*.json` 为运行时事实来源。
Seedance 2.0 为 4–15 秒、最多 9 张图片，秒数默认关闭；Seedance 2.5 为 4–30 秒、
最多 30 张图片，秒数强制开启。内部 shot 不受模型时长下限单独限制。

### 11.5 输出

七个文件名保持不变；新增版本、指纹和 `clip_id` 字段。`knowledge_refs.json` 按阶段 →
视频 → 镜头聚合；`warnings.md` 包含参考图待提供等非阻断信息。
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

| 情形 | 处理 |
| --- | --- |
| 版本缺失、v1、未来版本或混合版本 | 返回 `ARTIFACT_VERSION_UNSUPPORTED`，不改写文件 |
| 上游内容指纹变化 | 下游标记为待重跑；不直接用旧下游继续 |
| clip 总时长或内部时间轴非法 | 返回 `TIMELINE_INVALID`，在规划阶段定点修复 |
| 原文单元、过程、对白或声音来源未覆盖 | 返回 `SOURCE_COVERAGE_INVALID` |
| 素材身份、状态、绑定或职责非法 | 返回 `REFERENCE_ASSET_INVALID` |
| 单视频图片数超过模型上限 | 返回 `REFERENCE_LIMIT_EXCEEDED`，先按自然过程边界拆分 |
| 2.5 关闭时间轴 | 返回时间轴错误；知识卡或风格偏好不能覆盖强制规则 |
| 参考图待提供 | 不阻断；保留占位并在 warning 中标记待提供 |
| 渲染校验失败 | 不创建或覆盖输出文件，保留 PromptIR 供修复 |
## 14. 最小落地顺序

### 验证基线

- 版本与内容指纹纯函数测试。
- v2 schema、实体/过程、clip 时间轴、对白分片和 AudioCue 测试。
- 跨产物指纹和待重跑测试。
- 两模型五模块 golden、2.5 强制秒数和 2.0 时间轴偏好测试。
- MCP 广告 schema、无输出写入失败路径和完整构建测试。

### Phase 4 完成状态

剧本解析、规划、提示词与入口均已升级到 v2：`process → clip → shot` 数据层级、素材
占位、五模块渲染、内容和运行指纹、v1 拒绝续跑均已实现。Phase 5 仍是可选增强项。
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
