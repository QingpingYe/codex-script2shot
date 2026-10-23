---
name: script-breakdown
description: 把剧本文本解析成结构化产物 script_analysis.json——判定输入模式、按集拆场景并输出节拍与动作/情绪/对白单元和镜头组建议，检索通用与项目知识补全连续性字段，产物校验通过后写入运行目录。
---

# script-breakdown

把剧本文本解析成 `script_analysis.json`：判定输入模式、按集拆场景，产出节拍、动作
单元、情绪单元、对白单元与镜头组建议，并把通用知识和项目知识引用写进产物。这是
`script2shot` 链路的第一个阶段，阶段 key 为 `script_breakdown`，产物文件名固定
（`references/stage-conventions.md` §1）。

阶段只通过文件产物交接，不依赖会话上下文（stage-conventions §2）。本 Skill 只调用
MCP 工具，不自己实现检索、排序、校验或渲染。

## 适用时机

- 入口 Skill `script2shot` 跑到 `script_breakdown` 阶段，或用户要求从本阶段重跑。
- 只要场次表、角色表，不要提示词（架构 §9.4 的独立使用场景）。
- 前置：运行目录 `.script2shot/outputs/<run_id>/` 已由入口创建，`run.json` 可读。
  本阶段没有上游阶段产物，所以不做上游产物校验（流程 1「上游无要求」）。

## 输入

- 剧本文本：片段、单集或多集，由入口/调用方提供。
- `run.json`：读取 `run_id`、`input_mode`、`project_id`、`target_model`。
  - `run_id` 形如 `run-YYYYMMDD-HHMMSS`（stage-conventions §1）；
  - `input_mode` 取 `script_segment` / `single_episode` / `multiple_episodes`；
  - `project_id` 用于第 5 步的项目知识检索；
  - `target_model` 只原样写入产物的同名字段（schema 必填），本阶段检索不使用它
    （架构 §9.4、§10.1 例外）。
- 知识：只经 `search_knowledge` 检索本地索引/缓存里的通用知识与项目知识，内容来自
  AI 库；索引状态、降级与 warnings 语义以工具返回为准（stage-conventions §3.1、§5）。
  本阶段不用 `load_knowledge_pack`。

## 流程

1. **读取 `run.json` 确认 `run_id`、`input_mode`、`project_id`**；上游无要求。同时读出
   `target_model` 备用（只写产物，不做检索过滤）。`run.json` 缺失、不可读或字段缺失时
   按「失败处理」停下，不猜 `run_id` / `project_id`。
2. **判定输入模式（片段 / 单集 / 多集）**；多集时识别集边界但保持单 run：不自动拆分、
   不写多个 run，把「建议按集运行以控制单次会话长度」的提示随结果报给入口（架构 §11.1）。
3. **开场加载一次通用知识**：调用
   `search_knowledge({ query: "剧本解析", scope: "general", categories: ["shot_breakdown"] })`，
   **不传 `target_model`**。
4. **按集拆分场景**，输出节拍、动作单元、情绪单元、对白单元、镜头组建议；保持原文
   边界，不新增剧情、角色、事件、结局。
   - 每个场景写 `scene_id`、`heading`、`summary`、`location`、`time_of_day`、
     `characters`，再写四类单元和 `shot_group_suggestions`，字段以
     `schemas/script_analysis.schema.json` 的 `scene` 定义为准（见「输出」）。
   - 节拍用 `beats[].action_unit_ids` 引用同一场景内的动作单元 `id`，形成可追溯的
     原文对应关系；`id` 在同一 run 内唯一且稳定（如 `ep01-sc01-a01`）。
   - 镜头组建议只写分组意图与覆盖提示（`purpose`、`characters`、`coverage_hint`），
     不落到具体镜头数量、时长、景别或组接。
5. **每个角色或场景首次出现时检索一次项目知识**：
   `search_knowledge({ query: "<名称 + 原文动作/地点/服装描述>", scope: "project", project_id, categories: ["character_bible", "scene_description", "visual_style", "project_rule"] })`；
   结果写入 `continuity`，并逐条记入 `knowledge_refs`。
   - 同一角色或场景只在首次出现时检索一次；后续出现沿用已写入的连续性条目，不重复
     调用；出现新角色或新场景时再检索一次。
   - `continuity` 分 `characters` / `scenes` / `style` 三类，条目为
     `{ name, card_ids, summary }`；采用的卡 `card_id` 同时出现在 `card_ids` 和
     `knowledge_refs[].card_id` 中。
   - `knowledge_refs` 条目按 stage-conventions §4 的结构写全 `card_id`、`scene_id`、
     `shot_id`（本阶段固定 `null`）、`query`、`usage`、`source_doc_token`、
     `source_path`、`source_revision`、`last_synced_at`；`usage` 只取
     `used` / `dropped_by_budget`，进入候选但未采用的卡不记录。
   - 检索结果不得补写原文没有的剧情、关系和事件（stage-conventions §3.2 边界）。
6. **原文缺失信息写入 `missing_info`**（代码 + 中文说明 + 定位 id），不猜测补写。
   每条为 `{ code, message, scene_id }`：`code` 用稳定的大写标识（如
   `SCENE_TIME_UNKNOWN`），`message` 写中文说明，`scene_id` 指向缺失信息所在的场景。
7. **写 `script_analysis.json`（含 `knowledge_refs` 与 `generated_at`），调用
   `validate_stage_artifact` 自检；失败按错误修复后重写。**
   - 调用
     `validate_stage_artifact({ stage: "script_breakdown", path: "<workspace>/.script2shot/outputs/<run_id>/script_analysis.json" })`，
     只有返回 `ok: true` 才算本阶段完成。
   - 返回 `ok: false` 时按 `errors[].path`（JSON Pointer）逐条修正，重写整份产物后
     重新校验；文件级错误码按「失败处理」处理。
   - 本阶段不更新 `run.json` 的阶段状态；阶段状态由入口在产物校验通过后写入
     （stage-conventions §2）。

## 知识检索配方

依据 stage-conventions §3.2，本阶段有且只有两类检索，参数照下面固定值传，不自行
加过滤条件：

**开场方法论（每次运行一次）**

```json
{"query": "剧本解析", "scope": "general", "categories": ["shot_breakdown"]}
```

**实体粒度（每个角色或场景首次出现时一次）**

```json
{"query": "<名称 + 原文动作/地点/服装描述>", "scope": "project", "project_id": "<project_id>", "categories": ["character_bible", "scene_description", "visual_style", "project_rule"]}
```

- 粒度：输入中每个角色或场景首次出现时检索一次；同一实体后续出现不重复检索。
- 查询来源：角色名或场景名，加上原文中的动作、地点和服装描述。
- 用途：补全跨集稳定设定，写入 `script_analysis.json` 的连续性字段。
- 边界：不得用检索结果补写原文没有的剧情、关系和事件。
- 本阶段所有检索都不传 `target_model`（stage-conventions §3.1 例外、架构 §10.1）；
  候选数量按 `retrieval.default_top_k` 由工具默认处理，不额外设置 `max_cards` /
  `char_budget`（§3.5 的按场景/按镜头上限属于下游阶段）。
- `degraded` 与 `warnings` 只返回给调用方，由入口写进 `warnings.md`；`explain` 不在本
  阶段使用，其诊断输出同样只交调用方。三者都不写进 `script_analysis.json`，也不新增
  输出文件（stage-conventions §5、架构 §10.4）。

## 输出

`<workspace>/.script2shot/outputs/<run_id>/script_analysis.json`，结构以
`schemas/script_analysis.schema.json` 为准。这是阶段间的冻结接口，字段不可增删改
（stage-conventions §1、架构 §11.2）：

- `run_id`：`run-YYYYMMDD-HHMMSS`。
- `input_mode`：`script_segment` / `single_episode` / `multiple_episodes`。
- `project_id`：本次运行的项目 ID。
- `target_model`：`seedance-2.0` / `seedance-2.5`，原样取自 `run.json`。
- `episodes[]`：`episode_id`、`title`、`scenes[]`；每个场景含 `scene_id`、`heading`、
  `summary`、`location`、`time_of_day`、`characters`、`beats`（`beat_id`、
  `description`、`action_unit_ids`）、`action_units`（`id`、`description`、
  `characters`、`location`）、`emotion_units`（`id`、`description`、`characters`、
  `tone`）、`dialogue_units`（`id`、`speaker`、`text`、`visual_action`）、
  `shot_group_suggestions`（`id`、`purpose`、`characters`、`coverage_hint`）。
- `continuity`：`characters` / `scenes` / `style`，条目为 `{ name, card_ids, summary }`。
- `missing_info[]`：`{ code, message, scene_id }`。
- `knowledge_refs[]`：`{ card_id, scene_id, shot_id, query, usage, source_doc_token,
  source_path, source_revision, last_synced_at }`，其中 `shot_id` 固定为 `null`。
- `generated_at`：带时区的 ISO 8601 时间。

本阶段只写这一个文件：不创建运行目录总账 `knowledge_refs.json`（由入口在三阶段完成后
聚合），不写 `warnings.md`，也不修改 `run.json`（stage-conventions §1、§2、§4）。

## 边界

- 职责边界：解析到镜头组建议为止；具体镜头数量、时长和组接交给 `shot-planning`。
- 保持原文边界：不新增剧情、角色、事件、结局；原文缺失的信息写 `missing_info`，
  不用检索结果或常识猜测补写（stage-conventions §3.2）。
- 不实现检索、排序、校验或渲染：只调用 `search_knowledge` 与
  `validate_stage_artifact`，不读模型规则文件、不用 `load_knowledge_pack`、不自行
  实现校验或聚合逻辑。
- 不按 `target_model` 过滤：本阶段的全部检索都不传该参数（stage-conventions §3.1、
  架构 §10.1）。
- 不越阶段决策：景别、机位、运镜、时长、转场、镜头拆分和组接留给 `shot-planning`。
- 不写运行状态与总账：`run.json` 的阶段状态由入口维护，`knowledge_refs.json` 由入口
  聚合，本阶段只写自己主产物内的引用。

## 失败处理

| 情形 | 处理 |
| --- | --- |
| `run.json` 缺失、不可读或缺少 `run_id` / `input_mode` / `project_id` / `target_model` | 停止本阶段，报告缺失的文件或字段；不猜值、不创建产物 |
| 输入模式无法判定 | 停下向调用方/用户确认后重跑；不默认按单集处理 |
| `search_knowledge` 返回 `degraded: true` 或 `INDEX_UNAVAILABLE` 类 warning | 按工具返回的候选继续，把 warning 原文交入口写入 `warnings.md`；缓存也不可用（工具返回错误）时停止本阶段并报告 |
| `search_knowledge` 返回 `CONFIG_INVALID` 或空查询类 warning | 修正查询/参数后重试；不伪造知识，也不把 warning 写进产物 |
| 检索结果与原文冲突 | 以原文为准，不采用冲突内容补写；缺口写 `missing_info` |
| `validate_stage_artifact` 返回 `ok: false` 且错误带 JSON Pointer `path` | 按 `errors[].path` 逐条修正 `script_analysis.json`，整体重写后重新校验；不再通过就停下报告错误 |
| 文件级错误码 `STAGE_ARTIFACT_MISSING` / `STAGE_ARTIFACT_UNREADABLE` / `STAGE_ARTIFACT_INVALID_JSON` | 分别按「产物没写出或路径不对」「路径不可读（目录、权限或占用）」「JSON 非法」修正写入步骤，重写后重新校验；错误码只用于报告，不写进产物 |
| 本阶段失败 | 保留已完成的中间产物，不更新 `run.json` 的阶段状态，不进入 `shot-planning`（stage-conventions §2、架构 §13） |
