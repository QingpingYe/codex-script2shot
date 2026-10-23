---
name: script2shot
description: script2shot 入口编排：接收一段、单集或多集剧本，收取 project_id、单一 target_model 与可选 aspect_ratio，刷新本地索引、创建 run、按顺序执行 script-breakdown / shot-planning / shot-prompting 三个阶段 Skill，逐阶段校验并更新 run.json，最后聚合 knowledge_refs.json 与 warnings.md。
---

# script2shot

`script2shot` 是端到端入口编排 Skill：把剧本文本按「剧本解析 → 镜头规划 → 提示词生成」
三个固定阶段跑完，产出一次 run 的全部七个运行产物（`docs/architecture.md` §11.5、
`references/stage-conventions.md` §1）。

入口只做编排：收集运行上下文、刷新本地索引、创建运行目录、按顺序读取并执行三个阶段
Skill、每阶段结束后校验产物并更新 `run.json` 的阶段状态、最后聚合引用与警告并报告。
入口不做创作判断，也不实现检索、校验或渲染逻辑——这些分别留在阶段 Skill 与 MCP 工具里。

## 适用时机

- 用户提交一段剧本、一集剧本或多集剧本，要一次跑出目标模型的提示词。
- 用户要求续跑既有 run：`from <stage>` 从指定阶段继续，或 `only <stage>` 只执行一个阶段。
- 只需要单个阶段时可以不进入口：直接加载 `skills/script-breakdown/SKILL.md`、
  `skills/shot-planning/SKILL.md` 或 `skills/shot-prompting/SKILL.md`（架构 §9.4–§9.6）。
- 不适用：同步知识库用 `knowledge-sync`，初始化配置用 `setup`。

## 新 run 流程

按顺序执行，不跳步。运行目录固定为 `<workspace_root>/.script2shot/outputs/<run_id>/`，
`run_id` 形如 `run-YYYYMMDD-HHMMSS`（stage-conventions §1）。

1. **收集运行上下文。** 要求用户提供 `project_id` 与单一 `target_model`
   （`seedance-2.0` / `seedance-2.5`）；`aspect_ratio` 可选但建议一次问清，取值为
   `16:9`、`4:3`、`1:1`、`3:4`、`9:16`、`21:9`：`shot-prompting` 没有画幅会停止，
   而写进 `run.json` 后 `from` / `only` 续跑不必再问（架构 §11.2）。
   同时识别输入模式 `script_segment` / `single_episode` / `multiple_episodes`。
   多集输入保持单 run：不自动拆分、不建多个 run，但要记一条建议按集运行、控制单次
   会话长度的 warning（代码 `MULTIPLE_EPISODES`），在第 3 步之后写到
   `script_breakdown` 的阶段状态上；入口只提示，不替用户拆分（架构 §11.1）。
2. **刷新本地索引。** 调用 `refresh_local_index`。先按默认 `dry_run: true` 预览变化
   清单，确认清单合理后用 `dry_run: false` 执行同一刷新；本地 cache/index 是 AI 库的
   派生临时数据（架构 §7.4），这条写路径只动本地派生数据。
   - AI 库不可达但有可用缓存：工具返回 `degraded: true` 与 warning（代码
     `KB_B_UNREACHABLE`），本次运行继续，warning 原文在第 3 步后记进 `run.json`，
     最终出现在 `warnings.md`。
   - AI 库不可达且没有可用缓存：工具直接返回错误，停止本次 run 并报告错误与处理建议，
     不创建运行目录、不进入任何阶段。
3. **创建运行目录。** 调用
   `init_run({ workspace_root, input_mode, project_id, target_model, aspect_ratio })`，
   拿到 `run_id` 与 `run.json` 路径。`workspace_root` 是用户工作区根目录：MCP Server
   位于插件根目录，只凭 `run_id` 无法定位工作区中的运行目录。`aspect_ratio` 在这里
   一次写入 `run.json`，续跑只从这个字段恢复。
   随后把本条新 run 的 warning（多集提示、索引降级原文）通过
   `update_run_state({ workspace_root, run_id, stage: "script_breakdown", status:
   "running", warnings: [...] })` 记到首个阶段状态上；warning 只追加，不改已有条目。
4. **按顺序执行三个阶段 Skill。** 依次读取并执行
   `skills/script-breakdown/SKILL.md`、`skills/shot-planning/SKILL.md`、
   `skills/shot-prompting/SKILL.md`。阶段内怎么创作、检索什么、写哪些字段、失败怎么
   处理都以阶段 Skill 为准，入口不复制、不代替、不简化它们的流程。
   每阶段结束（产物已落盘）后入口做两件事：
   - 校验：`script_breakdown` / `shot_planning` 调
     `validate_stage_artifact({ stage, path })`，`shot_prompting` 调
     `validate_prompt({ prompt_ir_path })`；只有通过才进入下一个阶段。
   - 更新状态：`update_run_state({ workspace_root, run_id, stage, status: "done",
     artifact: <阶段产物文件名>, warnings: [本阶段工具返回的 warning 原文] })`。
   `warnings` 是工具 warning 进入 `run.json` 的唯一通道：`write_warnings` 没有
   `warnings` 入参，检索降级、预算截断、空查询等工具 warning 只有先在这里持久化，
   才会出现在 `warnings.md`。
   `run.json` 与产物不一致时以产物为准：先调 `read_run({ workspace_root, run_id })`
   取权威阶段状态，返回 `RUN_STATE_RECONCILED` warning 时按返回的 run 继续，并把该
   warning 同样记入 `run.json`。
5. **聚合与报告。** 三个阶段都是 `done` 后：
   - `aggregate_knowledge_refs({ run_id, script_analysis_path, shot_plan_path,
     prompt_ir_path, output_path: "<run_dir>/knowledge_refs.json" })`；
   - `write_warnings({ run_id, run_path: "<run_dir>/run.json", script_analysis_path,
     shot_plan_path, prompt_ir_path, output_path: "<run_dir>/warnings.md" })`。
   两个工具成功时返回 `{ output_path, ... }`，**不带 `ok: true`**，只有失败才带
   `ok: false` 与结构化 `error`；因此分支判断看 `error` 或 `output_path` 是否存在，
   不要用 `ok` 的真值判断。然后报告七个产物路径、三个阶段状态与 `warnings.md` 的
   警告摘要。
6. **续跑。** 用户要求 `from <stage>` 或 `only <stage>` 时按「续跑（from/only）」执行；
   同一 run 的阶段重跑后必须重新调用第 5 步的两个聚合工具，让总账整体替换对应阶段
   数组。

## 续跑（from/only）

- 先定位既有 run：要求用户给出 `run_id` 与 `workspace_root`（或从工作区推断），调用
  `read_run({ workspace_root, run_id })` 读取 `run.json`。`run.json` 缺失、不可读或
  缺少 `run_id` 时停止，不猜值；返回 `RUN_STATE_RECONCILED` 时按修正后的状态继续。
- 从 `run.json` 恢复 `input_mode`、`project_id`、`target_model`、`aspect_ratio`，
  不重新询问用户（架构 §11.2）。`aspect_ratio` 缺失且本次要跑 `shot-prompting` 时，
  按阶段 Skill 的 fail-closed 语义请求确认一次，不默认取值。
- `from <stage>`：从指定阶段开始，往后的阶段依次执行；上游阶段不重跑、复用既有产物，
  但进入本阶段前必须重新校验上游产物，校验不通过即停下报告。
- `only <stage>`：只执行这一个阶段。同样先重新校验它的全部上游产物
  （`only shot-prompting` 要校验 `shot_plan.json` 与 `script_analysis.json`）。
- 上游产物被人工修改过（例如用户手改 `shot_plan.json`）：一律先重新校验，通过后才能
  运行下游阶段；不通过就停止并报告 `errors[]`（架构 §13）。
- 每个被重跑阶段结束时走与第 4 步相同的「校验 → `update_run_state`」，然后重跑第 5 步
  的聚合，最后报告产物路径与警告摘要。
- `from` / `only` 是用户请求里的参数，不是 shell 命令，例如：
  `$script2shot 从 shot-planning 继续，run_id 是 <run_id>`、
  `$script2shot 只执行 shot-prompting，run_id 是 <run_id>`。

## 阶段失败处理

入口统一遵守（stage-conventions §2、架构 §13）：

- **不更新该阶段状态**：阶段失败时不把该阶段写成 `done`，`run.json` 里保持进入前的
  状态；需要标记运行中时也只写 `running`，不写 `done`。
- **保留中间产物**：不删除、不回滚已生成的阶段产物（包括失败前已写出的
  `prompts.ir.json`），重跑时在同一 run 目录整体重写。
- **停下并报告**：不进入下游阶段；把阶段 Skill / 工具返回的结构化错误（错误码，
  以及 `errors[].path` 或 `errors[].shot_id` + `field` + `code` + `message`）原样报告，
  并给出重试建议：字段或取值类错误按定位修正后重跑该阶段，根因在上游时回退对应上游
  阶段重跑。
- **上游校验是硬门槛**：`validate_stage_artifact` / `validate_prompt` 不通过就停；
  入口不跳过校验、不手写或修补阶段产物。
- **warning 不阻断**：多集提示、索引降级、预算截断等 warning 只记录（先经
  `update_run_state` 写进 `run.json`），由 `write_warnings` 汇总进 `warnings.md`；
  只有工具返回 `ok: false` 的错误才是停止信号。
- 具体错误码与修复动作以阶段 Skill 的失败处理表和工具返回为准；入口不重新解释、
  不另造错误码。

## 输出清单

一次 run 固定产出七个文件，位于 `<workspace_root>/.script2shot/outputs/<run_id>/`；
文件名不可更改、不可合并、不可省略（架构 §11.5、stage-conventions §1）：

| 产物 | 生成者 | 说明 |
| --- | --- | --- |
| `run.json` | 入口 / `init_run` | 运行上下文（`input_mode`、`project_id`、`target_model`、可选 `aspect_ratio`）、三阶段状态与运行级 warning；续跑的唯一上下文来源。 |
| `script_analysis.json` | `script-breakdown` | 剧本解析产物：场景、动作/情绪/对白单元、镜头组建议、连续性与本阶段 `knowledge_refs`。 |
| `shot_plan.json` | `shot-planning` | 镜头清单：景别、机位、运镜、时长、转场、逐镜头连续性与 `knowledge_refs`。 |
| `prompts.ir.json` | `shot-prompting` | 逐镜头 PromptIR，含按镜头记录的 `knowledge_refs`。 |
| `prompts.<target_model>.md` | `shot-prompting`（`render_prompt`） | 目标模型提示词正文，中文、按镜头分节。 |
| `knowledge_refs.json` | 入口（`aggregate_knowledge_refs`） | 三阶段引用的唯一总账，结构见 stage-conventions §4；某阶段重跑时整体替换该阶段数组。 |
| `warnings.md` | 入口（`write_warnings`） | 运行级 warning 与阶段 `missing_info` 的中文汇总；没有警告时写「无警告」。 |

报告时给出七个产物的路径、三个阶段的状态与 `warnings.md` 的警告摘要。

## 边界

- 不做创作判断：不解析剧本、不规划镜头、不写 PromptIR 正文；这些分别属于三个阶段
  Skill（架构 §9.3）。
- 不实现检索、校验或渲染：只调用 `refresh_local_index`、`init_run`、`read_run`、
  `update_run_state`、`validate_stage_artifact`、`validate_prompt`、
  `aggregate_knowledge_refs`、`write_warnings` 等 MCP 工具；索引刷新、排序、schema
  校验、硬规则校验与提示词渲染一律由工具完成。
- 不复制阶段内容：阶段流程、检索配方、产物字段与失败处理以三个阶段 `SKILL.md` 和
  `references/stage-conventions.md` 为准，入口只引用。
- 不替阶段决定取值：模型时长、画幅与禁止项以 `rules/models/<target_model>.json` 和
  `validate_prompt` 的判定为准，入口不另写一套边界。
- 不写外部系统：不修改原始库与 AI 库；本流程的写操作只有本地派生数据
  （`refresh_local_index` 的 cache/index）与运行目录里的七个产物；不推送、不发布。
- 不改写上游：阶段产物只由对应阶段 Skill 整体重写；入口不改字段、不修补 JSON，也不把
  校验失败的产物「修成」通过。
- 一次 run 只跑一个 `target_model`；多集输入保持单 run，不自动拆分。
