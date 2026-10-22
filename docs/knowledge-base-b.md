# 飞书知识库 B 内容说明

状态：Draft
日期：2026-10-20
最近修订：2026-10-20（移除 content_hash，固定 Base table_id 初始化）

本文档说明飞书知识库 B 中应该包含哪些表、字段和内容。B 完全由知识库 A 生成，内容不人工维护。

字段定义、同步算法和检索流程见 `docs/architecture.md`。

## 1. 定位

- B 只服务机器检索和提示词生成，不提供人类阅读页面。
- B 只保留最新版本，没有草稿、人工审核、历史快照和版本发布。
- B 的内容全部来自 A 的归纳结果，插件不写入 A。
- B 是同步事实来源，本地缓存和索引只用于性能，不作为同步依据。

## 2. 物理形态与表结构

B 是一个飞书多维表格（Base），不是 Wiki 文档，也不要求放进 Wiki 空间。一个 Base 下挂两张数据表：

| 数据表 | 用途 | 主键 | 访问方式 |
| --- | --- | --- | --- |
| `KnowledgeCards` | 保存最新结构化知识卡 | `card_id` | `base_b` 加 `table_id` |
| `SyncState` | 保存 A 中每个文档的同步状态 | `source_doc_token` | `base_b` 加 `table_id` |

- 数据表的字段有类型，记录有记录 ID，支持按字段过滤和分页。
- 表名固定。`setup` 首次运行时按表名解析 `table_id`，确认后写入本地配置；
  后续运行使用配置中的固定值。
- 如果要在 Wiki 里给人留入口，把同一个多维表格挂成 Wiki 节点即可，插件访问时多一步从节点解析 `obj_token`。
- 不用 docx 文档里的表格承载这两张表：文档表格没有记录级接口，字段无类型，过滤和批量更新都要靠文档块解析。

## 3. KnowledgeCards

知识卡字段与完整示例见 `docs/architecture.md` 5.2。本节只说明每类卡承载什么。

| 分类 | 承载内容 | 主要来源 |
| --- | --- | --- |
| `shot_breakdown` | 拆镜方法、镜头切分、动作单元 | `通用知识/拆镜方法/...` |
| `storyboard` | 分镜结构、镜头顺序和转场 | `通用知识/分镜知识/...` |
| `prompt_technique` | 提示词组织方法和表达技巧 | `通用知识/提示词技巧/...` |
| `camera_lexicon` | 景别、机位、焦段、运镜和灯光术语 | `通用知识/分镜知识/...` |
| `character_bible` | 角色外观、服装、性格和一致性要求 | `项目知识/<project_id>/角色圣经/...` |
| `scene_description` | 场景空间、时间、天气和环境状态 | `项目知识/<project_id>/场景说明/...` |
| `visual_style` | 色彩、材质、光线和整体视觉风格 | `项目知识/<project_id>/视觉风格/...` |
| `project_rule` | 项目级命名、术语和创作偏好 | `项目知识/<project_id>/项目术语/...`、`项目概述/...` |
| `seedance_rule` | Seedance 2.0 和 2.5 的软知识 | `通用知识/Seedance/...` |
| `example` | 正例、反例和改写样例 | `通用知识/提示词技巧/...` |

分类只有这十类，不新增；确需新增时先更新架构文档、schema、代码和测试。

## 4. 知识卡内容要求

- 一张卡只讲一件事，`title` 就是检索入口。
- 内容必须可执行：具体、可见、能转译成画面，不写抽象评价词。
- 同一角色的多张卡使用同一主称谓，别名写进 `tags` 或 `entities`。
- 卡片必须带来源字段：`source_doc_token`、`source_node_token`、`source_path`、`source_revision`、`updated_at`。
- 同一来源文档生成的所有卡共享同一个 `source_doc_token`，文档变化时整组替换。
- `target_models` 只填 `seedance-2.0` 和 `seedance-2.5`；两个模型通用时留空。
- `tags`、`entities` 和 `target_models` 统一保存为 JSON 文本数组。
- 不写 `status` 字段，B 中所有卡默认生效。
- 不写硬规则，时长上限、画幅、必填字段和禁止项由 `rules/models/*.json` 负责。

## 5. SyncState

字段定义见 `docs/architecture.md` 5.3。每份 A 文档一条记录，保存 `obj_edit_time`、
`source_revision`、`card_count`、`last_synced_at`、`last_sync_user` 和
`last_run_id`。

它是判断「是否需要同步」的唯一事实来源，本地不保存权威同步状态。

## 6. 不允许出现的内容

| 不允许出现 | 原因 |
| --- | --- |
| 人类阅读页面、教程和示例文档 | B 只给机器用，内容必须结构化 |
| 草稿、审核状态、历史版本 | B 只保留最新有效知识 |
| 剧本原文、生成结果、运行日志 | 剧本只在会话或工作区中传递，不进知识库 |
| 人工直接编辑的知识卡 | B 的内容必须能追溯到 A 的文档 |
| 与 A 不一致的内容 | 冲突时以 A 为准，重新同步，而不是手工修补 |
