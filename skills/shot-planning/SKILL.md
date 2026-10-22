---
name: shot-planning
description: 在 script2shot 第二阶段把已校验的 script_analysis.json 落实为 shot_plan.json，完成场景知识检索、镜头拆分、景别与运镜设计、时长与转场规划，以及逐镜头连续性状态和来源回指。
---

# shot-planning

把已校验的 `script_analysis.json` 转换为 `shot_plan.json`：逐场景检索镜头决策所需的
项目知识，把镜头组建议落实为景别、机位、运镜、时长、转场和连贯性明确的镜头清单，
记录每个镜头的进入/离开状态及上游镜头组回指。这是 `script2shot` 链路的第二个阶段，
阶段 key 为 `shot_planning`，产物文件名固定（`references/stage-conventions.md` §1）。

阶段只通过文件产物交接，不依赖会话上下文（stage-conventions §2）。本 Skill 只调用
MCP 工具，不自己实现检索、排序、校验或渲染；目标模型规则文件是唯一允许直接读取的
规划参考资料，且只读。

## 适用时机

- 入口 Skill `script2shot` 跑到 `shot-planning` 阶段，或用户要求从本阶段重跑。
- 已有一份通过校验的 `script_analysis.json`，需要得到镜头清单、分镜讨论底稿或
  供 `shot-prompting` 继续消费的 `shot_plan.json`。
- 前置：运行目录 `.script2shot/outputs/<run_id>/` 已由入口创建，上游
  `script_analysis.json` 已存在且通过阶段校验。
- 如果上游产物被人工修改过，先重新调用
  `validate_stage_artifact({ stage: "script_breakdown", path })`，通过后才能进入本阶段。
- 不适用：需要写提示词正文、渲染目标模型提示词或校验 PromptIR；这些属于
  `shot-prompting`。需要新增原文没有的剧情、角色、事件或对白时，回退
  `script-breakdown`，不在本阶段补写。

## 输入

- `script_analysis.json`：上游冻结产物，提供 `run_id`、`project_id`、
  `target_model`、`episodes[].scenes[]`、场景连续性信息、动作/情绪/对白单元和
  `shot_group_suggestions`。字段以 `schemas/script_analysis.schema.json` 为准；
  本阶段只读，不修改上游产物。`run_id` 形如 `run-YYYYMMDD-HHMMSS`
  （stage-conventions §1）；`target_model` 取值为 `seedance-2.0` 或
  `seedance-2.5`。
- `run.json`：可选运行时上下文，用于核对 `run_id`、`project_id`、
  `target_model`。可读时若与已校验的上游产物冲突，停止并报告；不可读时以上游
  产物为准继续，不猜缺失字段。
- 项目知识包：调用 `load_knowledge_pack({ project_id, target_model })` 获取当前项目的
  通用、项目与目标模型兼容的 Seedance 规则知识。
- 场景检索结果：调用 `search_knowledge`，按每个场景一次、场景内每个镜头组可追加一次
  的粒度获取镜头决策知识。本阶段必须传 `target_model`；只有 `script-breakdown`
  有不传该参数的豁免（stage-conventions §3.1）。
- 目标模型规则：只读读取 `rules/models/<target_model>.json`，用于规划镜头时长和拆分
  边界；以目标模型的规则文件为准，最终由
  `validate_stage_artifact({ stage: "shot_planning", path })` 校验。运行环境若通过
  `load_model_rules` 提供同一只读结果，可以等价使用；本 Skill 不新增规则访问工具，
  不自行实现模型规则校验，也不把规则数值写成一套独立权威。
- 知识写入边界：只使用 `shot_breakdown`、`storyboard`、`camera_lexicon`、
  `character_bible`、`scene_description`、`visual_style`、`seedance_rule` 七类知识
  做镜头决策，不取提示词写作技巧（stage-conventions §3.3）。

## 流程

1. **校验上游产物。** 调用
   `validate_stage_artifact({ stage: "script_breakdown", path: "<workspace>/.script2shot/outputs/<run_id>/script_analysis.json" })`；
   只有返回 `ok: true` 才继续。失败即停，不生成、不覆盖 `shot_plan.json`。
   - 校验通过后，从 `script_analysis.json` 读取 `run_id`、`project_id`、
     `target_model`、场景和镜头组建议；若 `run.json` 可读，用其中的同名字段核对。
   - 上游字段缺失或与 `run.json` 冲突时停止并报告，不猜 `run_id`、`project_id`
     或 `target_model`。
2. **加载项目知识包。** 调用
   `load_knowledge_pack({ project_id, target_model })`。把知识包作为本阶段的项目背景；
   `warnings` 原样交调用方处理，不写进 `shot_plan.json`。项目知识包不可用时停止本阶段。
3. **按场景检索知识。** 每个场景调用一次
   `search_knowledge({ query: "<场景目标/情绪弧/角色/地点/时间/镜头组建议>", scope: "project", project_id, categories: ["shot_breakdown", "storyboard", "camera_lexicon", "character_bible", "scene_description", "visual_style", "seedance_rule"], target_model, max_cards: 8 })`；
   场景内每个镜头组可追加一次同参数检索，查询中带上该组的 `purpose`、
   `characters` 和 `coverage_hint`。
   - 每个场景进入生成上下文的卡片不超过 8 张；采用 `search_knowledge` 的
     `max_cards: 8`，不自行扩大候选集或改变排序。
   - 超预算卡片按工具返回的 `dropped_by_budget` 记入本阶段 `knowledge_refs`，使用
     `usage: "dropped_by_budget"`；实际影响镜头决策的卡片使用
     `usage: "used"`。进入候选但未采用的卡片不记录。
   - 被截断卡片的来源元数据从已加载知识包中同 `card_id` 的卡片补齐；无法补齐时
     停止，不伪造 `source_doc_token`、`source_path`、`source_revision` 或
     `last_synced_at`。
   - 同一场景的多次检索结果按工具返回顺序去重后，采用卡片总数仍不超过 8 张；
     超出部分记入 `knowledge_refs` 的 `dropped_by_budget`。
   - 场景级引用写 `shot_id: null`；能明确落到具体镜头的镜头组或镜头级引用写真实
     `shot_id`。同一张卡影响多个镜头时可分别记录对应镜头引用。
   - 检索结果与上游原文或 `script_analysis.json` 冲突时，以上游为准，不采用冲突内容
     新增剧情或改写事实。
4. **把镜头组建议落实为镜头清单。** 按场景遍历 `shot_group_suggestions`，为每个场景
   写出 `shots[]`，逐镜头确定 `shot_size`、`camera_angle`、`camera_movement`、
   `duration_sec`、`transition` 和 `continuity`。
   - 镜头数量、拆分位置和单镜头时长必须落在目标模型的规则文件范围内；先只读目标
     模型规则的 `duration`、`shot_split`（含 `multi_action_rule`）再规划，最终由
     `validate_stage_artifact` 判定。不得在 Skill、产物或注释中另写一套模型数值边界。
   - 拆分服从上游动作、情绪、对白单元和镜头组建议，不把多个独立事件压进同一镜头；
     不为了凑时长新增原文没有的动作、台词或事件。
   - `order` 按场景内镜头的实际顺序写出；`shot_id` 在同一 run 内保持稳定唯一。
   - 景别、机位、运镜和转场只能使用本文件「输出」列出的中文枚举值，字段不得增删改。
5. **写逐镜头连续性与来源回指。** 每个镜头同时写出
   `continuity.enter_state` 和 `continuity.exit_state`，并写
   `source_shot_group_ids`，逐项回指 `script_analysis.json` 中实际使用的
   `shot_group_suggestions[].id`。
   - 进入/离开状态描述本镜头需要交接的角色、环境和道具状态；只整理上游已有信息，
     不用常识或检索结果补写剧情。
   - 一个镜头覆盖多个镜头组时列出全部来源；一个镜头组拆成多个镜头时，每个对应镜头
     都写该组 ID。不得写上游不存在的 ID。
6. **写产物并自校验。** 写
   `<workspace>/.script2shot/outputs/<run_id>/shot_plan.json`，然后调用
   `validate_stage_artifact({ stage: "shot_planning", path: "<workspace>/.script2shot/outputs/<run_id>/shot_plan.json" })`。
   - 返回 `ok: false` 时按 `errors[].path`（JSON Pointer）定位并修正，整体重写产物后
     重新校验；修正后仍不通过就停止并报告，不进入 `shot-prompting`。
   - 只有返回 `ok: true` 才算本阶段完成。本阶段不更新 `run.json` 的阶段状态。

## 知识检索配方

依据 stage-conventions §3.3，本阶段按下面固定参数检索，不自行增加过滤条件或分类。

**项目知识包（每次运行一次）**

```json
{"project_id": "<project_id>", "target_model": "<target_model>"}
```

**场景粒度（每个场景一次）**

```json
{
  "query": "<场景目标/情绪弧/角色/地点/时间/镜头组建议>",
  "scope": "project",
  "project_id": "<project_id>",
  "categories": [
    "shot_breakdown",
    "storyboard",
    "camera_lexicon",
    "character_bible",
    "scene_description",
    "visual_style",
    "seedance_rule"
  ],
  "target_model": "<target_model>",
  "max_cards": 8
}
```

**镜头组追加粒度（每个镜头组最多一次）**

使用与场景粒度完全相同的参数；只把 `query` 换成包含该镜头组 `purpose`、
`characters`、`coverage_hint` 的查询。

- 本阶段所有 `search_knowledge` 调用都必须传 `target_model`。
- 每个场景不超过 8 张卡进入生成上下文（stage-conventions §3.5）；超出的卡按工具
  返回顺序记入 `knowledge_refs`，`usage` 为 `dropped_by_budget`。
- `character_bible`、`scene_description`、`visual_style` 保持正文原文；其余适用卡片可
  压缩为决策要点使用，不逐字复制到产物。
- 只取用于景别、机位、运镜、时长、组接、空间和风格一致性的知识，不取提示词写作技巧。
- `degraded` 与 `warnings` 只返回给调用方，由入口写入 `warnings.md`；`explain` 不在本
  阶段使用，其诊断输出同样只交调用方。三者都不写进 `shot_plan.json`，也不新增输出
  文件（stage-conventions §5、架构 §10.4）。

## 输出

`<workspace>/.script2shot/outputs/<run_id>/shot_plan.json`。结构是
`schemas/shot_plan.schema.json` 定义的冻结接口，所有对象
`additionalProperties: false`，只允许下列字段和值，不得发明字段或枚举值。

**顶层**

| 字段 | 类型 | 取值 |
| --- | --- | --- |
| `run_id` | string | `run-YYYYMMDD-HHMMSS`，匹配 `^run-\d{8}-\d{6}$` |
| `project_id` | string | 取自上游运行上下文 |
| `target_model` | string | `seedance-2.0` / `seedance-2.5` |
| `scenes` | array | `scene[]` |
| `knowledge_refs` | array | `knowledge_ref[]` |
| `generated_at` | string | 带时区的 ISO 8601 时间 |

**`scenes[]`**

| 字段 | 类型 | 取值 |
| --- | --- | --- |
| `scene_id` | string | 沿用 `script_analysis.json` 的场景 ID |
| `shots` | array | `shot[]` |

**`scenes[].shots[]`**

| 字段 | 类型 | 取值 |
| --- | --- | --- |
| `shot_id` | string | 同一 run 内稳定唯一 |
| `order` | integer | 场景内镜头顺序 |
| `duration_sec` | number | 规划时长；最终由 `validate_stage_artifact` 按目标模型规则校验 |
| `shot_size` | string | `大远景`、`远景`、`全景`、`中全景`、`中景`、`中近景`、`近景`、`特写`、`插入镜头` |
| `camera_angle` | string | `平视`、`仰视`、`俯视`、`鸟瞰`、`虫视`、`荷兰角`、`过肩`、`主观视角`、`反打`、`侧面`、`四分之三侧面`、`背身`、`双人镜头` |
| `camera_movement` | string | `固定`、`横摇`、`竖摇`、`推近`、`拉远`、`平移`、`升降`、`摇臂`、`变焦`、`跟拍`、`环绕`、`手持`、`稳定器`、`甩镜`、`滑动变焦`、`跟焦` |
| `transition` | string | `切`、`叠化`、`淡入淡出`、`无` |
| `continuity` | object | `enter_state`、`exit_state`，两项均为 string |
| `source_shot_group_ids` | string[] | 回指上游 `shot_group_suggestions[].id` |
| `notes` | string，可选 | 只写镜头执行备注，不写提示词正文 |

**`knowledge_refs[]`**

| 字段 | 类型 | 取值 |
| --- | --- | --- |
| `card_id` | string | 知识卡 ID |
| `scene_id` | string | 所属场景 ID |
| `shot_id` | string / null | 场景级引用为 `null`，镜头级引用为真实 `shot_id` |
| `query` | string | 本次检索的实际查询 |
| `usage` | string | `used` / `dropped_by_budget` |
| `source_doc_token` | string | 来源文档 token |
| `source_path` | string | 来源路径 |
| `source_revision` | integer | 来源版本 |
| `last_synced_at` | string | 带时区的 ISO 8601 时间 |

本阶段只写这一个文件：不创建或修改运行目录总账 `knowledge_refs.json`，不写
`warnings.md`，不修改 `run.json`，不修改 `script_analysis.json`。

## 边界

- 职责边界：只产出镜头计划，不写提示词正文；需要新增剧情内容时回退
  `script-breakdown`。
- 不越阶段决策：PromptIR、最终提示词、渲染和 PromptIR 硬规则校验交给
  `shot-prompting`；本阶段只决定镜头怎么拆、怎么拍和如何衔接。
- 不实现检索、排序、校验或渲染：只调用 `load_knowledge_pack`、
  `search_knowledge`、`validate_stage_artifact`；模型规则只作为只读规划参考，
  最终校验必须走工具。
- 不扩大检索：只使用本 Skill 固定的七类知识和每场景 8 张卡上限；本阶段所有
  `search_knowledge` 调用都必须传 `target_model`（stage-conventions §3.1）。
- 不越过上游：不新增剧情、角色、事件、动作、台词或对白；只把
  `script_analysis.json` 已有的动作、情绪、对白和镜头组建议落实为镜头计划。
- 不写状态与总账：`run.json` 的阶段状态由入口维护，`knowledge_refs.json` 由入口聚合，
  本阶段只写自己主产物内的 `knowledge_refs`。
- 不把规则数值复制成 Skill 内的独立权威：以目标模型的规则文件为准，并由
  `validate_stage_artifact` 校验。

## 失败处理

| 情形 | 处理 |
| --- | --- |
| 上游缺少 `run_id` / `project_id` / `target_model`，或 `run.json` 存在但与上游冲突 | 停止本阶段，报告缺失或冲突字段；不猜值、不写 `shot_plan.json` |
| 上游 `script_analysis.json` 缺失、不可读或 schema 校验失败 | 停止本阶段，报告 `validate_stage_artifact` 返回的 `errors[].path` 和错误码；不生成下游产物 |
| `load_knowledge_pack` 返回不可用错误 | 停止本阶段并报告工具错误；不使用会话记忆替代知识包 |
| `search_knowledge` 返回 `INDEX_UNAVAILABLE` 且无可用回退 | 停止本阶段并报告索引错误；不伪造候选或引用 |
| `search_knowledge` 返回 `degraded: true` 或非阻断 warning | 按工具返回的候选继续，把 warning 原文交调用方写入 `warnings.md`；不写入产物 |
| `search_knowledge` 返回参数类错误 | 修正查询或参数后重试；不改分类、不省略 `target_model` |
| 知识卡与上游冲突 | 以上游原文和已校验产物为准，不采用冲突内容；若冲突意味着上游缺失或错误，停止并回报 |
| 目标模型规则文件不可读或规则加载失败 | 停止本阶段并报告；不猜测时长或拆分边界，不绕过最终校验 |
| `validate_stage_artifact(shot_planning)` 返回 `ok: false` 且带 JSON Pointer `path` | 按 `errors[].path` 修正镜头或引用字段，整体重写后再校验；仍失败则停止报告 |
| 校验返回 `OUT_OF_RANGE` | 按 `errors[].path` 调整对应镜头的 `duration_sec` 或拆分，重写后重新校验；不在 Skill 内另行计算边界 |
| 校验返回 `MODEL_RULES_UNAVAILABLE` | 停止本阶段并报告目标模型规则不可用；不把错误码写入产物 |
| 文件级错误码 `STAGE_ARTIFACT_MISSING` / `STAGE_ARTIFACT_UNREADABLE` / `STAGE_ARTIFACT_INVALID_JSON` | 分别修正产物路径、文件可读性/权限或 JSON 写入，整体重写后再校验；错误码只用于报告，不写进产物 |
| 上游需要新增原文没有的剧情、角色、事件、动作或对白 | 停止本阶段，回退 `script-breakdown` 重新解析或由用户补充上游；不在 `shot_plan.json` 中补写 |
| 本阶段失败 | 保留已完成的中间产物，不更新 `run.json` 的阶段状态，不进入 `shot-prompting`（stage-conventions §2、架构 §13） |
