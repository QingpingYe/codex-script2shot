# Phase 4：阶段技能与提示词生成 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal：** 跑通「剧本 → 结构化解析 → 镜头计划 → PromptIR → 目标模型提示词」的三阶段创作链路，并由 `script2shot` 入口完成编排、续跑和产物聚合。

**Architecture：** 三个创作阶段各自是 Skill + 一个冻结 schema 产物，相互只通过运行目录里的文件交接；MCP Server 提供 schema 校验、PromptIR 硬规则校验和确定性渲染；入口 Skill 负责刷新索引、创建 run、按顺序执行阶段、校验产物、更新 `run.json` 并聚合 `knowledge_refs.json` 与 `warnings.md`。

**Tech Stack：** Node.js >= 24 + TypeScript；vitest；构建与启动见架构 §7.1。

**Spec：** `docs/architecture.md` §9.3–§9.6、§10、§11、§13、§14 Phase 4；`references/stage-conventions.md` 全文（阶段 key、交接、检索配方、引用聚合）。

**前置：** Phase 3 完成。本文件按 4a → 4b → 4c → 4d 顺序执行；4a–4c 的测试使用 fixture run 目录，端到端能力在 4d 完成后可用。

## Global Constraints

- 阶段只通过文件产物交接，不依赖会话上下文；`script_analysis.json` 与 `shot_plan.json` 是冻结接口，字段改动视为不兼容变更（§11.2）。
- 产物文件名不可更改、不可合并、不可省略；`run_id` 格式 `run-YYYYMMDD-HHMMSS`（stage-conventions §1）。
- `script-breakdown` 解析到镜头组建议为止；`shot-planning` 只产出镜头计划不写提示词正文；`shot-prompting` 不修改镜头计划（§9.4–§9.6）。
- `script-breakdown` 的所有检索不按 `target_model` 过滤；`shot-planning` 与 `shot-prompting` 必须过滤（§10.1 例外、stage-conventions §3.1）。
- 知识包只包含当前项目：不能用检索结果补写原文没有的剧情、关系和事件（stage-conventions §3.2）。
- 上下文预算：`shot-planning` 每场景 ≤ 8 张卡；`shot-prompting` 每镜头 ≤ 6 张卡、≤ 4000 字符；超预算记 `dropped_by_budget`（stage-conventions §3.5）。
- 提示词正文中文；结构化枚举和字段标识英文；一次 run 只生成一个 `target_model` 的提示词（§1.1-13、§11.3）。
- `knowledge_refs.json` 只由入口生成；阶段只写自己主产物内的引用；只记录 `used` 与 `dropped_by_budget`（stage-conventions §4）。
- 多集输入不做自动拆分和硬性镜头上限；入口写 warning 建议按集运行（§11.1）。
- 硬规则（时长、画幅、必填、禁止项）只放 `rules/models/*.json`，每个规则文件必须带 `source` 与 `checked_at`（§11.4、R-29）。

## Review Focus

1. 多集输入：识别集边界、保持单 run、写 warning 建议按集运行（Task 4d-3 用例 `entry.warns_on_multiple_episodes`）。
2. 上游产物被人工修改：下游阶段必须先重新校验，校验失败即停（Task 4a-1 用例 `validate.rejects_hand_edited_missing_field`；Task 4d-3 用例 `entry.refuses_to_run_shot_planning_with_invalid_upstream`）。
3. `run.json` 与产物不一致：以产物为准重新校验并修正状态（Task 4d-1 用例 `run.reconciles_run_json_from_artifacts`）。
4. 硬规则修复循环两轮后仍失败：停止该阶段、保留已生成产物、返回结构化错误，不渲染提示词（Task 4c-2 用例 `validate.returns_structured_errors_per_shot`；Task 4c-3 用例 `render.refuses_invalid_prompt_ir`）。
5. 渲染对空 `negative_prompt` 与可选字段保持稳定输出（Task 4c-3 用例 `render.handles_empty_negative_prompt`）。

---

## 4a：剧本解析（script-breakdown）

### Task 4a-1: `script_analysis.schema.json` 与产物校验

**Files:**
- Create: `schemas/script_analysis.schema.json`
- Create: `server/src/tools/validate_stage_artifact.ts`
- Create: `server/tests/validate_stage_artifact.test.ts`
- Create: `tests/fixtures/script_analysis.sample.json`、`script_analysis.invalid.missing_scene_summary.json`、`script_analysis.invalid.bad_input_mode.json`

**Interfaces:**
- Consumes: Phase 2 的校验基础设施；stage-conventions §4 的引用条目结构。
- Produces: `validate_stage_artifact({ stage: "script_breakdown" | "shot_planning", path }) -> { ok, errors[] }`（`errors[].path` 用 JSON Pointer）。

`script_analysis.json` 顶层冻结结构：

```json
{
  "run_id": "run-20261020-120000",
  "input_mode": "script_segment | single_episode | multiple_episodes",
  "project_id": "demo",
  "target_model": "seedance-2.5",
  "episodes": [
    {
      "episode_id": "ep01",
      "title": "第一集",
      "scenes": [
        {
          "scene_id": "ep01-sc01",
          "heading": "内景 旧公寓 夜",
          "summary": "一句话场景目标",
          "location": "旧公寓",
          "time_of_day": "night",
          "characters": ["角色A"],
          "beats": [{"beat_id": "ep01-sc01-b01", "description": "节拍描述", "action_unit_ids": ["ep01-sc01-a01"]}],
          "action_units": [{"id": "ep01-sc01-a01", "description": "动作单元", "characters": ["角色A"], "location": "旧公寓"}],
          "emotion_units": [{"id": "ep01-sc01-e01", "description": "情绪变化", "characters": ["角色A"], "tone": "紧张"}],
          "dialogue_units": [{"id": "ep01-sc01-d01", "speaker": "角色A", "text": "原文对白", "visual_action": "对白转成的可见动作"}],
          "shot_group_suggestions": [{"id": "ep01-sc01-g01", "purpose": "建立空间", "characters": ["角色A"], "coverage_hint": "全景 + 过肩"}]
        }
      ]
    }
  ],
  "continuity": {"characters": [], "scenes": [], "style": []},
  "missing_info": [{"code": "SCENE_TIME_UNKNOWN", "message": "场景时间未在原文交代", "scene_id": "ep01-sc01"}],
  "knowledge_refs": [],
  "generated_at": "2026-10-20T12:00:00+08:00"
}
```

`continuity` 三类条目：`{ "name": "角色A", "card_ids": ["src:..."], "summary": "跨集稳定设定的摘要" }`。`knowledge_refs` 条目 = `{ card_id, scene_id, shot_id: null, query, usage: "used|dropped_by_budget", source_doc_token, source_path, source_revision, last_synced_at }`。

- [ ] **Step 1: 写失败的校验测试**

```text
test("valid script analysis fixture passes")
test("validate rejects missing scene summary")
test("validate rejects unknown input mode")
test("validate rejects hand edited missing field with json pointer")
test("validate reports missing file as STAGE_ARTIFACT_MISSING")
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm --prefix server test -- validate_stage_artifact`
Expected: FAIL。

- [ ] **Step 3: 写 schema 与校验工具**

枚举：`input_mode` 三值；`usage` 两值。`shot_id` 在 4a 阶段固定 `null`。

- [ ] **Step 4: 运行并确认通过**

Run: `npm --prefix server test -- validate_stage_artifact`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add schemas/script_analysis.schema.json server/src/tools/validate_stage_artifact.* server/tests/validate_stage_artifact.* tests/fixtures/
git commit -m "feat: add script analysis schema and stage artifact validation"
```

### Task 4a-2: `script-breakdown` Skill

**Files:**
- Create: `skills/script-breakdown/SKILL.md`

**Interfaces:**
- Consumes: `validate_stage_artifact`、`search_knowledge`、`load_knowledge_pack`（通用知识不需要 pack，用 search）。
- Produces: `$script-breakdown` 流程说明，产物写入 `<workspace>/.script2shot/outputs/<run_id>/script_analysis.json`。

流程固定为：

1. 读取 `run.json` 确认 `run_id`、`input_mode`、`project_id`；上游无要求。
2. 判定输入模式（片段/单集/多集）；多集时识别集边界但保持单 run。
3. 开场加载一次通用知识：`search_knowledge({ query: "剧本解析", scope: "general", categories: ["shot_breakdown"] })`，**不传 `target_model`**。
4. 按集拆分场景，输出节拍、动作单元、情绪单元、对白单元、镜头组建议；保持原文边界，不新增剧情、角色、事件、结局。
5. 每个角色或场景首次出现时检索一次项目知识：`search_knowledge({ query: "<名称 + 原文动作/地点/服装描述>", scope: "project", project_id, categories: ["character_bible", "scene_description", "visual_style", "project_rule"] })`；结果写入 `continuity`，并逐条记入 `knowledge_refs`。
6. 原文缺失信息写入 `missing_info`（代码 + 中文说明 + 定位 id），不猜测补写。
7. 写 `script_analysis.json`（含 `knowledge_refs` 与 `generated_at`），调用 `validate_stage_artifact` 自检；失败按错误修复后重写。

职责边界（写入 SKILL.md）：解析到镜头组建议为止；具体镜头数量、时长和组接交给 `shot-planning`。

- [ ] **Step 1: 写 SKILL.md**

frontmatter `name: script-breakdown`；正文含 `适用时机`、`输入`、`流程`、`知识检索配方`（照 Stage-conventions §3.2）、`输出`、`边界`、`失败处理`。

- [ ] **Step 2: 运行技能契约测试**

Run: `npm --prefix server test -- skills_contract`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add skills/script-breakdown/
git commit -m "feat: add script breakdown skill"
```

---

## 4b：镜头规划（shot-planning）

### Task 4b-1: 模型规则文件（规划子集）与加载器

**Files:**
- Create: `rules/models/seedance-2.0.json`
- Create: `rules/models/seedance-2.5.json`
- Create: `server/src/rules.ts`
- Create: `server/tests/rules.test.ts`
- Create: `docs/model-rules-notes.md`

**Interfaces:**
- Consumes: 官方来源或可追溯实测（本任务必须先完成来源核对）。
- Produces: `load_model_rules(model_id) -> rules | error(MODEL_UNKNOWN)`。

规则文件结构（4b 阶段先填规划相关字段，4c 补 `required_fields`、`forbidden`、`render`）：

```json
{
  "model": "seedance-2.0",
  "label": "Seedance 2.0",
  "duration": {"min_sec": 0, "max_sec": 0, "default_sec": 0},
  "aspect_ratios": ["16:9"],
  "shot_split": {"prefer_max_sec": 0, "multi_action_rule": "中文规则描述"},
  "source": ["https://official.example/..."],
  "checked_at": "2026-10-20"
}
```

- [ ] **Step 1: 核对来源并写 `docs/model-rules-notes.md`**

为 Seedance 2.0 与 2.5 分别收集时长上限、画幅、镜头拆分边界，逐条记录来源链接与核对日期。**核对不到可追溯来源时停下，不允许凭记忆填值**。

- [ ] **Step 2: 写失败的加载器测试**

```text
test("rules load both seedance models")
test("unknown model returns MODEL_UNKNOWN")
test("every rule file declares source and checked at")
test("duration bounds are positive and ordered")
```

- [ ] **Step 3: 运行并确认失败**

Run: `npm --prefix server test -- rules`
Expected: FAIL。

- [ ] **Step 4: 写规则文件与加载器**

- [ ] **Step 5: 运行并确认通过**

Run: `npm --prefix server test -- rules`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add rules/models/ server/src/rules.* server/tests/rules.* docs/model-rules-notes.md
git commit -m "feat: add seedance model rule files and loader"
```

### Task 4b-2: `shot_plan.schema.json`

**Files:**
- Create: `schemas/shot_plan.schema.json`
- Create: `tests/fixtures/shot_plan.sample.json`、`shot_plan.invalid.missing_duration.json`、`shot_plan.invalid.bad_shot_size.json`
- Modify: `server/src/tools/validate_stage_artifact.ts`（支持 `stage: "shot_planning"`）
- Modify: `server/tests/validate_stage_artifact.test.ts`

**Interfaces:**
- Consumes: Task 4a-1 的校验工具。
- Produces: `shot_plan.json` 冻结结构：

```json
{
  "run_id": "run-20261020-120000",
  "project_id": "demo",
  "target_model": "seedance-2.5",
  "scenes": [
    {
      "scene_id": "ep01-sc01",
      "shots": [
        {
          "shot_id": "ep01-sc01-sh01",
          "order": 1,
          "duration_sec": 8,
          "shot_size": "全景 | 中景 | 近景 | 特写 | 其他允许值",
          "camera_angle": "平视 | 仰视 | 俯视 | ...",
          "camera_movement": "固定 | 推 | 拉 | 摇 | 跟 | 手持 | ...",
          "transition": "切 | 叠化 | 淡入淡出 | 无",
          "continuity": {"enter_state": "进入状态描述", "exit_state": "离开状态描述"},
          "source_shot_group_ids": ["ep01-sc01-g01"],
          "notes": "可选备注"
        }
      ]
    }
  ],
  "knowledge_refs": [],
  "generated_at": "2026-10-20T12:05:00+08:00"
}
```

`shot_size`、`camera_angle`、`camera_movement`、`transition` 的完整枚举以 schema 为准（英文标识或固定中文词表，二者只选一种并全库一致；首版用固定中文词表，PromptIR 阶段再映射为英文枚举）。

- [ ] **Step 1: 写失败的测试**

```text
test("valid shot plan fixture passes")
test("shot plan rejects missing duration")
test("shot plan rejects unknown shot size enum")
test("shot plan rejects shot without enter exit state")
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm --prefix server test -- validate_stage_artifact`
Expected: FAIL（新增用例）。

- [ ] **Step 3: 写 schema 并扩展校验工具**

- [ ] **Step 4: 运行并确认通过**

Run: `npm --prefix server test -- validate_stage_artifact`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add schemas/shot_plan.schema.json server/src/tools/validate_stage_artifact.* server/tests/validate_stage_artifact.* tests/fixtures/
git commit -m "feat: add shot plan schema and validation"
```

### Task 4b-3: `shot-planning` Skill

**Files:**
- Create: `skills/shot-planning/SKILL.md`

**Interfaces:**
- Consumes: `validate_stage_artifact`、`load_knowledge_pack`、`search_knowledge`、`load_model_rules`（经 MCP 暴露或内置）.
- Produces: `$shot-planning` 流程说明，产物写入 `<run 目录>/shot_plan.json`。

流程固定为：

1. `validate_stage_artifact({ stage: "script_breakdown", path: <run 目录>/script_analysis.json })`；失败即停。
2. `load_knowledge_pack({ project_id, target_model })` 加载项目知识。
3. 每个场景检索一次（场景内每个镜头组可追加一次）：`search_knowledge({ query: "<场景目标/情绪弧/角色/地点/时间/镜头组建议>", scope: "project", project_id, categories: ["shot_breakdown", "storyboard", "camera_lexicon", "character_bible", "scene_description", "visual_style", "seedance_rule"], target_model, max_cards: 8 })`；超预算条目按 `dropped_by_budget` 记入 `knowledge_refs`。
4. 把镜头组建议落实为镜头清单：景别、机位、运镜、时长、转场、连贯性；时长与拆分边界必须落在规则文件范围内。
5. 每个镜头记录进入/离开状态；`source_shot_group_ids` 回指解析产物。
6. 写 `shot_plan.json` 并自校验；失败修复后重写。

职责边界：只产出镜头计划，不写提示词正文；需要新增剧情内容时回退 `script-breakdown`。

- [ ] **Step 1: 写 SKILL.md**

frontmatter `name: shot-planning`；小节与 3.3 配方、预算和边界一致。

- [ ] **Step 2: 运行技能契约测试**

Run: `npm --prefix server test -- skills_contract`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add skills/shot-planning/
git commit -m "feat: add shot planning skill"
```

---

## 4c：提示词生成（shot-prompting）

### Task 4c-1: `prompt_ir.schema.json`

**Files:**
- Create: `schemas/prompt_ir.schema.json`
- Create: `tests/fixtures/prompts_ir.sample.json`、`prompts_ir.invalid.missing_subject.json`、`prompts_ir.invalid.bad_continuity.json`

**Interfaces:**
- Consumes: 架构 §11.3 的 PromptIR 字段。
- Produces: `prompts.ir.json` 冻结结构：

```json
{
  "run_id": "run-20261020-120000",
  "target_model": "seedance-2.5",
  "shots": [
    {
      "shot_id": "ep01-sc01-sh01",
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
      "continuity": {"previous_shot": "ep01-sc01-sh00", "character_state": "wet coat", "environment_state": "heavy rain"},
      "negative_prompt": [],
      "knowledge_refs": []
    }
  ],
  "generated_at": "2026-10-20T12:10:00+08:00"
}
```

PromptIR 内字段值用英文枚举/术语；渲染阶段再输出中文正文。每个镜头的 `knowledge_refs` 条目与 stage-conventions §4 一致。

- [ ] **Step 1: 写失败的测试**

```text
test("valid prompt ir fixture passes")
test("prompt ir rejects missing subject")
test("prompt ir rejects continuity without exit state")
test("prompt ir requires knowledge refs field per shot")
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm --prefix server test -- prompt_ir`
Expected: FAIL。

- [ ] **Step 3: 写 schema 与校验入口（复用 Phase 2 的校验基础设施）**

- [ ] **Step 4: 运行并确认通过**

Run: `npm --prefix server test -- prompt_ir`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add schemas/prompt_ir.schema.json tests/fixtures/
git commit -m "feat: add prompt ir schema"
```

### Task 4c-2: 硬规则校验 `validate_prompt`

**Files:**
- Create: `server/src/tools/validate_prompt.ts`
- Create: `server/tests/validate_prompt.test.ts`
- Modify: `rules/models/seedance-2.0.json`、`rules/models/seedance-2.5.json`（补 `required_fields`、`forbidden`）
- Modify: `server/src/index.ts`

**Interfaces:**
- Consumes: Task 4c-1 的 schema；Task 4b-1 的规则加载器。
- Produces: `validate_prompt({ prompt_ir_path }) -> { ok, errors[] }`，`errors[] = { shot_id, field, code: MISSING_FIELD|OUT_OF_RANGE|FORBIDDEN_TERM|MODEL_MISMATCH, message }`。

校验内容：schema 必填；`duration` 落在模型 `duration` 范围内；`aspect_ratio` 在允许集合内；`target_model` 与规则文件一致；文本字段不含 `forbidden` 词表命中项。

- [ ] **Step 1: 写失败的测试**

```text
test("validate passes valid fixture")
test("validate rejects missing required field")
test("validate rejects duration out of range")
test("validate rejects forbidden term")
test("validate rejects model mismatch")
test("validate returns structured errors per shot")
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm --prefix server test -- validate_prompt`
Expected: FAIL。

- [ ] **Step 3: 实现校验工具并扩展规则文件**

- [ ] **Step 4: 运行并确认通过**

Run: `npm --prefix server test -- validate_prompt`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/src/tools/validate_prompt.* server/tests/validate_prompt.* rules/models/ server/src/index.*
git commit -m "feat: add prompt hard rule validation"
```

### Task 4c-3: `render_prompt` 与快照测试

**Files:**
- Create: `server/src/tools/render_prompt.ts`
- Create: `server/tests/render_prompt.test.ts`
- Create: `tests/fixtures/prompts/seedance-2.0.golden.md`、`tests/fixtures/prompts/seedance-2.5.golden.md`
- Modify: `rules/models/seedance-2.0.json`、`rules/models/seedance-2.5.json`（补 `render` 模板定义）

**Interfaces:**
- Consumes: Task 4c-2 的校验工具。
- Produces: `render_prompt({ prompt_ir_path, output_path }) -> { output_path }`；先调用 `validate_prompt`，不通过返回 `HARD_RULE_VIOLATION` 且不写文件。输出文件 `prompts.<model>.md`：按镜头分节，节内顺序固定（镜头号与时长 → 主体与动作 → 环境与时间 → 机位与运镜 → 光线与色彩 → 风格 → 连续性 → 负面约束），正文中文，不含时间戳，行尾统一 `\n`。

- [ ] **Step 1: 写失败测试**

```text
test("render matches golden for seedance 2 0")
test("render matches golden for seedance 2 5")
test("render is deterministic across runs")
test("render handles empty negative prompt")
test("render refuses invalid prompt ir")
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm --prefix server test -- render_prompt`
Expected: FAIL。

- [ ] **Step 3: 实现渲染与模板**

golden 文件先按设计手写，再运行渲染对齐；对齐过程中只允许修正实现或模板，不允许改 golden 迁就实现（除非同步记录到 `docs/model-rules-notes.md`）。

- [ ] **Step 4: 运行并确认通过**

Run: `npm --prefix server test -- render_prompt`
Expected: PASS，两个模型快照一致。

- [ ] **Step 5: Commit**

```bash
git add server/src/tools/render_prompt.* server/tests/render_prompt.* tests/fixtures/prompts/ rules/models/
git commit -m "feat: add prompt rendering with model snapshots"
```

### Task 4c-4: `shot-prompting` Skill

**Files:**
- Create: `skills/shot-prompting/SKILL.md`

**Interfaces:**
- Consumes: `validate_stage_artifact`、`search_knowledge`、`validate_prompt`、`render_prompt`。
- Produces: `$shot-prompting` 流程说明，产物为 `prompts.ir.json` 与 `prompts.<model>.md`。

流程固定为：

1. `validate_stage_artifact({ stage: "shot_planning", path: <run 目录>/shot_plan.json })`；失败即停。
2. 每个镜头检索一次：`search_knowledge({ query: "<subject/action/setting/情绪/光线方向/目标模型>", scope: "project", project_id, categories: ["prompt_technique", "seedance_rule", "example", "camera_lexicon", "character_bible", "scene_description", "visual_style"], target_model, max_cards: 6, char_budget: 4000 })`；需要连续性时可带相邻镜头关键状态。
3. 组装 PromptIR；`knowledge_refs` 逐镜头记录 `used` 与 `dropped_by_budget`。
4. `validate_prompt` 校验；失败时按结构化错误重新生成失败镜头，最多 2 轮修复；2 轮后仍失败 ⇒ 停止阶段，保留已生成产物，报 `HARD_RULE_VIOLATION` 与错误明细，不渲染。
5. 通过后 `render_prompt` 生成 `prompts.<model>.md`；写 `prompts.ir.json` 与提示词文件。

职责边界：不修改镜头计划；需要改镜头时回到 `shot-planning`（写入 SKILL.md）。

- [ ] **Step 1: 写 SKILL.md**

frontmatter `name: shot-prompting`；小节与 3.4 配方、预算、修复循环上限一致。

- [ ] **Step 2: 运行技能契约测试**

Run: `npm --prefix server test -- skills_contract`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add skills/shot-prompting/
git commit -m "feat: add shot prompting skill"
```

---

## 4d：入口编排（script2shot）

### Task 4d-1: `run.schema.json` 与运行目录工具

**Files:**
- Create: `schemas/run.schema.json`
- Create: `server/src/tools/init_run.ts`
- Create: `server/src/tools/read_run.ts`
- Create: `server/src/tools/update_run_state.ts`
- Create: `server/tests/run_tools.test.ts`
- Modify: `server/src/index.ts`

**Interfaces:**
- Consumes: 架构 §11.2 的 `run.json` 结构；Phase 2 校验基础设施。
- Produces:
  - `init_run({ workspace_root, input_mode, project_id, target_model }) -> { run_id, run_json_path }`：创建 `<workspace_root>/.script2shot/outputs/<run_id>/` 与 `run.json`（三阶段初始 `status: "pending"`）。
  - `read_run({ run_id }) -> { run, artifacts, warnings[] }`：校验产物存在性与 schema；`run.json` 与产物不一致时以产物为准修正 `run.json` 并返回 warning `RUN_STATE_RECONCILED`。
  - `update_run_state({ run_id, stage, status: "pending|running|done|failed", artifact?, warnings? }) -> { run }`。

`stages` 的 key 固定：`script_breakdown`、`shot_planning`、`shot_prompting`。

- [ ] **Step 1: 写失败测试**

```text
test("init run creates directory and schema valid run json")
test("init run rejects unknown input mode and model")
test("update run state transitions and stamps updated at")
test("read run detects missing artifact as not done")
test("run reconciles run json from artifacts")
```

`run.reconciles_run_json_from_artifacts`：手改 `run.json` 把已完成阶段标回 `pending`，`read_run` 后状态恢复 `done` 且返回 warning。

- [ ] **Step 2: 运行并确认失败**

Run: `npm --prefix server test -- run_tools`
Expected: FAIL。

- [ ] **Step 3: 实现三个工具与 schema**

- [ ] **Step 4: 运行并确认通过**

Run: `npm --prefix server test -- run_tools`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add schemas/run.schema.json server/src/tools/init_run.* server/src/tools/read_run.* server/src/tools/update_run_state.* server/tests/run_tools.* server/src/index.*
git commit -m "feat: add run directory tools and run schema"
```

### Task 4d-2: `knowledge_refs.json` 与 `warnings.md` 聚合

**Files:**
- Create: `server/src/aggregate.ts`
- Create: `server/tests/aggregate.test.ts`
- Create: `tests/fixtures/knowledge_refs.sample.json`（照 stage-conventions §4 结构）

**Interfaces:**
- Consumes: 三个阶段产物；`run.json`。
- Produces:
  - `aggregate_knowledge_refs({ run_id, script_analysis_path, shot_plan_path, prompt_ir_path, output_path }) -> { output_path, counts }`：读取三个阶段引用，生成 `{ run_id, stages: { script_breakdown: [], shot_planning: [], shot_prompting: [] } }`；`prompts.ir.json` 的逐镜头引用按镜头顺序展平进 `shot_prompting`；某阶段重跑后整体替换该阶段数组。
  - `write_warnings({ run_id, run_path 及三个产物路径, output_path }) -> { output_path, count }`：汇总 `run.json` warnings、阶段产物 `missing_info` 与工具 warnings 为中文 Markdown，按出现顺序去重（code + message 相同视为重复）。

- [ ] **Step 1: 写失败测试**

```text
test("aggregate collects refs from three artifacts")
test("aggregate replaces stage refs on rerun")
test("aggregate flattens prompt refs in shot order")
test("aggregate output matches stage conventions fixture shape")
test("warnings deduplicate identical entries and keep order")
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm --prefix server test -- aggregate`
Expected: FAIL。

- [ ] **Step 3: 实现聚合模块**

- [ ] **Step 4: 运行并确认通过**

Run: `npm --prefix server test -- aggregate`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/src/aggregate.* server/tests/aggregate.* tests/fixtures/knowledge_refs.sample.json
git commit -m "feat: add knowledge refs and warnings aggregation"
```

### Task 4d-3: `script2shot` Skill 与端到端验收

**Files:**
- Create: `skills/script2shot/SKILL.md`
- Create: `server/tests/e2e.test.ts`（fixture 驱动的离线端到端）
- Create: `docs/script2shot-pilot-notes.md`（live 演练记录）

**Interfaces:**
- Consumes: 本阶段全部工具与三个阶段 Skill。
- Produces: `$script2shot` 入口流程；离线端到端用例；live 演练记录。

入口流程（写入 SKILL.md）：

1. 新 run：要求用户提供 `project_id` 与单一 `target_model`；识别输入模式（片段/单集/多集）；多集时写 warning 建议按集运行。
2. `refresh_local_index`：B 不可达但有缓存 ⇒ 继续 + warning；无缓存 ⇒ 停止。
3. `init_run` 创建运行目录与 `run.json`。
4. 按顺序读取并执行 `skills/script-breakdown/SKILL.md`、`skills/shot-planning/SKILL.md`、`skills/shot-prompting/SKILL.md`；每阶段结束：`validate_stage_artifact`（或 `validate_prompt`）→ `update_run_state`。
5. 全部完成后 `aggregate_knowledge_refs` + `write_warnings`；报告产物路径与警告摘要。
6. 续跑：`from <stage>` 复用上游产物（先校验），`only <stage>` 只执行一个阶段；续跑从 `run.json` 恢复 `project_id`、`target_model`、输入模式，不重新询问。

阶段失败语义：不更新该阶段 `run.json` 状态；保留已生成中间产物；报告结构化错误与重试建议。

- [ ] **Step 1: 写 SKILL.md**

frontmatter `name: script2shot`；正文含 `适用时机`、`新 run 流程`、`续跑（from/only）`、`阶段失败处理`、`输出清单`、`边界`（入口不做创作判断，不实现检索/校验/渲染逻辑）。

- [ ] **Step 2: 写失败的离线端到端用例**

```text
test("fixture run pipeline produces all seven artifacts")
test("entry refuses to run shot planning with invalid upstream")
test("entry warns on multiple episodes")
test("rerun replaces stage refs without duplicating")
```

fixture 管道：`init_run` → 依次放入三个有效产物 fixture → `update_run_state` 三次 → `aggregate_knowledge_refs` + `write_warnings` → 断言 7 个文件存在且 `knowledge_refs.json` 结构符合 stage-conventions §4。

- [ ] **Step 3: 运行并确认失败**

Run: `npm --prefix server test -- e2e`
Expected: FAIL。

- [ ] **Step 4: 实现并跑通**

Run: `npm --prefix server run build`；`npm --prefix server test`
Expected: 全部 PASS。

- [ ] **Step 5: live 演练（真实模型）**

用一个真实单集样例剧本从 `$script2shot` 跑完整链路；核对 7 个产物、两个关键路径（`from shot-planning`、`only shot-prompting`）和人工修改产物后的重校验行为；把结果写入 `docs/script2shot-pilot-notes.md`。

- [ ] **Step 6: Commit**

```bash
git add skills/script2shot/ server/tests/e2e.* docs/script2shot-pilot-notes.md
git commit -m "feat: add script2shot entry orchestration and end to end validation"
```

---

## 阶段出口检查

- [ ] 四个 schema（script_analysis、shot_plan、prompt_ir、run）fixture 均覆盖缺失必填与错误枚举。
- [ ] 两个 Seedance 渲染快照测试通过。
- [ ] `from` / `only` 续跑与人工修改后的重校验行为有测试和 live 记录。
- [ ] `knowledge_refs.json` 与 `warnings.md` 只由入口生成，结构符合 stage-conventions §4。
- [ ] `script2shot` 全链路产出 7 个运行产物（run.json、script_analysis.json、shot_plan.json、prompts.ir.json、prompts.<model>.md、knowledge_refs.json、warnings.md）。
