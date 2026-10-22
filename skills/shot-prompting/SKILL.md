---
name: shot-prompting
description: 在 script2shot 第三阶段把已校验的 shot_plan.json 写成 PromptIR 与目标模型提示词：逐镜头检索提示词与模型知识、写出 prompts.ir.json 和逐镜头知识引用、经硬规则校验与最多两轮修复后用 render_prompt 渲染 prompts.<model>.md。
---

# shot-prompting

把已校验的 `shot_plan.json` 变成 `prompts.ir.json` 与 `prompts.<model>.md`：逐镜头检索
提示词写作与模型知识，按冻结结构组装 PromptIR，用 `validate_prompt` 过硬规则、最多修复
两轮，再用 `render_prompt` 渲染目标模型提示词。这是 `script2shot` 链路的第三个阶段，
阶段 key 为 `shot_prompting`，产物文件名固定（`references/stage-conventions.md` §1）。

阶段只通过文件产物交接，不依赖会话上下文（stage-conventions §2）。本 Skill 只调用
`validate_stage_artifact`、`search_knowledge`、`validate_prompt`、`render_prompt`
四个 MCP 工具，不自己实现检索、排序、硬规则校验或提示词渲染，也不直接读取模型规则文件。

## 适用时机

- 入口 Skill `script2shot` 跑到 `shot-prompting` 阶段，或用户要求从本阶段重跑。
- 独立使用：用户自带一份已校验的镜头计划，只要 PromptIR 与目标模型提示词
  （架构 §9.6 的独立使用场景）。
- 前置：运行目录 `.script2shot/outputs/<run_id>/` 已由入口创建，上游
  `shot_plan.json` 已存在且通过阶段校验；本阶段要取材的 `script_analysis.json`
  在本 run 内也已通过校验；`aspect_ratio` 已由调用方明确给出。
- 如果任何上游产物被人工修改过，先重新调用对应的 `validate_stage_artifact`，
  通过后才能进入本阶段。
- 不适用：需要改镜头数量、拆分、时长、景别、机位、运镜、转场或连续性时，回退
  `shot-planning`；需要补写原文没有的剧情、角色、事件或对白时，回退
  `script-breakdown`（架构 §9.6）。

## 输入

- `shot_plan.json`：本阶段的直接上游，也是唯一的镜头决策来源。提供 `run_id`、
  `project_id`、`target_model`、`scenes[].scene_id`、`scenes[].shots[]`（`shot_id`、
  `order`、`duration_sec`、`shot_size`、`camera_angle`、`camera_movement`、
  `transition`、`continuity`、`source_shot_group_ids`，以及可选的 `notes`）。字段以
  `schemas/shot_plan.schema.json` 为准；本阶段只读，不修改。
- `script_analysis.json`：同一 run 的上一阶段产物，用于取回镜头对应的场景与原文单元
  （`location`、`time_of_day`、`characters`、`action_units`、`emotion_units`、
  `dialogue_units`、`shot_group_suggestions` 与 `continuity`），作为 PromptIR 的
  `subject`、`action`、`setting`、`time` 的取材来源。只读；本阶段的 `knowledge_refs`
  只来自本阶段自己的检索，不继承也不改写该文件。使用前必须确认它在本 run 内已通过
  `validate_stage_artifact({ stage: "script_breakdown", path })`。
- `run.json`：可选运行时上下文，用于核对 `run_id`、`project_id`、`target_model`。
  可读时若与已校验的 `shot_plan.json` 冲突，停止并报告；不可读时以上游产物为准
  继续，不猜缺失字段。
- `aspect_ratio`：PromptIR 的必填画幅。上游两个产物都不携带该字段，由调用方
  （入口或用户）在运行本阶段时显式给出；未提供时停止并请求确认，不默认取值。
- 知识：只经 `search_knowledge` 检索本地索引/缓存里的提示词技巧、示例、镜头语言、
  角色、场景、风格与 Seedance 模型知识，内容来自 AI 库；本阶段不直接读原始库或飞书。
- 模型硬规则：必填字段、禁止项、时长与画幅范围由 `rules/models/<target_model>.json`
  定义，经 `validate_prompt` 判定；本阶段不直接读规则文件，也不在 Skill 或产物里
  另写一套规则数值。

## 流程

固定五步，顺序不可调整。

1. **校验上游产物。** 调用
   `validate_stage_artifact({ stage: "shot_planning", path: "<workspace>/.script2shot/outputs/<run_id>/shot_plan.json" })`；
   只有返回 `ok: true` 才继续。失败即停，不生成、不覆盖 `prompts.ir.json` 与
   `prompts.<model>.md`。
   - 校验通过后读取 `run_id`、`project_id`、`target_model`、`scenes[].shots[]`；
     `run.json` 可读时用其中同名字段核对，缺字段或冲突时停止并报告，不猜值。
   - 需要从 `script_analysis.json` 取材时，先确认它在本 run 内已通过
     `validate_stage_artifact({ stage: "script_breakdown", path })`（入口在上一阶段已校验；
     被人工修改后必须重新校验），未通过即停。
   - `target_model` 同时决定 PromptIR 顶层与逐镜头的 `target_model`，以及输出文件名
     `prompts.<target_model>.md`；一次 run 只允许一个目标模型。
2. **逐镜头检索知识。** 按 `shot_plan.json` 的场景顺序与镜头顺序，对每个镜头调用一次
   `search_knowledge`，参数取「知识检索配方」的固定值；需要连续性时把相邻镜头的关键
   状态并进同一次查询。检索结果只用于本镜头的 PromptIR 写作。
3. **组装 PromptIR 并落盘。** 把每个镜头写成一条 PromptIR 镜头对象，按场景顺序与
   镜头顺序展平进 `shots[]`，逐镜头写 `knowledge_refs`（`used` 与
   `dropped_by_budget`），再把完整文档写入
   `<workspace>/.script2shot/outputs/<run_id>/prompts.ir.json`，供第 4 步的
   `validate_prompt` 按路径读取。
   - `duration` 取上游 `duration_sec` 的整数秒；`camera_angle`、`camera_movement`
     按「输出」的冻结映射表把上游中文枚举译成英文枚举；`subject`、`action`、
     `setting`、`time` 取材于 `script_analysis.json` 的对应场景与原文单元；
     `lighting`、`color`、`style` 取材于上游信息与检索卡片。
   - 只重组上游已有信息与检索知识，不新增原文没有的剧情、角色、事件、动作或台词。
   - `continuity.previous_shot` 取上一镜头的 `shot_id`（首个镜头省略该字段或填
     `null`）；`character_state`、`environment_state` 取材于上游镜头 `continuity` 的
     退出状态与场景状态，不另写一套连续性。
4. **硬规则校验与修复循环。** 调用
   `validate_prompt({ prompt_ir_path: "<workspace>/.script2shot/outputs/<run_id>/prompts.ir.json" })`。
   - 返回 `ok: true` ⇒ 进入第 5 步。
   - 返回 `ok: false` ⇒ 按 `errors[]` 只重新生成失败的镜头（`shot_id` 指到的镜头；
     顶层错误按 `field` 定位），整体重写 `prompts.ir.json` 后重新调用
     `validate_prompt`；**最多 2 轮修复**。
   - 2 轮后仍返回 `ok: false` ⇒ 停止本阶段，保留已生成的 `prompts.ir.json`，报告
     `HARD_RULE_VIOLATION` 与 `errors[]` 明细（`shot_id`、`field`、`code`、`message`），
     **不调用 `render_prompt`、不写提示词文件**。
   - 修复只改 PromptIR 的镜头内容与检索上下文，不回改 `shot_plan.json`；`code` 为
     `MODEL_RULES_UNAVAILABLE` 时属安装损坏，直接停止报告，重新生成镜头不解决。
5. **渲染并报告产物。** 校验通过后调用
   `render_prompt({ prompt_ir_path: "<workspace>/.script2shot/outputs/<run_id>/prompts.ir.json", output_path: "<workspace>/.script2shot/outputs/<run_id>/prompts.<target_model>.md" })`。
   - 返回 `ok: true` ⇒ 本阶段产物为 `prompts.ir.json` 与 `prompts.<target_model>.md`，
     报告两份路径。
   - 返回 `HARD_RULE_VIOLATION`（渲染前复校验不通过）⇒ 报告 `error.details.errors`
     并停止，不重试渲染。
   - 返回 `RENDER_FAILED` ⇒ 保留 `prompts.ir.json`，报告工具错误并停止。
   - 本阶段不更新 `run.json` 的阶段状态；阶段状态由入口在产物通过校验后写入
     （stage-conventions §2）。

## 知识检索配方

依据 stage-conventions §3.4 与 §3.5，本阶段有且只有一种检索，参数照下面固定值传，
不自行增加过滤条件、分类或预算。粒度：**每个镜头一次**。

```json
{
  "query": "<subject/action/setting/情绪/光线方向/目标模型>",
  "scope": "project",
  "project_id": "<project_id>",
  "categories": [
    "prompt_technique",
    "seedance_rule",
    "example",
    "camera_lexicon",
    "character_bible",
    "scene_description",
    "visual_style"
  ],
  "target_model": "<target_model>",
  "max_cards": 6,
  "char_budget": 4000
}
```

- 本阶段所有 `search_knowledge` 调用都必须传 `target_model`；只有 `script-breakdown`
  有不传该参数的豁免（stage-conventions §3.1）。
- 查询来源是镜头的 `subject`、`action`、`setting`、情绪、光线方向和目标模型；需要
  连续性时把相邻镜头的关键状态并进同一个 `query`，不为连续性另开一次检索。
- 每个镜头进入生成上下文的卡片不超过 6 张、正文不超过 4000 字符；采用
  `search_knowledge` 返回的候选与预算结果，不自行扩大候选集、不改变排序。
- 工具返回的 `dropped_by_budget` 是命中且排序通过、但被 6 张 / 4000 字符预算截断的
  `card_id`：其中每一条都记入所属镜头的 `knowledge_refs`，`usage` 为
  `dropped_by_budget`，并写全九个必填字段；实际影响 PromptIR 写作的候选卡用
  `usage: "used"`。进入候选但未采用的卡不记录。
- 引用的来源元数据取工具返回结果。补齐不了来源字段时停止并报告，不伪造
  `source_doc_token`、`source_path`、`source_revision`、`last_synced_at`，也不通过
  加大 `max_cards` / `char_budget` 或追加检索绕过预算上限。
- `character_bible`、`scene_description`、`visual_style` 保持正文原文，不压缩；
  `prompt_technique`、`example`、`seedance_rule` 可以压缩为要点使用，不逐字复制进
  PromptIR（stage-conventions §3.5）。
- `degraded` 与 `warnings` 只返回给调用方，由入口写入 `warnings.md`；`explain` 不在
  本阶段使用，其诊断输出同样只交调用方。三者都不写进 `prompts.ir.json`，也不新增
  输出文件（stage-conventions §5、架构 §10.4）。

## 输出

`<workspace>/.script2shot/outputs/<run_id>/` 下两个文件（`<target_model>` 取
`seedance-2.0` 或 `seedance-2.5`）：

- `prompts.ir.json`：PromptIR，结构是 `schemas/prompt_ir.schema.json` 定义的冻结接口，
  所有对象 `additionalProperties: false`，只允许下列字段和值，不得发明字段或枚举值。
- `prompts.<target_model>.md`：由 `render_prompt` 生成的目标模型提示词文档，正文中文、
  按镜头分节、节内顺序固定、不含时间戳；本阶段不手写、不修补该文件。

**`prompts.ir.json` 顶层**

| 字段 | 类型 | 取值 |
| --- | --- | --- |
| `run_id` | string | `run-YYYYMMDD-HHMMSS`，匹配 `^run-\d{8}-\d{6}$` |
| `target_model` | string | `seedance-2.0` / `seedance-2.5`，取自上游产物 |
| `shots` | array | `shot[]`，按场景顺序与镜头顺序展平 |
| `generated_at` | string | 带时区的 ISO 8601 时间 |

**`shots[]`**

| 字段 | 类型 | 取值 |
| --- | --- | --- |
| `shot_id` | string | 沿用 `shot_plan.json` 的镜头 ID |
| `target_model` | string | 与顶层 `target_model` 一致 |
| `duration` | integer | 整数秒，取自上游 `duration_sec`；范围由 `validate_prompt` 判定 |
| `aspect_ratio` | string | `16:9`、`4:3`、`1:1`、`3:4`、`9:16`、`21:9`，取调用方给定值 |
| `subject` | string | 取自上游场景与角色信息 |
| `action` | string | 取自上游动作单元与镜头计划 |
| `setting` | string | 取自上游场景地点与检索到的场景说明 |
| `time` | string | 英文时间术语（例如 `night`、`day`、`dawn`、`dusk`） |
| `camera_angle` | string | 英文枚举，映射见下表 |
| `camera_movement` | string | 英文枚举，映射见下表 |
| `lighting` | string | 光线方向与质感，取材于上游信息与检索卡片 |
| `color` | string | 色调，取材于上游信息与检索卡片 |
| `style` | string | 视觉风格，取材于检索卡片与项目视觉设定 |
| `continuity` | object | `previous_shot`（可选，上一镜头 ID 或 `null`）、`character_state`、`environment_state`，后两项为非空字符串 |
| `negative_prompt` | string[] | 负面约束条目；没有依据时写空数组 |
| `knowledge_refs` | array | 本镜头的 `knowledge_ref[]` |

中文 → 英文机位枚举，一一对应（`shot_plan.json` → `prompts.ir.json`）：
平视=`eye-level`、仰视=`low-angle`、俯视=`high-angle`、鸟瞰=`bird's-eye`、
虫视=`worm's-eye`、荷兰角=`dutch-angle`、过肩=`over-the-shoulder`、
主观视角=`point-of-view`、反打=`reverse-angle`、侧面=`side-view`、
四分之三侧面=`three-quarter-view`、背身=`back-view`、双人镜头=`two-shot`。

中文 → 英文运镜枚举，一一对应：固定=`static`、横摇=`pan`、竖摇=`tilt`、
推近=`push-in`、拉远=`pull-out`、平移=`truck`、升降=`boom`、摇臂=`crane`、
变焦=`zoom`、跟拍=`tracking`、环绕=`orbit`、手持=`handheld`、稳定器=`gimbal`、
甩镜=`whip-pan`、滑动变焦=`dolly-zoom`、跟焦=`follow-focus`。

**`shots[].knowledge_refs[]`**

| 字段 | 类型 | 取值 |
| --- | --- | --- |
| `card_id` | string | 知识卡 ID |
| `scene_id` | string | 该镜头所属场景的场景 ID |
| `shot_id` | string | 必填字符串，**等于所属镜头的 `shot_id`**（PromptIR 内不允许 `null`） |
| `query` | string | 本镜头实际发出的检索查询 |
| `usage` | string | `used` / `dropped_by_budget` |
| `source_doc_token` | string | 来源文档 token |
| `source_path` | string | 来源路径 |
| `source_revision` | integer | 来源版本 |
| `last_synced_at` | string | 带时区的 ISO 8601 时间 |

本阶段只写这两个文件：不修改 `shot_plan.json` 或 `script_analysis.json`，不写
`run.json`，不写运行目录总账 `knowledge_refs.json`，也不写 `warnings.md`。

## 边界

- 职责边界：只把镜头计划变成 PromptIR 与提示词。**不修改镜头计划**；需要改镜头数量、
  拆分、时长、景别、机位、运镜、转场或连续性时回到 `shot-planning`（架构 §9.6），
  需要补写原文没有的剧情、角色、事件或对白时回到 `script-breakdown`。
- 不实现检索、校验或渲染：只调用 `validate_stage_artifact`、`search_knowledge`、
  `validate_prompt`、`render_prompt`；不自己排序候选、不自己判硬规则、不自己拼
  提示词正文。
- 不扩大检索：每个镜头一次固定参数检索，七类分类、`max_cards: 6`、
  `char_budget: 4000`，且必须传 `target_model`（stage-conventions §3.1、§3.4、§3.5）。
- 不越过上游：PromptIR 的文本字段只取材于上游产物与本阶段检索到的卡片；不新增剧情、
  角色、事件、动作或台词，也不得把检索结果当成改写镜头计划的理由。
- 不写状态与总账：`run.json` 的阶段状态由入口维护，`knowledge_refs.json` 由入口聚合，
  `warnings.md` 由入口写入；本阶段只写自己主产物里的逐镜头 `knowledge_refs`。
- 不把模型硬规则复制成 Skill 内的独立权威：必填字段、禁止项、时长与画幅范围以目标
  模型规则文件为准，并由 `validate_prompt` 判定；本阶段不读规则文件。

## 失败处理

| 情形 | 处理 |
| --- | --- |
| 上游缺少 `run_id` / `project_id` / `target_model`，或 `run.json` 存在但与上游冲突 | 停止本阶段，报告缺失或冲突字段；不猜值、不写产物 |
| 上游 `shot_plan.json` 缺失、不可读或 schema 校验失败 | 停止本阶段，报告 `validate_stage_artifact` 返回的 `errors[].path` 和错误码；不生成下游产物 |
| 上游校验返回 `OUT_OF_RANGE` / `MODEL_RULES_UNAVAILABLE` | 停止本阶段并报告；不改镜头时长或拆分，也不绕过校验 |
| `script_analysis.json` 在本 run 内未通过校验（例如被人工修改后未重校验） | 先重新调用 `validate_stage_artifact({ stage: "script_breakdown", path })`；仍不通过则停止并报告 |
| 调用方未提供 `aspect_ratio` | 停止本阶段请求确认；不默认取值、不先写产物 |
| 文件级错误码 `STAGE_ARTIFACT_MISSING` / `STAGE_ARTIFACT_UNREADABLE` / `STAGE_ARTIFACT_INVALID_JSON` | 分别修正产物路径、文件可读性/权限或 JSON 写入，再重新校验；错误码只用于报告，不写进产物 |
| `search_knowledge` 返回参数类错误 | 修正查询或参数后重试；不改分类、不省略 `target_model` |
| `search_knowledge` 返回 `INDEX_UNAVAILABLE` 且无可用回退 | 停止本阶段并报告索引错误；不伪造候选或引用 |
| `search_knowledge` 返回 `degraded: true`、warning 或空查询 | 按工具返回结果继续或修正查询重试；warning 文案以工具输出为准，原样交调用方写入 `warnings.md`，不在本 Skill 复述、不写进产物 |
| `dropped_by_budget` 条目的来源元数据无法补齐 | 停止本阶段并报告；不伪造来源字段，也不扩大预算或追加检索绕过 |
| 知识卡与上游冲突 | 以上游产物为准，不采用冲突内容；冲突意味着上游缺失或错误时停止并回报 |
| `validate_prompt` 返回 `MISSING_FIELD` / `OUT_OF_RANGE` / `FORBIDDEN_TERM` / `MODEL_MISMATCH` | 只重新生成 `errors[].shot_id` 指到的镜头，整体重写 `prompts.ir.json` 后重新校验；最多 2 轮 |
| 修复 2 轮后仍 `ok: false` | 停止本阶段，保留已生成的 `prompts.ir.json`，报 `HARD_RULE_VIOLATION` 与 `errors[]` 明细；不渲染、不写提示词文件、不更新 `run.json` 阶段状态 |
| `OUT_OF_RANGE` 根因在上游镜头计划（例如 `duration_sec` 超出模型范围或不是整数秒） | 停止本阶段，回退 `shot-planning` 调整；不取整、不改时长、不修改 `shot_plan.json` |
| `validate_prompt` 返回 `MODEL_MISMATCH` | 先对齐 PromptIR 顶层与逐镜头的 `target_model`；若上游镜头计划本身与目标模型不一致，停止并回退 `shot-planning` |
| `validate_prompt` 返回文档级 `MODEL_RULES_UNAVAILABLE` | 停止本阶段并报告目标模型规则不可用；重生成镜头不解决，不把错误码写进产物 |
| `render_prompt` 返回 `HARD_RULE_VIOLATION` | 报告 `error.details.errors` 并停止；不重试渲染、不手写提示词文件 |
| `render_prompt` 返回 `RENDER_FAILED` | 保留 `prompts.ir.json`，报告工具错误并停止；不伪造提示词文件 |
| 本阶段失败 | 保留已完成的中间产物，不更新 `run.json` 的阶段状态，不进入入口的聚合与报告步骤（stage-conventions §2、架构 §13） |
