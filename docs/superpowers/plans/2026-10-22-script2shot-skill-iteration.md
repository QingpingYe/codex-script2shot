# 技能迭代实施计划：提示词链路强化（I1–I3 执行 + I4 拆分）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal：** 按 `docs/sd25-pe-optimization-plan-2026-10-22.md` 采纳的 I1–I3，把上游已产出的景别、情绪、对白与声音信息完整落进 PromptIR 与最终提示词，并把 Seedance 2.0 / 2.5 的能力差异显式落到模型规则与写作指导。

**Architecture：** 保持既有分层——模型无关的 PromptIR（`schemas/prompt_ir.schema.json`）+ 模型参数化规则文件（`rules/models/*.json`）+ 确定性 MCP 渲染与校验（`render_prompt` / `validate_prompt`）+ Skill 只做创作与编排。I1–I3 只扩展 PromptIR 镜头字段、渲染节与规则文件字段；不改阶段边界、不改七个产物清单、不改 MCP 工具名单。

**Tech Stack：** Node.js >= 24 + TypeScript；vitest；MCP stdio；快照测试按字节比较（`.gitattributes` 固定 LF）。

**Spec：** `docs/sd25-pe-optimization-plan-2026-10-22.md`（I1–I4 采纳版）；`docs/superpowers/plans/2026-10-22-script2shot-skill-iteration-review.md`（复查意见，v2 已并入）；`docs/architecture.md` §9.5、§9.6、§11.3、§11.4；`docs/model-rules-notes.md`；`references/stage-conventions.md` §3.4、§3.5、§4。

**前置：** Phase 4 已完成且 server 测试全绿。本计划按 Part A → Part B → Part C 顺序执行，每个 Task 一次提交。I4 不在本计划执行范围，见 Part D 的拆分与前置裁决。

**版本：** v2（2026-10-22，依据复查报告修订）。相对 v1：新增 Task A0（`shot_plan` 时长整数校验）；原 C1 提前为 B3 并新增 `long_shot_staging_threshold_sec`；原 B3 / B4 顺延为 B4 / B5 且改为引用 `prompt_guidance`；原 C2 / C3 顺延为 C1 / C2，C1 改用扫描模式同步并补 `refresh_local_index` 与可核对断言；台词禁词边界定为「原文保真豁免 + 文档重定义 + 裁决测试」；接口类 Task 第 1 步先改设计文档；B4 / B5 增加轻量内容契约测试；B3 规则测试参数化；统一修正引用精度与提交文件清单。

## Global Constraints

- 双模型同步支持：任何 PromptIR / 规则 / 渲染改动必须在同一次改动内同时覆盖 `seedance-2.0` 与 `seedance-2.5`，两份 fixture 与两份 golden 成对更新。
- PromptIR 是冻结接口：字段扩展属不兼容变更，先更新 `docs/architecture.md` §11.3 与 `docs/model-rules-notes.md`，再同批改 schema、工具、Skill、fixture 与测试（AGENTS.md §2、§3）。
- 文档优先（AGENTS.md §2）：凡改动 schema、规则字段、渲染节或校验行为的 Task，第 1 步先更新 `docs/architecture.md` / `docs/model-rules-notes.md` 的目标接口，再动 fixture、测试与实现。
- 正文语言：提示词正文中文；结构化字段与枚举英文；英文枚举到中文的映射必须同时出现在 schema 描述、渲染层常量、测试三处（沿用 `camera_angle` / `camera_movement` 模式）。
- 硬规则与模型数值只在 `rules/models/*.json`：Skill、产物与注释不复制时长、画幅、阶段化阈值、必填、禁止项数值；写作指导（`prompt_guidance`，含 `long_shot_staging_threshold_sec`）只供写作参考，不参与校验判定。
- 内容保真：台词只取 `dialogue_units.text` 原文，不扩写；不擅自补语言、口音、旁白；情绪只取材 `emotion_units.tone` + `emotion_units.description` 与同镜头已有 `action_units` 的动作线索，无支撑留空，禁止由抽象情绪反推未发生的身体动作；声音只取材上游原文与检索卡片。
- 禁词扫描边界（A3 裁决）：`forbidden` 扫描覆盖「由 Agent 撰写、可改写的提示词正文字段」；`dialogue` 是原文保真豁免区（不得为通过校验改写台词）。A3 把该定义同步进 `docs/model-rules-notes.md` §2.3.2 / §3 与 `docs/architecture.md` §11.3，并加裁决测试。
- 已核实事实（2026-10-22 实读本地 AI 库缓存）：2.0 与 2.5 都支持 `{}` 台词、`<>` 音效、`()` 音乐语法。卡片：`src:RpJHdwWB5onT8qx5fWqcw6Qnn9c:prompt_technique:013`「语言与特殊字符规范」（2.0；来源 `https://docs.volcengine.com/docs/ark/seedance-2-0-prompt-guide?lang=zh`，检索日期 2026-10-22）；`src:YcFddglYToIItoxnK3mcXXctnJb:prompt_technique:007`「声音与文字的特殊字符约定」（2.5；来源飞书文档 `OsiUdR1OxoDqvnxsK8LczYx7nPd`《Seedance 2.5 提示词撰写指南》，检索日期 2026-10-22）；`src:Jb6wdU3X3ocpzdxEgLhctgtNnkh:seedance_rule:011`「Seedance 2.0 与 2.5 的提示词维度差异对照」（2.0 台词以中文、英语为主且要求语言统一、小语种必须标注；2.5 支持更多语种）。因此原提案 I1.4「按模型裁剪渲染节」不构建：两模型统一渲染全部节，模型差异落在 `prompt_guidance`。
- 外部事实必须写入 `docs/model-rules-notes.md`，带来源与检索日期；官方文档不可访问时用知识卡来源并标注「待官方复核」。
- 渲染确定性：golden 逐字节比较、行尾 LF、不含时间戳与 run 元数据；空值的省略 / 占位规则冻结后必须与两份 golden 一致。
- 本计划不引入新生产依赖；不改 `plugin.json` 版本与 MCP 工具签名。

## Review Focus

1. 双模型成对更新：新增镜头字段后两份规则文件与两份 golden 必须同步（Task A1、A3、B1、B2 的 golden 用例）。
2. 空值与缺省路径：空 `time` / `emotion` / `dialogue` / `audio` 的省略与占位渲染稳定（Task A2、A3、B1、B2）。
3. 台词保真与语言规则：台词只取原文、不擅自加语言口音；台词含 `fps` / `duration` 等禁词仍原样保留；2.0 语言统一、小语种标注（Task A3 裁决测试 + Task B3 指导字段）。
4. 旧产物 fail-closed：非整数 `duration_sec` 被上游拒绝；缺新字段的 PromptIR（旧 run、手改产物）被 schema / 校验拒绝（Task A0、A1、A3、B1、B2 反例）。
5. 文档与实现同步：每个接口类 Task 先改文档再实现；收尾全量回归并处理 `server/dist` 占用（Task C2）。

## 任务总览

| Task | 迭代 | 产物 | 依赖 |
| --- | --- | --- | --- |
| A0 | 前置修正 | `shot_plan` 时长整数校验 | — |
| A1 | I1.1 | PromptIR `shot_size` + 景别渲染 | A0 |
| A2 | I1.2 | 渲染层时间中文化 | A1 |
| A3 | I1.3 | PromptIR `dialogue` + 渲染 + 校验 + 禁词豁免裁决 | A2 |
| B1 | I2.1 | PromptIR `emotion` | A3 |
| B2 | I2.3 | PromptIR `audio` + 渲染 | B1 |
| B3 | I3.1 | 规则文件 `prompt_guidance`（含阶段化阈值） | B2 |
| B4 | I2.2 | 事件脚本化与长镜头阶段化（Skill，引用 B3） | B3 |
| B5 | I2.4 / I2.5 | 负面约束策略 + 渲染前自检清单（Skill，引用 B3） | B4 |
| C1 | I3.2 | 知识卡草稿与同步 | B5 |
| C2 | 收尾 | 全量回归与文档收尾 | C1 |

---

## Part A：I1 信息不断档

### Task A0: `shot_plan` 时长整数校验（前置修正）

**Files:**
- Modify: `server/src/tools/validate_stage_artifact.ts`、`server/tests/validate_stage_artifact.test.ts`
- Modify: `skills/shot-planning/SKILL.md`
- Modify: `schemas/shot_plan.schema.json`（仅 `duration_sec` 的 description 注明整数秒，不改 `type: number`）
- Modify: `docs/architecture.md`（§9.5、§13）、`docs/model-rules-notes.md`（§3）

**Interfaces:**
- Produces: `validate_stage_artifact({ stage: "shot_planning", path })` 对 `scenes[].shots[].duration_sec` 增加整数校验；每个镜头至多返回一条时长错误：非整数时返回 `{ path: "/scenes/<i>/shots/<j>/duration_sec", code: "OUT_OF_RANGE", message: 含「整数秒」 }`；整数时按现有范围逻辑判定。
- 裁决：`shot_plan.schema.json` 保持 `type: number`（冻结接口不收紧类型），整数约束由校验层执行；`shot-prompting` 的既有口径（「duration 取整数秒」「不是整数秒 ⇒ OUT_OF_RANGE」）由此变得准确，不需要改动。

- [ ] **Step 1: 更新设计文档接口**

`docs/architecture.md` §9.5 镜头规划检查项补「单镜头时长为整数秒」；§13 失败表补「`duration_sec` 非整数 ⇒ OUT_OF_RANGE，回退 shot-planning」。`docs/model-rules-notes.md` §3 记录「整数秒 + 范围」校验口径与「schema 不收紧类型、由校验层执行」的裁决。

- [ ] **Step 2: 写失败测试**

```text
test("shot plan rejects non integer duration")   // 读 shot_plan.sample.json，把 scenes[0].shots[0].duration_sec 改为 7.5，写临时文件
                                                 // 期望 { ok:false, errors:[{ path:"/scenes/0/shots/0/duration_sec", code:"OUT_OF_RANGE" }] }，message 含「整数」
```

- [ ] **Step 3: 运行并确认失败**

Run: `npm --prefix server test -- validate_stage_artifact`
Expected: FAIL（当前 7.5 通过校验）。

- [ ] **Step 4: 实现校验**

`validate_shot_plan_durations` 在范围判定前插入 `Number.isInteger(shot.duration_sec)` 判定（非整数即返回整数秒错误、不再判范围）；`skills/shot-planning/SKILL.md` 的输出与失败处理补「`duration_sec` 必须为整数秒」；`schemas/shot_plan.schema.json` 仅更新 `duration_sec.description`。

- [ ] **Step 5: 运行并确认通过**

Run: `npm --prefix server test -- validate_stage_artifact`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add server/src/tools/validate_stage_artifact.ts server/tests/validate_stage_artifact.test.ts skills/shot-planning/SKILL.md schemas/shot_plan.schema.json docs/architecture.md docs/model-rules-notes.md
git commit -m "fix: enforce integer shot durations in stage validation"
```

### Task A1: PromptIR 增加 `shot_size` 与景别渲染

**Files:**
- Modify: `schemas/prompt_ir.schema.json`
- Modify: `server/src/tools/render_prompt.ts`、`server/src/tools/validate_prompt.ts`
- Modify: `rules/models/seedance-2.0.json`、`rules/models/seedance-2.5.json`
- Modify: `skills/shot-prompting/SKILL.md`
- Modify: `docs/architecture.md`（§11.3）、`docs/model-rules-notes.md`（§2.3.1、§4.2）
- Modify: `tests/fixtures/prompts_ir.sample.json`、`tests/fixtures/prompts/seedance-2.0.ir.json`、`tests/fixtures/prompts/seedance-2.5.ir.json`、`tests/fixtures/prompts/seedance-2.0.golden.md`、`tests/fixtures/prompts/seedance-2.5.golden.md`
- Test: `server/tests/render_prompt.test.ts`、`server/tests/prompt_ir.test.ts`、`server/tests/validate_prompt.test.ts`

**Interfaces:**
- Consumes: `schemas/shot_plan.schema.json` 的 9 值中文景别枚举（顺序冻结：大远景、远景、全景、中全景、中景、中近景、近景、特写、插入镜头）。
- Produces: PromptIR 镜头字段 `shot_size`（英文枚举，顺序与 shot_plan 一致：`extreme-long-shot`、`long-shot`、`full-shot`、`medium-full-shot`、`medium-shot`、`medium-close-up`、`close-shot`、`close-up`、`insert-shot`）；`render_prompt.ts` 导出 `SHOT_SIZE_LABELS`（英文枚举 → 中文，键顺序 == schema enum 顺序）；渲染行格式 `- 景别、机位与运镜：景别：中景；机位：仰视；运镜：手持`。
- 位置口径：schema `properties`、schema `required` 与 `validate_prompt.ts` 的 `SHOT_FIELD_ORDER` 三处保持一致——`shot_size` 插在 `aspect_ratio` 与 `subject` 之间（`required` 顺序与 `properties` 一致，错误排序稳定依赖该顺序）。

- [ ] **Step 1: 更新设计文档接口**

`docs/architecture.md` §11.3：PromptIR 示例与字段说明补 `shot_size`。`docs/model-rules-notes.md` §2.3.1：`required_fields` 增 `shot_size`，来源标注为插件设计裁决（景别取自 shot_plan 冻结枚举，无外部来源）；§4.2：`camera` 节格式更新为「景别、机位与运镜」。

- [ ] **Step 2: 手工更新 fixture 与 golden（golden 先行）**

给 `prompts_ir.sample.json`、两份 `prompts/*.ir.json` 补 `shot_size`（2.5：sh01 `medium-shot`、sh02 `medium-close-up`；2.0 fixture 按其镜头语义取值）；按设计手写两份 golden 的新行 `- 景别、机位与运镜：景别：…；机位：…；运镜：…`，并同步两个规则文件的 `render.section_labels.camera` 为「景别、机位与运镜」。

- [ ] **Step 3: 写失败测试**

```text
test("shot size label table matches the frozen english and chinese enums")   // render_prompt.test.ts：键==prompt_ir enum、值==shot_plan enum、长度 9
test("render includes shot size in camera section")                          // render_prompt.test.ts：golden 比对
test("prompt ir rejects unknown shot size")                                  // prompt_ir.test.ts：编辑 sample，期望路径 shots[0].shot_size
test("validate rejects missing shot size")                                   // validate_prompt.test.ts：删除字段后期望 MISSING_FIELD
```

- [ ] **Step 4: 运行并确认失败**

Run: `npm --prefix server test -- render_prompt`
Expected: FAIL（golden 新增景别行未实现）。

- [ ] **Step 5: 实现 schema、渲染与校验**

`schemas/prompt_ir.schema.json`：`shot` 的 `properties` 与 `required` 按位置口径增 `shot_size`（enum 9 值，描述写明与 shot_plan 的映射）。`validate_prompt.ts`：`SHOT_FIELD_ORDER` 同位置插入 `shot_size`。`render_prompt.ts`：新增 `SHOT_SIZE_LABELS`，`camera` 节拼接改为景别 / 机位 / 运镜。两个规则文件：`required_fields` 增 `shot_size`。`skills/shot-prompting/SKILL.md`：输出表补字段与中英映射表，流程补「`shot_size` 取自上游 `shot_size` 枚举」。

- [ ] **Step 6: 运行并确认通过**

Run: `npm --prefix server test -- render_prompt prompt_ir validate_prompt e2e`
Expected: PASS（e2e 使用更新后的 `prompts_ir.sample.json`）。

- [ ] **Step 7: Commit**

```bash
git add schemas/prompt_ir.schema.json server/src/tools/render_prompt.ts server/src/tools/validate_prompt.ts rules/models/seedance-2.0.json rules/models/seedance-2.5.json skills/shot-prompting/SKILL.md docs/architecture.md docs/model-rules-notes.md tests/fixtures/prompts_ir.sample.json tests/fixtures/prompts/seedance-2.0.ir.json tests/fixtures/prompts/seedance-2.5.ir.json tests/fixtures/prompts/seedance-2.0.golden.md tests/fixtures/prompts/seedance-2.5.golden.md server/tests/render_prompt.test.ts server/tests/prompt_ir.test.ts server/tests/validate_prompt.test.ts
git commit -m "feat: add shot size to prompt ir and rendering"
```

### Task A2: 渲染层时间术语中文化

**Files:**
- Modify: `server/src/tools/render_prompt.ts`
- Modify: `tests/fixtures/prompts/seedance-2.0.golden.md`、`tests/fixtures/prompts/seedance-2.5.golden.md`
- Modify: `docs/model-rules-notes.md`（§4.3）
- Test: `server/tests/render_prompt.test.ts`

**Interfaces:**
- Produces: `render_prompt.ts` 导出 `TIME_LABELS`（`night`→夜晚、`day`→白天、`dawn`→清晨、`dusk`→黄昏、`morning`→早晨、`noon`→正午、`afternoon`→下午、`evening`→傍晚）；未收录词原样透传；空 `time` 仍不生成子标签。

- [ ] **Step 1: 更新设计文档接口**

`docs/model-rules-notes.md` §4.3 增裁决记录：时间词映射为渲染层插件设计决策（无外部来源）；`time` 字段 schema 保持英文术语，仅渲染层本地化；未收录词原样、空值省略。

- [ ] **Step 2: 写失败测试**

```text
test("render localizes english time terms")   // time=night 期望「时间：夜晚」
test("render passes through unknown time term") // time=holographic-noon 期望原样输出
```

- [ ] **Step 3: 运行并确认失败**

Run: `npm --prefix server test -- render_prompt`
Expected: FAIL。

- [ ] **Step 4: 实现映射并同步 golden**

`render_prompt.ts` 新增 `TIME_LABELS` 与 `time_label()`（命中映射取中文，否则原样）；`setting_time` 节改用该函数；同步两份 golden（`时间：夜晚`）。

- [ ] **Step 5: 运行并确认通过**

Run: `npm --prefix server test -- render_prompt`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add server/src/tools/render_prompt.ts server/tests/render_prompt.test.ts tests/fixtures/prompts/seedance-2.0.golden.md tests/fixtures/prompts/seedance-2.5.golden.md docs/model-rules-notes.md
git commit -m "feat: localize time terms in prompt rendering"
```

### Task A3: 台词通道 v1（`PromptIR.dialogue` + 禁词豁免裁决）

**Files:**
- Modify: `schemas/prompt_ir.schema.json`
- Modify: `server/src/tools/render_prompt.ts`、`server/src/tools/validate_prompt.ts`
- Modify: `server/src/rules.ts`（`ModelRulesRender.empty_dialogue`）
- Modify: `rules/models/seedance-2.0.json`、`rules/models/seedance-2.5.json`（`render.empty_dialogue`、`section_labels.dialogue`、`section_order`）
- Create: `tests/fixtures/prompts_ir.invalid.bad_dialogue.json`
- Modify: `tests/fixtures/prompts_ir.sample.json`、两份 `prompts/*.ir.json` 与 golden
- Modify: `skills/shot-prompting/SKILL.md`
- Modify: `docs/architecture.md`（§9.6、§11.3）、`docs/model-rules-notes.md`（§2.3.2、§2.4 新增、§3、§4）
- Test: `server/tests/render_prompt.test.ts`、`server/tests/prompt_ir.test.ts`、`server/tests/validate_prompt.test.ts`、`server/tests/rules.test.ts`、`server/tests/e2e.test.ts`

**Interfaces:**
- Produces: PromptIR 镜头字段 `dialogue`（必填数组，可为空）：条目 `{ speaker: string(非空), text: string(非空), language?: string, delivery?: string }`，`additionalProperties: false`。
- Produces: 规则文件 `render.empty_dialogue: string`（非空）；渲染节 `dialogue`，标签「对白」。
- 渲染格式（冻结）：`- 对白：角色A说：{你一个外人}；角色B用日语轻声说：{もう大丈夫です}`。固定拼接顺序 `{speaker}用{language}{delivery}说：{text}`；`language` / `delivery` 缺失或为纯空白串时视同缺省并省略对应片段；两字段使用中文短词（如「日语」「轻声」）。空数组渲染为 `- 对白：{render.empty_dialogue}`（取值 `无对白；人物自然闭口，无旁白`）。
- Skill 通用规则（模型差异不写进 Skill，归 Task B3 的 `prompt_guidance`）：台词只取 `dialogue_units.text`；只有意图没有原文时不编造，改为可观察口型、停顿与反应；`language` 只在台词文本为非中文且语种可由文字直接判定时填写；`delivery` 只在原文或检索卡片有依据时填写；多人对话逐句标说话人；无对白镜头留空数组。
- 禁词边界（裁决）：`validate_prompt` 的禁止项扫描不覆盖 `dialogue`（台词为原文保真豁免区，不得为通过校验改写台词）；扫描范围的文档定义改为「由 Agent 撰写、可改写的提示词正文字段」，并加裁决测试钉住该行为。

- [ ] **Step 1: 更新设计文档接口**

`docs/architecture.md` §11.3：补 `dialogue` 字段示例与「dialogue 为原文保真豁免区」说明；§9.6 补台词取材与语言规则。`docs/model-rules-notes.md` §2.3.2 / §3：把 forbidden 扫描范围从「最终渲染进提示词正文的文本」改为「由 Agent 撰写、可改写的提示词正文字段」，并列明 `dialogue` 为豁免区及理由；§4.1 / §4.2 补 `empty_dialogue` 与 dialogue 节位置。

- [ ] **Step 2: 核对并记录两模型台词语法来源**

按 Global Constraints 的卡片证据逐条核对官方文档，写入 `docs/model-rules-notes.md` 新增 §2.4「台词与声音语法来源」：2.0 支持 `{}` 且语言需统一、避免中英混用（专有名词除外）、小语种必须标注；2.5 支持更多语种；2.5 指南来源写明飞书文档 `OsiUdR1OxoDqvnxsK8LczYx7nPd`《Seedance 2.5 提示词撰写指南》与检索日期。官方页面不可访问时，以卡片来源记录并标注「待官方复核」。

- [ ] **Step 3: 写失败测试**

```text
test("prompt ir rejects dialogue entry with empty text")     // prompts_ir.invalid.bad_dialogue.json，期望路径 shots[0].dialogue[0].text
test("render formats dialogue with optional language and delivery")
test("render marks silent shots with empty dialogue placeholder")  // 空数组 → 「无对白；人物自然闭口，无旁白」
test("rules reject missing empty dialogue")                  // rules.test.ts：临时规则目录删除 empty_dialogue → 抛错
test("validate keeps verbatim dialogue even when it contains forbidden terms")  // 裁决测试：dialogue[0].text 含 "fps" 与 "duration" → { ok:true, errors:[] }
test("render preserves verbatim dialogue text")              // 裁决测试：渲染输出仍含同一条原文
```

- [ ] **Step 4: 运行并确认失败**

Run: `npm --prefix server test -- render_prompt prompt_ir`
Expected: FAIL。

- [ ] **Step 5: 实现 schema、渲染、校验与规则字段**

schema 按位置口径在 `action` 之后增 `dialogue`（`required`；条目字段顺序 speaker / text / language / delivery）；`validate_prompt.ts` `SHOT_FIELD_ORDER` 同位置插入 `dialogue`，且不把 dialogue 加入禁止项扫描分支；`render_prompt.ts` 增 `dialogue` 节、`{...}` 包裹与空值省略逻辑；`rules.ts` 的 `ModelRulesRender` 增 `empty_dialogue` 并校验非空字符串；两个规则文件补 `empty_dialogue`、`section_labels.dialogue = "对白"`、`section_order` 在 `subject_action` 之后插入 `dialogue`。

- [ ] **Step 6: 更新 Skill 与 fixture / golden**

`skills/shot-prompting/SKILL.md`：输出表补 `dialogue`；流程第 3 步写入 Interfaces 的通用规则（不含模型语言差异）；失败处理表补「`dialogue[].text` 为空 ⇒ 修正该镜头后重写」。fixture：2.5 与 2.0 两份都覆盖「有台词」与「无台词」两条路径（各自 sh01 有台词、sh02 无台词）；2.5 至少一条含 `language`（如「日语」）与 `delivery` 的条目覆盖完整拼接，其余覆盖省略路径；golden 手写对应行。

- [ ] **Step 7: 运行并确认通过**

Run: `npm --prefix server test -- render_prompt prompt_ir validate_prompt rules e2e`
Expected: PASS。

- [ ] **Step 8: Commit**

```bash
git add schemas/prompt_ir.schema.json server/src/tools/render_prompt.ts server/src/tools/validate_prompt.ts server/src/rules.ts rules/models/seedance-2.0.json rules/models/seedance-2.5.json skills/shot-prompting/SKILL.md docs/architecture.md docs/model-rules-notes.md tests/fixtures/prompts_ir.sample.json tests/fixtures/prompts_ir.invalid.bad_dialogue.json tests/fixtures/prompts/seedance-2.0.ir.json tests/fixtures/prompts/seedance-2.5.ir.json tests/fixtures/prompts/seedance-2.0.golden.md tests/fixtures/prompts/seedance-2.5.golden.md server/tests/render_prompt.test.ts server/tests/prompt_ir.test.ts server/tests/validate_prompt.test.ts server/tests/rules.test.ts
git commit -m "feat: add dialogue channel with verbatim exemption"
```

---

## Part B：语义完整与模型写作指导（I2.1–I2.5、I3.1）

### Task B1: `PromptIR.emotion` 与情绪可观察化

**Files:**
- Modify: `schemas/prompt_ir.schema.json`、`server/src/tools/render_prompt.ts`、`server/src/tools/validate_prompt.ts`
- Modify: fixtures 与两份 golden（同 Task A1 清单）
- Modify: `skills/shot-prompting/SKILL.md`、`docs/architecture.md`（§11.3、§9.6）
- Test: `server/tests/render_prompt.test.ts`、`server/tests/prompt_ir.test.ts`、`server/tests/e2e.test.ts`

**Interfaces:**
- Produces: PromptIR 镜头字段 `emotion`（schema `required`，string，允许空字符串）；`subject_action` 节在 `emotion` 非空时追加子标签 `情绪：…`，空值省略。
- 位置口径：schema `properties` / `required` 与 `SHOT_FIELD_ORDER` 三处一致，`emotion` 在 `action` 之后、`dialogue` 之前。
- Skill 规则：`emotion` 取材 `emotion_units.tone` + `emotion_units.description`，并可引用同镜头已有 `action_units` 的动作线索（例如视线、停顿、手部动作）；只有这些来源已支持可观察表现时才填写，否则留空；禁止由抽象情绪反推未发生的身体动作；写作可参考检索到的「情绪具象外化」类卡片。

- [ ] **Step 1: 更新设计文档接口**

`docs/architecture.md` §11.3 补 `emotion` 字段与取材规则；§9.6 补「情绪只取材 tone / description / 同镜头动作线索，无支撑留空」。

- [ ] **Step 2: 写失败测试**

```text
test("prompt ir requires emotion per shot")        // 删除字段后期望路径 shots[0].emotion
test("render shows emotion when present")          // 「主体：…；动作：…；情绪：…」
test("render omits emotion when empty")
```

- [ ] **Step 3: 运行并确认失败**

Run: `npm --prefix server test -- render_prompt prompt_ir`
Expected: FAIL。

- [ ] **Step 4: 实现并更新 fixture / golden / Skill**

schema 与 `SHOT_FIELD_ORDER` 按位置口径增 `emotion`；渲染层在 `subject_action` 节拼 `情绪` 子标签（沿用 `field()` 的空值省略语义）；fixture 2.5 sh01 填有来源支撑的可观察情绪，sh02 留空覆盖省略路径；`skills/shot-prompting/SKILL.md` 补取材与可观察化规则。

- [ ] **Step 5: 运行并确认通过**

Run: `npm --prefix server test -- render_prompt prompt_ir e2e`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add schemas/prompt_ir.schema.json server/src/tools/render_prompt.ts server/src/tools/validate_prompt.ts tests/fixtures/prompts_ir.sample.json tests/fixtures/prompts/seedance-2.0.ir.json tests/fixtures/prompts/seedance-2.5.ir.json tests/fixtures/prompts/seedance-2.0.golden.md tests/fixtures/prompts/seedance-2.5.golden.md server/tests/render_prompt.test.ts server/tests/prompt_ir.test.ts skills/shot-prompting/SKILL.md docs/architecture.md
git commit -m "feat: add emotion field with observable phrasing rules"
```

### Task B2: 声音通道（`PromptIR.audio`）

**Files:**
- Modify: `schemas/prompt_ir.schema.json`、`server/src/tools/render_prompt.ts`、`server/src/tools/validate_prompt.ts`
- Modify: `rules/models/seedance-2.0.json`、`rules/models/seedance-2.5.json`（`render.section_labels.audio` 与 `section_order`）
- Modify: fixtures 与两份 golden（同 Task A1 清单）
- Modify: `skills/shot-prompting/SKILL.md`、`docs/architecture.md`（§11.3、§9.6）、`docs/model-rules-notes.md`（§2.4、§4）
- Test: `server/tests/render_prompt.test.ts`、`server/tests/prompt_ir.test.ts`、`server/tests/validate_prompt.test.ts`、`server/tests/e2e.test.ts`

**Interfaces:**
- Produces: PromptIR 镜头字段 `audio`（schema `required` 对象，`additionalProperties: false`）：`{ ambience: string[], sfx: string[], music: string }`，三项均可为空。
- 位置口径：schema `properties` / `required` 与 `SHOT_FIELD_ORDER` 三处一致，`audio` 在 `style` 之后、`continuity` 之前。
- 渲染节 `audio`，标签「声音」：`- 声音：环境声：雨声；音效：<远处雷声>；音乐：(低沉弦乐)`（空子项省略；`sfx` 每项包裹 `<>`，`music` 非空时包裹 `()`；三项全空时整行省略，不输出「无声音」类负向暗示）。
- Skill 规则：只从原文已有线索（雨、脚步、门响等）与检索卡片提炼；不得编造原文没有的声音事件。

- [ ] **Step 1: 更新设计文档接口**

`docs/architecture.md` §11.3 / §9.6 补 `audio` 字段与取材规则；`docs/model-rules-notes.md` §2.4 补 2.0 / 2.5 音乐、音效符号来源（含检索日期）；§4.2 补声音节格式与省略裁决，**并列说明两种空值策略**：对白维持节骨架并输出 `empty_dialogue` 占位（闭口指令需要显式表达），声音整行省略（避免「无声音」类负向暗示）。

- [ ] **Step 2: 写失败测试**

```text
test("prompt ir requires audio object per shot")
test("render formats audio labels with angle and round brackets")
test("render omits audio section when all buffers empty")
test("validate rejects forbidden term in audio fields")   // 例如 audio.music 含 "fps" → FORBIDDEN_TERM
```

- [ ] **Step 3: 运行并确认失败**

Run: `npm --prefix server test -- render_prompt prompt_ir`
Expected: FAIL。

- [ ] **Step 4: 实现并更新 fixture / golden / Skill**

schema 与 `SHOT_FIELD_ORDER` 按位置口径增 `audio`；`validate_prompt.ts` 仿照 `continuity` 的写法新增 `field === "audio"` 分支，对 `ambience[]` / `sfx[]` / `music` 逐个做禁止项扫描（属 agent 撰写内容，需扫禁止项）；`render_prompt.ts` 增 `audio` 节，`section_order` 中置于 `style` 之后；fixture：2.5 sh01 填环境声 + 音效（雷声）覆盖完整路径，sh02 全空覆盖省略路径；`skills/shot-prompting/SKILL.md` 补声音取材规则与符号约定。

- [ ] **Step 5: 运行并确认通过**

Run: `npm --prefix server test -- render_prompt prompt_ir validate_prompt e2e`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add schemas/prompt_ir.schema.json server/src/tools/render_prompt.ts server/src/tools/validate_prompt.ts rules/models/seedance-2.0.json rules/models/seedance-2.5.json tests/fixtures/prompts_ir.sample.json tests/fixtures/prompts/seedance-2.0.ir.json tests/fixtures/prompts/seedance-2.5.ir.json tests/fixtures/prompts/seedance-2.0.golden.md tests/fixtures/prompts/seedance-2.5.golden.md server/tests/render_prompt.test.ts server/tests/prompt_ir.test.ts server/tests/validate_prompt.test.ts skills/shot-prompting/SKILL.md docs/architecture.md docs/model-rules-notes.md
git commit -m "feat: add audio channel to prompt ir and rendering"
```

### Task B3: 规则文件增加 `prompt_guidance`（含阶段化阈值）

**Files:**
- Modify: `server/src/rules.ts`、`rules/models/seedance-2.0.json`、`rules/models/seedance-2.5.json`
- Modify: `skills/shot-prompting/SKILL.md`
- Modify: `docs/architecture.md`（§9.6、§11.4）、`docs/model-rules-notes.md`（§2.4、§5 新增）
- Test: `server/tests/rules.test.ts`

**Interfaces:**
- Produces: `ModelRules.prompt_guidance`：

```json
{
  "long_shot_staging_threshold_sec": 15,
  "shot_structure": "……",
  "dialogue": "……",
  "sound": "……",
  "negative": "……"
}
```

  四个文案键均为非空字符串；`long_shot_staging_threshold_sec` 必须为正有限数。`rules.ts` 解析时缺键、空串、空白串或非法阈值按安装损坏抛错。
- 用途：只供 `shot-prompting` 只读参考写作口径，不参与 `validate_prompt` 判定。2.0 / 2.5 取值按已核实事实区分（2.5 长镜阶段化、多语种台词；2.0 单事件、语言统一、小语种标注）。
- 阈值裁决：两个模型均取 15 秒；2.5 表示「超过 15 秒的长镜头必须阶段化」（插件设计裁决，依据超过 2.0 单段上限即视为长镜头）；2.0 的 15 等于其单段上限、实务上不触发。
- 边界修订：`skills/shot-prompting/SKILL.md` 的「只调用五个 MCP 工具」句改为「只调用五个 MCP 工具，另只读目标模型规则文件的 `prompt_guidance`」；明确选择本地文件读取，不新增 MCP 工具。

- [ ] **Step 1: 更新设计文档接口**

`docs/architecture.md` §9.6（`shot-prompting` 只读 `prompt_guidance` 的例外）、§11.4（规则文件职责补 `prompt_guidance`）；`docs/model-rules-notes.md` 新增 §5「prompt_guidance 逐值来源」，逐段写来源与检索日期。

- [ ] **Step 2: 写失败测试（参数化）**

```text
test.each(["shot_structure", "dialogue", "sound", "negative"])("rules reject missing guidance key %s")
test.each(["shot_structure", "dialogue", "sound", "negative"])("rules reject blank guidance key %s")
test("rules reject missing staging threshold")
test("rules reject non positive staging threshold")
test("rules expose per model prompt guidance")   // 两模型：四键非空、threshold 为正数
```

- [ ] **Step 3: 运行并确认失败**

Run: `npm --prefix server test -- rules`
Expected: FAIL。

- [ ] **Step 4: 实现解析与规则取值**

`rules.ts` 增 `ModelRulesPromptGuidance` 接口与解析校验；两个规则文件填写五键取值。取值依据：`src:Jb6wdU3X3ocpzdxEgLhctgtNnkh:seedance_rule:011`（维度差异）、`src:YcFddglYToIItoxnK3mcXXctnJb:prompt_technique:010`「30 秒长视频：用阶段与结束状态组织事件」、`src:YcFddglYToIItoxnK3mcXXctnJb:prompt_technique:007`「声音与文字的特殊字符约定」、`src:RpJHdwWB5onT8qx5fWqcw6Qnn9c:prompt_technique:013`「语言与特殊字符规范」、`src:Jb6wdU3X3ocpzdxEgLhctgtNnkh:seedance_rule:009`「官方约束词写法与使用限制」，以及 `docs/model-rules-notes.md` §2.4。

- [ ] **Step 5: 修订 Skill 边界句**

按 Interfaces 的边界修订改写 `skills/shot-prompting/SKILL.md`（含「本 Skill 只调用五个 MCP 工具」所在段落与「边界」小节），并同步 `docs/architecture.md` §9.6 / §11.4。

- [ ] **Step 6: 运行并确认通过**

Run: `npm --prefix server test -- rules skills_contract`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add server/src/rules.ts server/tests/rules.test.ts rules/models/seedance-2.0.json rules/models/seedance-2.5.json skills/shot-prompting/SKILL.md docs/architecture.md docs/model-rules-notes.md
git commit -m "feat: add per model prompt guidance with staging threshold"
```

### Task B4: 事件脚本化与长镜头阶段化（Skill，引用 B3）

**Files:**
- Modify: `skills/shot-prompting/SKILL.md`
- Modify: `docs/architecture.md`（§9.6）
- Test: `server/tests/skills_contract.test.ts`（新增内容契约 describe）

**Interfaces:**
- Produces: `shot-prompting` 写作规则——单镜头 `action` 按「开始时 → 随后 → 结束时」组织；阶段化时每阶段一个主要状态变化并写明可观察结束状态；时长超过目标模型 `prompt_guidance.long_shot_staging_threshold_sec` 的镜头必须阶段化；数字时间段只在原文或用户已给出时使用；不为填满时长新增动作、台词或事件。Skill 内不出现具体秒数阈值。
- Produces: 内容契约测试（新增 `describe("shot-prompting skill content contract")`）：断言 `skills/shot-prompting/SKILL.md` 含小节标题「## 事件脚本化」、含字符串 `prompt_guidance.long_shot_staging_threshold_sec`、且全文不匹配正则 `/15\s*秒|30\s*秒/`。

- [ ] **Step 1: 更新设计文档接口**

`docs/architecture.md` §9.6 补「长镜头按目标模型 `prompt_guidance.long_shot_staging_threshold_sec` 阶段化，Skill 不写数值；`shot_split.multi_action_rule` 管边界，Skill 管写法」。

- [ ] **Step 2: 写失败的内容契约测试**

```text
test("shot prompting skill documents staged event scripting without hardcoded thresholds")
```

Run: `npm --prefix server test -- skills_contract`
Expected: FAIL（`## 事件脚本化` 尚不存在）。

- [ ] **Step 3: 写 Skill 规则**

在 `skills/shot-prompting/SKILL.md` 新增 `## 事件脚本化` 小节：通用组织规则（开始时 / 随后 / 结束时）、阶段化写法（每阶段一个状态变化 + 可观察结束状态）、阈值引用（`prompt_guidance.long_shot_staging_threshold_sec`）、数字时间段限制、不凑时长；附一个不含具体秒数的阶段化正例。

- [ ] **Step 4: 运行并确认通过**

Run: `npm --prefix server test -- skills_contract`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add skills/shot-prompting/SKILL.md server/tests/skills_contract.test.ts docs/architecture.md
git commit -m "docs: add staged event scripting rules to shot prompting skill"
```

### Task B5: 负面约束策略与渲染前自检清单（Skill，引用 B3）

**Files:**
- Modify: `skills/shot-prompting/SKILL.md`
- Modify: `docs/architecture.md`（§9.6）
- Test: `server/tests/skills_contract.test.ts`（扩展内容契约）

**Interfaces:**
- Produces: `shot-prompting` 的两组规则——负面约束策略（通用原则：不自动添加用户未要求的画质包、稳定包、水印、Logo、字幕、分身；无依据写空数组；模型化的措辞与限制按 `prompt_guidance.negative`）；渲染前自检清单（8 项：台词与 `dialogue_units` 一致且不扩写；无对白镜头自然闭口；`shot_size` / `camera_*` / `duration` 与 shot_plan 一致；`subject` / `setting` / `emotion` 与 script_analysis 一致；`continuity.previous_shot` 与状态字段衔接；声音只取已有线索；负面约束逐条有依据；超阈值长镜头已阶段化且未用数字时间段）。
- Produces: 内容契约测试扩展——断言 Skill 含「## 负面约束策略」「## 渲染前自检」、含 `prompt_guidance.negative`、含「不替代 `validate_prompt`」表述（明确自检是 LLM 语义核对，确定性校验由工具承担）。

- [ ] **Step 1: 更新设计文档接口**

`docs/architecture.md` §9.6 补「负面约束按 `prompt_guidance.negative` 与通用原则执行；渲染前完成语义自检，确定性校验由 `validate_prompt` 承担」。

- [ ] **Step 2: 扩展内容契约测试**

```text
test("shot prompting skill documents negative constraint policy and pre-render checklist")
```

Run: `npm --prefix server test -- skills_contract`
Expected: FAIL。

- [ ] **Step 3: 写 Skill 规则与清单**

在 `skills/shot-prompting/SKILL.md` 新增 `## 负面约束策略` 与 `## 渲染前自检` 两小节，内容按 Interfaces 撰写（自检清单 8 项逐条列出）。

- [ ] **Step 4: 运行并确认通过**

Run: `npm --prefix server test -- skills_contract`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add skills/shot-prompting/SKILL.md server/tests/skills_contract.test.ts docs/architecture.md
git commit -m "docs: add negative constraint policy and pre-render checklist"
```

---

## Part C：I3 知识沉淀与收尾

### Task C1: 知识卡草稿与同步（需要用户参与）

**Files:**
- Create: `docs/knowledge-draft-2026-10-22-prompt-craft.md`

**Interfaces:**
- Consumes: `skills/knowledge-sync/references/card-authoring.md` 的卡片写法与引用展开约定。
- Produces: 7 张卡片草稿（建议分类）：台词语法与语言规则（`prompt_technique`，2.0 / 2.5 分卡）、情绪可观察化（`prompt_technique`）、事件脚本与 30 秒阶段化（`prompt_technique`，2.5）、声音符号与保留 / 不采用写法（`prompt_technique`，2.5）、负面约束策略（`seedance_rule`）、空间与站位描述（`prompt_technique`）。每张含 title、category、`target_models`、content（含来源与检索日期）、tags。

- [ ] **Step 1: 写卡片草稿**

按 `card-authoring.md` 结构写 `docs/knowledge-draft-2026-10-22-prompt-craft.md`：只吸收方法论并改写，不逐字搬运外部技能文本；来源标注火山方舟技能源与本地卡片 id。

- [ ] **Step 2: 用户录入原始库（插件不写原始库）**

由用户把草稿录入原始库 `通用知识/提示词技巧/` 与 `通用知识/Seedance/` 对应文档；插件与 MCP 工具只读。

- [ ] **Step 3: 首次同步走扫描模式（先预览后执行）**

运行 `$knowledge-sync`（不指定文档）：按扫描模式的整批 dry-run 清单核对 `to_add`（应包含本次新文档）与 warnings，用户确认后执行整批写入；记录每个文档的 `card_count` 与 SyncState。**不使用指定文档模式做首次同步**——该模式要求文档已有 SyncState 记录，且用户请求即视为确认、不产出整批清单。

- [ ] **Step 4: 刷新本地索引**

调用 `refresh_local_index`，先 `dry_run: true` 预览与 SyncState 比对的变化清单，确认后用 `dry_run: false` 执行同一刷新（本地 cache/index 为 AI 库的派生临时数据）。

- [ ] **Step 5: 校验检索命中（可核对断言）**

调用 `search_knowledge`（关键词：台词语言、阶段化、情绪可观察化）确认新卡可检索；`load_knowledge_pack` 卡片总数增量与本次写入一致——断言写清：本次涉及 N 个原始文档、合计替换新增 X 张卡，并逐文档记录 `card_count`。检索不到时停止并回报，不伪造。

- [ ] **Step 6: Commit**

```bash
git add docs/knowledge-draft-2026-10-22-prompt-craft.md
git commit -m "docs: add prompt craft knowledge card draft"
```

### Task C2: 全量回归与文档收尾

**Files:**
- Modify: `docs/sd25-pe-optimization-plan-2026-10-22.md`（状态）
- Modify: `docs/script2shot-pilot-notes.md`（追加回归记录）

**Interfaces:**
- Consumes: Part A / B / C1 的全部改动。
- Produces: 一次全量回归结论，与「已跑 / 未跑 / 风险」清单。

- [ ] **Step 1: 全量测试**

Run: `npm --prefix server test`
Expected: PASS。
若构建阶段报 `Access is denied`（`server/dist/server.mjs` 被占用，常见于本机有 script2shot MCP 常驻进程）：先关闭占用进程后重跑；仍无法构建时，改为运行 `npm --prefix server exec -- vitest run --root server` 验证用例部分（`--root server` 让 vitest 缓存落在 `server/node_modules/`，避免在仓库根生成 `node_modules/.vite` 未跟踪目录），并在交付说明中明确「构建步骤未验证」，不得声称全量通过。

- [ ] **Step 2: 类型检查**

Run: `npm --prefix server run typecheck`
Expected: PASS。

- [ ] **Step 3: 双模型 golden 人工核对**

逐份核对 `tests/fixtures/prompts/seedance-2.0.golden.md` 与 `seedance-2.5.golden.md`：景别行、对白行（含空对白占位与语言 / delivery 省略路径）、情绪、声音（含省略路径）、时间中文化均符合各节冻结口径。

- [ ] **Step 4: 真机演练回归（条件执行）**

若 `.script2shot/drill-4d-3/` 驱动资产仍在，按 `docs/script2shot-pilot-notes.md` 的请求序列重跑 12 步演练并核对七个产物；否则在 `docs/script2shot-pilot-notes.md` 追加「I1–I3 回归未实跑」及原因。

- [ ] **Step 5: 文档收尾**

把 `docs/sd25-pe-optimization-plan-2026-10-22.md` 状态从「提案（Proposed）」改为「已采纳（Accepted）」，并注明「执行计划为本文件；I4 为已采纳方向、待各自计划裁决」；在 `docs/script2shot-pilot-notes.md` 追加本轮回归记录（测试命令、结果、未验证项）。

- [ ] **Step 6: Commit**

```bash
git add docs/sd25-pe-optimization-plan-2026-10-22.md docs/script2shot-pilot-notes.md
git commit -m "docs: record skill iteration regression results"
```

---

## Part D：I4（已采纳，后续批次，不在本计划执行范围）

I4 四项均涉及新子系统或与现有边界的冲突，需要先做架构裁决，再各立实施计划（本文件只登记拆分方式与前置裁决，不写实现步骤）。

| I4 项 | 前置裁决问题 | 裁决后产出 | 后续计划 |
| --- | --- | --- | --- |
| 跨产物语义校验 | 扩展 `validate_prompt` 签名（读 `script_analysis.json` / `shot_plan.json`）还是新增独立工具；错误码与调用方 | `docs/architecture.md` §9.6、§13 更新 | `2026-XX-XX-script2shot-cross-artifact-validation.md` |
| 多模态参考绑定 | 素材从哪条通道进入（会话附件 / 路径）；`run.json`、PromptIR `references[]` 字段与渲染模板；2.0 / 2.5 素材差异 | `docs/architecture.md` §11 新小节 + 规则文件字段 | `2026-XX-XX-script2shot-multimodal-references.md` |
| 任务路由（编辑 / 延长） | 是否进入插件范围；2.5 编辑 / 延长 `ratio` 仅 `adaptive` 与现规则冲突的处理 | `docs/architecture.md` §1.1、§11.4 更新 | 随多模态计划或独立计划 |
| 素材规格上限进规则 | 依赖「多模态参考绑定」裁决；上限值（图 30 / 视频 10 段 ≤30 秒 / 音频 10 段 ≤30 秒 / 合计 50）需官方文档复核 | `docs/model-rules-notes.md` + `rules/models/*.json` | 随多模态计划 |

裁决顺序建议：多模态参考绑定 → 素材规格上限 → 跨产物语义校验 → 任务路由。每份后续计划沿用本文件的 Task 结构（Files / Interfaces / 测试步骤 / Commit）。
