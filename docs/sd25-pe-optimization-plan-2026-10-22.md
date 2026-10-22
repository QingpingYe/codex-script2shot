# 借鉴 sd25-pe 的提示词链路优化迭代方案（2026-10-22）

状态：提案（Proposed，未落地）
日期：2026-10-22
参照技能：`sd25-pe`（Seedance 2.5 Prompt Optimizer，火山方舟
`arkdocs.tos-cn-beijing.volces.com/skills/` 技能源，v0.1.1，2026-10-22 装入
`.agents/skills/sd25-pe/`）
现状基线：`docs/architecture.md`、`references/stage-conventions.md`、
`skills/{script2shot,script-breakdown,shot-planning,shot-prompting}/SKILL.md`、
`rules/models/*.json`、`schemas/prompt_ir.schema.json`、
`server/src/tools/{render_prompt,validate_prompt,rules}.ts`、
`tests/fixtures/prompts/*`、`docs/model-rules-notes.md`、`docs/script2shot-pilot-notes.md`

## 0. 前提与约束

- 本方案覆盖 script2shot 插件**同时支持 Seedance 2.0 与 Seedance 2.5** 的事实：
  所有改动按「模型无关的 PromptIR + 模型参数化渲染」分层，2.0 / 2.5 的能力差异
  只进 `rules/models/*.json`。
- 文档优先：每项改动先更新对应设计文档（`docs/architecture.md`、
  `docs/model-rules-notes.md`），再改 schema、规则文件、Skill、工具和测试，
  在同一次改动内完成（`AGENTS.md` §2、§3）。
- 外部事实（模型对台词 / 声音的支持、素材上限等）必须核对官方文档后写入
  `docs/model-rules-notes.md`，带来源与核对日期；未核实前不写入规则文件。
- 本方案是提案：不引入新生产依赖，不替项目选定新组件；落地前由控制方按现状
  设计流程裁决。

## 1. 结论摘要

1. sd25-pe 的工艺可以概括为「四本账 + 一套自检」：故事合同（事实边界）、
   素材／主体映射（一致性）、对白账本（声音通道）、事件脚本（可拍结构），
   以及输出前的最终自检与净化。script2shot 在「故事合同」和「净化」上已经同构，
   但「对白账本」与「事件脚本」在第三阶段断档。
2. 具体断档有三处：`script_analysis.json` 的 `dialogue_units` / `emotion_units`
   没有进入 PromptIR；`shot_plan.json` 的 `shot_size`（景别）没有进入 PromptIR；
   渲染正文出现英文时间词（如 `时间：night`），与「提示词正文统一使用中文」
   的既有设计不一致。
3. 校验层只有结构 + 范围 + 禁词（`validate_prompt`），缺少 sd25-pe 式的
   语义自检清单（台词是否扩写、说话人是否在场景内、连续性是否衔接等）。
4. 以上三类优化全部对 2.0 / 2.5 同时生效；涉及声音 / 台词的渲染开关由
   规则文件按模型控制（2.0 支持性需先按官方文档核实）。

## 2. sd25-pe 工艺拆解与对照

| # | 工艺域 | sd25-pe 做法要点 | script2shot 现状 | 判断 |
| --- | --- | --- | --- | --- |
| 1 | 故事合同与事实边界 | 锁定主体、数量、因果、空间、道具归属与结局；素材只补可直接观察的属性 | `script-breakdown` 保持原文边界、不新增剧情；缺失信息进 `missing_info`；检索结果不得补写剧情 | 已对齐 |
| 2 | 素材职责与主体映射 | 逐份素材职责、未采用素材清单、一人一图、用户映射优先 | 纯文本管道无素材输入；对应物是角色一致性（`character_bible` 卡片 + 逐镜头 `subject` 文本） | 可映射，前瞻（I4） |
| 3 | 对白账本 | 逐段记录说话人、台词原文、音频职责、语言、画内外位置；只给意图时不编台词 | 上游 `dialogue_units`（`speaker` / `text` / `visual_action`）已产出；PromptIR 无字段、渲染无落点 | 缺口（P0） |
| 4 | 声音语法 | `()` 音乐、`<>` 音效、`{}` 台词、【】字幕；无对白时明确自然闭口 | 无声音通道；2.0 / 2.5 对台词与音频描述的支持差异未在规则文件沉淀 | 缺口（P1） |
| 5 | 情绪可观察化 | 触发事件 + 眼神／呼吸／姿态等可观察表现，不用抽象标签 | `emotion_units.tone` 已在解析产物；PromptIR 与渲染无情绪字段 | 缺口（P1） |
| 6 | 事件脚本与长视频阶段化 | 开始→主要事件→结束状态；每阶段一个主要状态变化；数字时间段只在用户给出时使用 | `shot_plan` 有 `enter_state` / `exit_state`；PromptIR 的 `action` 是单句，无阶段化写法指导；2.5 单镜头最长 30 秒 | 缺口（P1） |
| 7 | 参数分离 | 画幅、时长、分辨率、帧率不进 Prompt；编辑／延长自动锁定参数 | `forbidden` 词表拦截工程参数；时长与画幅只出现在文档分节标题 | 已对齐 |
| 8 | 负面约束策略 | 不自动添加画质包、稳定包、水印、Logo、字幕、分身 | `negative_prompt` 允许空数组；「无依据写空数组」已有；「不滥加」未明文 | 可借鉴（P1） |
| 9 | 输出净化 | 单一最佳版本；不输出分析过程；占位符必须替换 | `render_prompt` 逐字节确定性输出；无占位符机制 | 已对齐 |
| 10 | 最终自检 | 20+ 项输出前语义自检清单 | 结构 + 硬规则 + 最多 2 轮修复；无语义自检 | 可借鉴（P1） |
| 11 | 映射置信度与澄清 | 低置信度且影响核心结果时合并询问一次 | 无交互澄清；对应机制是 `missing_info` 与 warnings | 部分借鉴（见 I2.5） |
| 12 | 任务路由 | 生成／编辑／延长三类主任务，混合任务拆两步 | 只做文本到提示词生成；编辑 / 延长不在范围 | 不适用（边界已明确） |
| 13 | 素材规格预检 | 2.5：图片≤30、视频≤10 段且≤30 秒、音频≤10 段且≤30 秒、合计≤50 | 无素材输入 | 前瞻（I4） |
| 14 | 会话内自动升级 | 每次会话首次触发执行 `npx skills@latest update` | 插件走版本化发布 | 不采纳（见 §5） |

## 3. 优化迭代方案

### I1（P0）信息不断档：景别、时间中文化、台词通道

目标：让上游已经产出的信息不再在第三阶段丢失，并恢复「正文统一中文」的口径。

#### I1.1 PromptIR 增加 `shot_size` 并在渲染输出景别

- 问题：`shot_plan.json` 的 `shot_size` 是 9 值中文枚举，但
  `schemas/prompt_ir.schema.json` 没有该字段，渲染的「机位与运镜」节也没有景别；
  景别是 Seedance 基础提示词要素（sd25-pe 基础模板同样包含景别）。
- 变更：
  - `schemas/prompt_ir.schema.json`：新增 `shot_size` 字段，
    英文枚举与 `schemas/shot_plan.schema.json` 中文枚举一一对应
    （候选映射：大远景=extreme-long-shot、远景=long-shot、全景=full-shot、
    中全景=medium-full-shot、中景=medium-shot、中近景=medium-close-up、
    近景=close-shot、特写=close-up、插入镜头=insert-shot；
    冻结取值以设计裁决为准），映射表在 schema 描述、渲染层与测试三处对齐。
  - `server/src/tools/render_prompt.ts`：新增 `SHOT_SIZE_LABELS`；
    `camera` 节渲染改为「景别／机位／运镜」。
  - `rules/models/seedance-2.0.json`、`seedance-2.5.json`：
    `render.section_labels.camera` 文案同步（键不变）。
  - `skills/shot-prompting/SKILL.md`：输出表补字段与映射表。
  - 测试：`server/tests/render_prompt.test.ts` 的枚举对齐测试扩展到 `shot_size`；
    双模型 fixture 与 golden 更新。
- 双模型影响：无差异，字段通用。
- 验收：schema 正 / 反例各一；`prompt_ir` 与 `shot_plan` 枚举数量、顺序一致；
  两份 golden 含景别行。

#### I1.2 渲染层时间术语中文化

- 问题：`time` 是英文术语（如 `night`），渲染层原样输出，golden 出现
  `时间：night`，与 `docs/architecture.md` §11.3「最终渲染的提示词正文统一
  使用中文」不一致。
- 变更：`render_prompt.ts` 增加 `TIME_LABELS`（night→夜晚、day→白天、
  dawn→清晨、dusk→傍晚等常用词；未命中回退原样输出），与
  `CAMERA_ANGLE_LABELS` 同一模式；`docs/model-rules-notes.md` §4.3 记录裁决；
  golden 更新。
- 备选（不推荐）：把 `time` 改自由文本中文——影响 schema 描述与既有产物，
  且丢失可枚举性。
- 验收：golden 不再出现英文时间词；未收录词原样透传并有测试。

#### I1.3 台词通道 v1：`PromptIR.dialogue` + 渲染 + 校验

- 问题：`dialogue_units` 在上游完整产出，第三阶段完全丢失；Seedance 侧的
  台词描述能力（sd25-pe 的 `{}` 语法：语言 + 表达方式 + 说话人 + 台词原文）
  没有任何落点。
- 变更：
  - `schemas/prompt_ir.schema.json`：新增 `dialogue[]`，
    条目 `{ speaker, text, delivery? }`；`delivery` 仅在原文或知识卡有依据时填写。
  - `skills/shot-prompting/SKILL.md`：
    - `dialogue` 只允许取材 `script_analysis.json` 的 `dialogue_units`
      （`speaker` / `text`），不得扩写、不得换说话人、不得擅自补语言或口音；
    - 只有说话意图没有台词原文时，不编造对白，改写为可观察的口型、停顿与反应；
    - 无对白镜头显式表达「自然闭口、无旁白」。
  - `render_prompt.ts`：新增 `dialogue` 节，渲染 `角色名：{台词原文}`；
    `delivery` 有值时前置为括号说明。
  - `validate_prompt.ts`：`dialogue[].speaker` / `dialogue[].text` 非空校验
    （复用 `MISSING_FIELD`）。
  - 2.0 支持性核对：按官方文档核实 2.0 提示词是否支持台词描述；
    结果写入 `docs/model-rules-notes.md`（来源 + 日期）。核实前 2.0 规则
    按 I1.4 关闭该节。
- 验收：golden 覆盖「有台词镜头」「无台词镜头」两条路径；空 `text` 反例被拒；
  2.0 / 2.5 规则差异有测试覆盖。

#### I1.4 渲染节集合按模型可裁剪

- 背景：`render_prompt.ts` 当前要求 `render.section_order` 覆盖全部节 key，
  多 / 少节都按安装损坏处理（`RENDER_FAILED`）。为支持「2.0 关闭对白节」
  这类按模型裁剪，需要一次渲染契约调整。
- 变更：
  - `render_prompt.ts`：节 key 全集扩展（`shot_size` 并入 `camera` 节不新增 key；
    `dialogue` 为新增 key），`section_order` 允许子集，
    但必须覆盖该模型的必选节（新增规则字段或代码内置清单，二选一由实现裁决）；
  - `rules.ts`：`section_order` 校验从「覆盖全集」放宽为「子集 + 必选集」；
  - `docs/model-rules-notes.md` §4 与 `docs/architecture.md` §11.4 同步记录。
- 验收：子集合法 / 缺必选节非法的正反例；双模型 golden 各自稳定。

### I2（P1）语义完整：情绪、事件脚本、声音、负面约束策略、自检清单

#### I2.1 `PromptIR.emotion` 与情绪可观察化

- 字段：`emotion`（可选 string），取材 `emotion_units.tone`；
  Skill 规则要求改写为可观察表现（触发事件 + 眼神 / 呼吸 / 姿态），
  不用「少女感」「强势气质」类总结标签。
- 渲染：「主体与动作」节增加「情绪」子标签，空值省略。
- 验收：golden 覆盖有 / 无情绪两条路径；skill 文案有示例。

#### I2.2 事件脚本化（长镜头阶段化）

- v1 不改 schema：`shot-prompting` SKILL 增加写作规则——
  单镜头 `action` 按「开始时→随后→结束时」组织；
  2.5 且时长 >15 秒的镜头必须阶段化（每阶段一个主要状态变化 + 可观察结束状态）；
  数字时间段只在用户原文已给出时使用（与 `shot_split.multi_action_rule` 对齐）。
- 备选（本轮不做）：PromptIR 增加 `beats[]` 结构化字段；只有出现机器校验需求时再评估。
- 验收：skill 文案 + fixture 示例 + 演练记录。

#### I2.3 声音通道（audio）

- 字段：`audio`（结构待架构裁决，候选 `{ ambience[], sfx[], music? }`）；
  渲染语法 `<>`（音效）、`()`（音乐）；无依据留空，不编造。
- 与 I1.4 的节裁剪机制配套：2.0 / 2.5 支持情况分别由规则文件开关，
  依据取自官方文档（来源 + 日期）。
- 验收：双模型 golden；不支持该节的模型不输出该节。

#### I2.4 `negative_prompt` 策略明文化

- `shot-prompting` SKILL 与知识卡明确：不自动添加用户未要求的画质包、稳定包、
  水印、Logo、字幕、分身；无依据写空数组（已有）。
- 不采用词表强校验（误伤风险高）；如后续要做，先在规则文件里定义
  `negative_guidance` 并以候选清单形式实现。

#### I2.5 渲染前语义自检清单

- `shot-prompting` SKILL 增加「自检清单」小节（自 sd25-pe 最终自检裁剪：
  台词与 `dialogue_units` 一致且不扩写、无对白镜头自然闭口、
  `shot_size` / `camera_*` / `duration` 与 `shot_plan` 一致、
  `subject` / `setting` 与 `script_analysis` 一致、
  `continuity.previous_shot` 与状态字段衔接、
  情绪已可观察化、负面约束逐条有依据、2.5 长镜头已阶段化、
  无工程参数与模型名）。
- 说明：清单是 LLM 语义核对，不替代 `validate_prompt`；
  可确定化的项目在 I4 评估是否做成跨产物校验工具。
- 验收：清单项与 `validate_prompt` 覆盖边界在 skill 中写清，不重复实现。

### I3（P1）模型差异化与知识沉淀

#### I3.1 规则文件增加 per-model 提示词写作指导

- 例：2.5 `long_shot_staging`（>15 秒阶段化）、`dialogue_support`、`audio_support`；
  2.0 `single_event_per_prompt`、`split_rule`。
- 变更：`rules.ts` 解析与校验、`server/tests/rules.test.ts`、
  `docs/model-rules-notes.md`（逐值来源 + 核对日期）。
- 原则：硬规则（进 `validate_prompt` 的部分）与写作指导分离；
  写作指导只被 Skill 读取，不参与校验判定。

#### I3.2 把 sd25-pe 工艺沉淀为原始库知识卡

- 落点（目录与分类冲突时以卡片 `category` 优先）：`通用知识/提示词技巧/`
  （台词语法、情绪可观察化、事件脚本/阶段化、声音符号、空间与站位；均归
  `prompt_technique`）+ `通用知识/Seedance/`（负面约束策略；归 `seedance_rule`）。
- 2.5 专属内容不用目录区分，由卡片 `target_models` 表达；`content` 标注来源与检索日期
  （sd25-pe 技能源 URL；引用内容写法按 `card-authoring.md` 的「引用展开」约定）。
- 执行方式：走 `$knowledge-sync` 的 dry-run 清单 → 用户确认 → 写入 AI 库
  （外部写操作按 `AGENTS.md` §3）。
- 版权边界：只吸收方法论并改写，不逐字搬运外部技能文本；如需要原文引用，
  先确认授权。

### I4（P2，前瞻，不排期）

- 跨产物语义校验：让校验工具可见上游产物（`script_analysis.json`
  / `shot_plan.json`），或新增独立校验工具，把 I2.5 中可确定化的清单项
  变成硬校验。
- 多模态参考绑定：`references[]`、首帧 / 尾帧、多关键帧、宫格分镜、白模；
  涉及输入层与渲染引擎扩展，先做架构裁决。
- 素材规格上限（30 图 / 10 视频 / 10 音频 / 50 总量）进规则文件。
- 任务路由（视频编辑 / 延长）：与现有「只做生成」边界冲突，另行裁决。

## 4. 验证与落地顺序

建议顺序：I1.1 + I1.2（最小改动先合并）→ I1.3 + I1.4（台词通道）→
I2.1 → I2.2 → I2.5 → I2.3 → I2.4 → I3.1 → I3.2。

每个改动的固定动作：

1. 先改 `docs/architecture.md`（§11.3 PromptIR、§11.4 模型适配、§9.6 如涉及）
   与 `docs/model-rules-notes.md`；
2. schema、规则文件、Skill、工具、测试同批完成；
3. 双模型回归：`tests/fixtures/prompts/seedance-2.0.*` 与
   `seedance-2.5.*` 成对更新，`server/tests/{prompt_ir,render_prompt,
   validate_prompt,rules}.test.ts` 同步；
4. `skills_contract` 与端到端测试；需要时复用 `.script2shot/drill-4d-3/`
   驱动跑真机演练并更新 `docs/script2shot-pilot-notes.md` 记录；
5. 交付时说明改动、验证命令与结果、未验证项与风险（`AGENTS.md` §4）。

风险与回退：

- PromptIR 是冻结接口（`additionalProperties: false`）：本次为不兼容扩展，
  旧版插件会拒绝新产物、新版插件会拒绝缺字段的旧产物；
  已存在的 run 以「重跑 `only shot-prompting`」对齐新 schema，不需要迁移脚本。
  是否给 PromptIR 增加版本字段属架构裁决，本方案不预设。
- 逐字节 golden 快照（`.gitattributes` 固定 LF）对格式变化敏感：
  每批改动只动必要行，避免无关格式漂移。
- 2.0 台词 / 声音支持性未核实前，规则文件保持关闭状态，不阻塞 2.5 路径。

## 5. 借鉴边界（明确不采纳）

1. 会话内自动升级（`npx skills@latest update`）：外部代码随时替换不可控，
   插件继续走版本化发布。
2. 生成接口调用：与现有边界一致，插件只产出提示词，不提交生成任务。
3. 交互式澄清：script2shot 是无交互批处理链路，对应机制是
   `missing_info` 与 warnings；不新增打断式提问（入口「画幅缺失询问一次」
   的既有例外保持不变）。
4. 素材输入、多任务路由、首尾帧 / 宫格 / 白模模板：见 I4，不混入 I1–I3。

## 6. 附：改动面速查

| 迭代 | Skill | Schema | 规则文件 | Server 工具 | 测试 / Fixture | 设计文档 |
| --- | --- | --- | --- | --- | --- | --- |
| I1.1 景别 | shot-prompting | prompt_ir.schema.json | 两个模型 render 标签 | render_prompt.ts | 双模型 golden、render 测试 | architecture §11.3 |
| I1.2 时间中文化 | — | — | — | render_prompt.ts | 双模型 golden | model-rules-notes §4.3 |
| I1.3 台词 | shot-prompting | prompt_ir.schema.json | 2.0/2.5 节开关 | render_prompt.ts、validate_prompt.ts | 双模型 golden、validate 反例 | architecture §11.3/11.4 |
| I1.4 节裁剪 | shot-prompting | — | 两个模型 render | render_prompt.ts、rules.ts | rules 测试、golden | architecture §11.4、model-rules-notes §4 |
| I2.1 情绪 | shot-prompting | prompt_ir.schema.json | render 标签 | render_prompt.ts | 双模型 golden | architecture §11.3 |
| I2.2 事件脚本 | shot-prompting | —（备选 beats） | 写作指导 | — | fixture 示例 | architecture §9.6 |
| I2.3 声音 | shot-prompting | prompt_ir.schema.json | 支持开关 | render_prompt.ts、validate_prompt.ts | 双模型 golden | architecture §11.3/11.4 |
| I2.4 负向策略 | shot-prompting | — | 可选 negative_guidance | — | — | knowledge-base-raw 提示词技巧 |
| I2.5 自检清单 | shot-prompting | — | — | — | — | architecture §9.6 |
| I3.1 写作指导 | shot-planning / shot-prompting | — | prompt_guidance | rules.ts | rules 测试 | model-rules-notes |
| I3.2 知识卡 | knowledge-sync（执行） | — | — | — | 同步校验 | knowledge-base-raw |
