# 短剧多镜头视频提示词实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 两个 Seedance 模型均按视频输出五模块提示词，允许视频内快节奏切镜，优先覆盖完整过程，2.5 强制秒数，并为仅剧本输入生成完整参考图占位。

**Architecture:** 保留现有三个创作阶段，在规划中增加 process → clip → shot 层级。先独立实现并测试 v2 校验能力，再将运行时 schema、消费者与渲染原子切换，最后同步 Skill 和完整演练，避免中间步骤因新旧结构混杂而无法验证。

**Tech Stack:** 沿用 TypeScript、Node.js、本地 MCP、Ajv、Vitest；不增加生产依赖。

**Spec:** `docs/superpowers/specs/2026-10-26-shortdrama-video-prompts-design.md`

状态：已实施。v2 代码、schema、规则、Skill、文档与测试已同步。

## 全局约束

- 面向人的文档与最终提示词用中文；代码、标识符和路径用英文。
- 不增加生产依赖，不改变 TypeScript、本地 MCP、Skill 创作的职责分工，不新增创作阶段。
- 保留现有七个运行文件名和三个 stage key。
- 对 `run.json`、`script_analysis.json`、`shot_plan.json`、`prompts.ir.json` 一起引入 `schema_version: 2`。
- 旧文件缺失版本按 legacy v1 识别；拒绝续跑且不改写旧 run，不自动迁移。
- 内部镜头使用正数秒区间，可以包含小数秒；模型最小生成时长不作用于内部镜头。
- 时间比较使用 `0.001` 秒容差，属于插件计算约定。
- 台词逐字保真，不补剧情、台词、声音，不为凑时长增加事件。
- 五模块名称和顺序按设计固定；Seedance 2.5 每条事件描述必须具有秒数区间。
- 本轮不进行远端知识库写入、素材上传或实际视频生成。

## 重点风险与对应验收

1. 内部镜头短于模型生成下限或同一动作跨切镜：应通过，不把来源引用重复当作剧情重复；任务 3。
2. 台词跨反应镜头或因超长跨视频：完整文字仅消费一次，分片精确拼回原文；任务 3、4、5。
3. 人工只改上游文字/素材职责，ID 和时间不变：内容指纹仍使旧下游待重跑；任务 1、4、5。
4. 同一角色/实景反复出现：资产 ID 复用、本段标签自洽，每种必要实体各有图槽；任务 2、4。
5. 过程过短/过长或参考图超限：合理停留/拆分仍不可满足时报告，不添事件、漏实体、强行拼接无关过程；任务 3、6。

## 任务 1：冻结设计并实现独立版本/内容指纹工具

**文件：**

- 修改：`docs/architecture.md` §9、§11、§13；`references/stage-conventions.md`；`README.md`，注明 v2 切换范围和实施状态。
- 新建：`server/src/artifact_version.ts`、`server/src/artifact_hash.ts`。
- 新建测试：`server/tests/artifact_version.test.ts`、`server/tests/artifact_hash.test.ts`。
- 新建：`tests/fixtures/shortdrama/` 中 v2 解析、规划、PromptIR 的基础样例；此时不替换旧运行时 schema 或旧 fixture。

**接口：**

- `check_artifact_version(value: unknown): { ok: true } | { ok: false; code: "ARTIFACT_VERSION_UNSUPPORTED"; found_version: unknown }`：仅数值 2 通过。
- `hash_artifact_document(value: unknown): string`：递归排序对象键、保留数组顺序，JSON 编码后用 Node 内置 SHA-256 生成十六进制指纹。`hash_run_context(run: unknown): string` 仅散列 input_mode/project_id/target_model/aspect_ratio/input_references/display_timeline，不包含 stages/warnings。
- v2 字段按设计 §4 冻结；`ArtifactSemanticError` 统一使用 `{ path: string, code: string, message: string, clip_id?: string, shot_id?: string }`。

- [x] 先同步权威设计与阶段约定；旧优化文档注明本轮替代的单镜头/时间轴口径。
- [x] 写失败测试：缺版本、1、字符串、未来版本拒绝，数值 2 通过；对象键重排指纹不变，动作文字、实体描述、素材职责或数组顺序改变时指纹变化；run 状态更新不影响输入指纹，输入素材职责/秒数偏好改变时影响。
- [x] 运行新测试确认失败，再实现两个纯函数；不接入运行时、不改变旧文件，不增加散列依赖。
- [x] 运行 `npm run typecheck` 和 `node node_modules/vitest/vitest.mjs run tests/artifact_version.test.ts tests/artifact_hash.test.ts`，预期全部通过。
- [x] 提交建议：`feat: prepare video prompt version and content hashes`。

## 任务 2：实体、参考图占位与过程来源校验

**文件：**

- 新建：`server/src/artifact_semantics.ts`、`server/tests/artifact_semantics.test.ts`。
- 修改：`tests/fixtures/shortdrama/` 的解析样例，补仅剧本、两角色对话、道具交接。
- 不接入旧阶段校验器；Skill 的实际切换统一在任务 6。

**接口：**

- `validate_script_analysis_semantics(document: unknown): ArtifactSemanticError[]` 检查设计中的 v2 解析产物。
- 解析新增 `entities[]`、`reference_assets[]`、每场 `processes[]`；`processes` 替代旧 `shot_group_suggestions`，镜头直接引用动作/情绪/对白单元。
- `reference_assets` 明确 media_type、placeholder/provided、entity_ids、source、adopt/exclude；provided 有输入来源，placeholder 不伪造 source。

- [x] 写失败测试：两角色、一场景、两关键道具至少五个独立 image 占位；同实体跨场次 ID 复用；无关键道具不硬造一个。
- [x] 写失败测试：悬空实体/来源、遗漏应表现单元、缺实体图槽、placeholder 伪造路径被拒绝；未明确外观保持待补充。
- [x] 实现纯语义检查：来源单元归入过程，资产/实体 ID 唯一且可解析；实际素材缺失不等同硬失败。
- [x] 运行 `node node_modules/vitest/vitest.mjs run tests/artifact_semantics.test.ts`，预期全部通过；旧 schema/消费者仍保持原状。
- [x] 提交建议：`feat: validate processes and reference placeholders`。

## 任务 3：视频时间轴、来源覆盖与对白分片校验

**文件：**

- 修改：`server/src/artifact_semantics.ts`、`server/tests/artifact_semantics.test.ts`。
- 修改：`tests/fixtures/shortdrama/` 的规划样例；模型规则使用测试内输入，运行时规则到任务 5 原子更新。

**接口：**

- 定义 `SemanticModelRules = { duration: { min_sec: number, max_sec: number }, reference_limits: { max_images: number }, timeline: { required_in_prompt: boolean } }`。
- `validate_shot_plan_semantics(plan: unknown, rules: SemanticModelRules, analysis?: unknown): ArtifactSemanticError[]`；单产物检查时间轴/ID，传 analysis 时检查实体、过程及来源覆盖。
- clip 总长为整数秒，内部镜头 start/end 可为小数秒。来源按集合检查，不根据同 action ID 的引用次数拒绝切镜。
- `dialogue[]` 使用 segment/unit ID、说话人、UTF-16 半开 offset 和视频内时间区间。默认整条台词一个 segment；跨视频分片需顺序精确覆盖原文一次，不能切断代理对。
- clip 的 audio 三轨使用设计中的 AudioCue（cue_id/text/start_sec/end_sec/source_refs），持续声音和瞬时音效都有明确区间；来源项 kind 为 scene/unit/knowledge，必须可解析。

- [x] 写失败测试：十秒过程含 2/3/3/2 秒四镜头，在两个模型均通过；同一动作跨两个镜头引用合法；总长/区间倒序、空洞、重叠、越界和重复 shot ID 被拒绝。
- [x] 写失败测试：小数秒镜头在 `0.001` 容差内通过；同一 20 秒过程在 2.5 一段合法，在 2.0 必须拆分；36 秒过程在 2.5 拆为合法两段，过程和状态承接不丢失。
- [x] 写失败测试：原文台词跨三个视觉镜头只分配一次；长台词按句界跨视频后 offsets 连续，拼接逐字相等；漏字、重字、换说话人、代理对中切分被拒绝。
- [x] 写失败测试：门响在切镜后的具体区间，环境声全程覆盖，声音区间越界/来源悬空被拒绝；与对白/视觉轨重叠不误报。
- [x] 写失败测试：两秒动作加对原有结束状态的合理停留可达到视频下限；超限且无法自然拆分、短尾/独立过程无法自然满足、必需参考图超限均有可定位问题，不添剧情解决。
- [x] 实现时间轴、集合覆盖、对白片段与上限检查，错误码使用 `TIMELINE_INVALID`、`SOURCE_COVERAGE_INVALID`、`REFERENCE_LIMIT_EXCEEDED`；自然语速、句界、停留和事件重复仍需语义审查。
- [x] 运行 `node node_modules/vitest/vitest.mjs run tests/artifact_semantics.test.ts`，预期全部通过。
- [x] 提交建议：`feat: validate multi-shot clip timelines and dialogue segments`。

## 任务 4：视频 PromptIR、素材绑定与跨产物检查

**文件：**

- 修改：`server/src/artifact_semantics.ts`、`server/tests/artifact_semantics.test.ts`。
- 修改：`tests/fixtures/shortdrama/` 的 PromptIR 样例。

**接口：**

- `validate_prompt_semantics(prompt: unknown, rules: SemanticModelRules, plan?: unknown, analysis?: unknown): ArtifactSemanticError[]`。
- `validate_run_artifact_links({ run, script_analysis, shot_plan, prompt_ir }): ArtifactSemanticError[]`：核对身份、结构对应及 input_hashes，包括当前 run 输入指纹；模型数值检查由前述函数完成。
- 解析保存 `input_hashes.run_context`；plan 保存 `input_hashes.script_analysis`；PromptIR 保存 `input_hashes: { script_analysis, shot_plan }`。使用任务 1 散列函数，不让 LLM 自行计算。
- 绑定显式含 media_type；每种媒体独立连续编号，正文标签与本段绑定唯一对应；同素材跨视频 asset ID 稳定。
- `run.display_timeline?: boolean` 表示偏好；PromptIR 必填 `display_timeline: boolean` 为最终结果。2.0 默认 false、用户指定可 true，2.5 必须 true。

- [x] 写失败测试：同角色跨视频复用 asset ID、本地标签变化时正文同步；错媒体标签、漏实体、虚构素材、重复 tag、超图片上限被拒绝。
- [x] 写失败测试：仅改上游 action 文字、实体说明或素材 adopt/exclude，保持全部 ID/时间不变，旧 input_hashes 仍触发失配；只改对象键顺序不触发。
- [x] 写失败测试：仅改 run.input_references 的职责或 display_timeline，解析及下游均失效；只更新 stages/warnings 不失效。
- [x] 写失败测试：规划与 PromptIR 的 clip/shot 顺序、时长、来源、对白片段和参考职责不一致时被拒绝；台词分片文本等于原文 slice。
- [x] 写失败测试：2.5 的 display_timeline=false 被拒绝；2.0 两种显示偏好均可，默认无秒数。
- [x] 实现纯检查函数；同动作多镜头引用保持合法，台词片段精确一次，不把语义判断伪装为机械保证。
- [x] 运行 `node node_modules/vitest/vitest.mjs run tests/artifact_semantics.test.ts tests/artifact_hash.test.ts`，预期全部通过。
- [x] 提交建议：`feat: validate video prompt bindings and upstream links`。

## 任务 5：原子切换运行时契约、消费者与五模块渲染

此任务是一次完整结构切换。schema、基础校验遍历、渲染、聚合和旧测试不能拆开提交，不能暂时跳过回归获得绿灯。它依赖任务 1–4 已独立测试的函数，减少切换时的新逻辑。

**文件：**

- 修改四个运行 schema：`schemas/run.schema.json`、`script_analysis.schema.json`、`shot_plan.schema.json`、`prompt_ir.schema.json`。
- 修改：`server/src/schemas.ts`、`server/src/rules.ts`、`server/src/tools/init_run.ts`、`read_run.ts`、`update_run_state.ts`、`validate_stage_artifact.ts`、`validate_prompt.ts`、`render_prompt.ts`、`server/src/aggregate.ts`、`server/src/index.ts`。
- 修改两个 `rules/models/*.json` 和 `docs/model-rules-notes.md`。
- 修改相关 schema/PromptIR/规则/运行/渲染/聚合/MCP 测试及旧 fixtures；保留专用 legacy 反例。

**接口：**

- 所有新产物携带 schema_version=2；read_run 在对账及任何写回前检查版本，legacy/混合/未来版本返回 `ARTIFACT_VERSION_UNSUPPORTED` 且不改旧文件。
- `validate_stage_artifact` 增加可选 `script_analysis_path`，成功结果返回 `content_hash`；`init_run`/`read_run` 返回 `run_context_hash`；`validate_prompt`/`render_prompt` 增加可选 `shot_plan_path`、`script_analysis_path`。主流程必须传上游，独立工具仍可只检查自身。
- Prompt 错误形状为 `{ clip_id, shot_id, field, code, message }`，无归属时对应 ID 为空字符串；版本/来源/时间错误码如实保留。
- `read_run` 对 v2 调用链接校验；上游指纹改变使下游待重跑，不继续显示 done，保留现有产物供检查。
- 模型规则增加 reference_limits.max_images（2.0=9、2.5=30）及 timeline.required_in_prompt（2.0=false、2.5=true），硬边界来源日期见设计 §10；duration 作用于 clip。
- render 使用 `clip_heading` 与五个 key：generation_goal、reference_duties、subjects_relations、event_script、consistency。单次读取快照验证后渲染，失败不创建或覆盖输出。
- `KnowledgeRefEntry` 增加 `clip_id: string|null`，逐镜头引用保留 shot_id，视频共用引用可为 null；按视频/镜头顺序聚合，同阶段重跑整体替换。

- [x] 写失败测试：v2 schema 接受基础新样例，legacy run 无改写地拒绝；有效 v2 run 在新消费者上可校验、渲染、聚合。
- [x] 写两模型失败 golden：两个视频各含多镜头，正文恰好五模块；十秒四镜头只生成一份提示词；2.5 每条事件/对白带秒数，2.0 默认顺序叙事，用户开启后显示秒数。
- [x] 写失败测试：对白跨镜头只输出一次、分片可还原原文；现有台词含 duration 等词仍保真豁免；景别中文化、声音符号、空值语义、无依据不补写均保留。
- [x] 写失败 golden：2.5 的门响 cue 和全程环境声均显示各自秒数，能看出音效发生在切镜前后；2.0 开启/关闭秒数均保留声音归属。
- [x] 将 schema、模型规则、工具实现、MCP 广告 schema、引用聚合与 fixtures 一起切换到 v2，接入任务 1–4 的检查；移除旧 document.shots/scene.shots 遍历与逐镜头生成下限。
- [x] 接入单次读取快照的内容指纹和跨产物核对；旧下游结构合法但内容陈旧时正确失效。
- [x] 运行 `npm run typecheck`、`npm test`，预期全量通过；检查两份 golden 可读且逐字节稳定。当前构建写入拒绝若仍存在先定位，不跳过后声称全量通过。
- [x] 提交建议：`feat: switch runtime to versioned multi-shot video prompts`。

## 任务 6：同步三个创作 Skill、入口与短剧验收

**文件：**

- 修改：`skills/script2shot/SKILL.md`、`skills/script-breakdown/SKILL.md`、`skills/shot-planning/SKILL.md`、`skills/shot-prompting/SKILL.md`。
- 修改：`references/stage-conventions.md`、`README.md`、`server/README.md`、权威架构和本轮验收记录。
- 测试：`server/tests/skills_contract.test.ts`、`server/tests/e2e.test.ts`、`server/tests/run_tools.test.ts`、`server/tests/aggregate.test.ts`。

**接口：**

- 入口可收集 input_references 和 display_timeline；无实际素材不追问图片阻断流程，转为 image 占位和 warnings。
- 解析产出过程、实体、道具和素材槽，并保存 run_context_hash；规划读取成功校验返回的 content_hash，保存 input_hashes，同时给有依据的声音安排 cue 区间；提示词阶段复制规划决策和上游指纹，不擅自修改计划。
- 规划顺序为完整过程 → 对白/动作时间 → 内部切镜 → 上限检查 → 必要拆段。普通信息/反应镜头约 1–3 秒为软初值，爆点/对白按内容调整，不硬套固定秒数或镜头数。
- 检索按 clip 组织共享上下文，必要时逐镜头补充；保留现有来源预算原则，避免多镜头重复装载同卡。用户本轮结构/秒数要求优先于冲突旧经验卡，不写远端库。
- 本阶段错误最多两轮定点修复；根因在上游时回退对应阶段。完成交付分别报告视频数和内部镜头数。

- [x] 写失败契约测试：Skill 中没有单镜头=单视频、2.5禁止自建秒数等冲突规则；四个 Skill 均引用新契约、素材占位和来源/指纹交接。
- [x] 更新 Skill 内容及示例；五模块包含旧有台词/情绪/声音/风格/连续性信息；实际图片未提供时明确待提供，不能虚称已绑定。
- [x] 写并运行集成回归：仅剧本、完整过程多镜头、20秒/36秒过程拆分、两秒过程自然停留、长台词自然分片、参考超限、from/only及人工只改文字后的续跑；两个模型都覆盖。
- [x] 运行 `npm run typecheck`、`npm test`；若任务 5 后没有新实现变化，不无谓重复全量测试，只执行本任务受影响的契约/e2e测试。记录实际命令和结果。
- [x] 对三个真实短剧片段演练：对话反应、动作/道具过程、超长过程。人工核对叙事密度、自然语速、切镜动机、过程完整性、拆分衔接和全部图槽；结构化 fixture 通过不代替这项演练。
- [x] 独立整体验收 schema/规则/文档/Skill 一致性，逐项覆盖用户要求。实际视频效果未生成则明确注明；更新插件版本时同步 `plugin.json`、`server/package.json`/lock，发布安装另按用户授权执行。
- [x] 提交建议：`feat: adopt shortdrama video prompt workflow in skills`。

## 依赖与交付判断

顺序：1 → 2 → 3 → 4 → 5 → 6。文档/fixture 只读审阅可以并行；共享语义模块与运行时切换按顺序实施，避免多人同时改同一接口。任务 1–4 是独立纯函数与样例，不提前替换生产 schema；任务 5 对所有必需消费者做一次原子切换。

交付必要条件：两个模型同一视频层级；完整过程不因切镜拆为多个提示词；总时长与内部时间轴各自正确；仅剧本参考图占位覆盖角色/场景/关键道具；2.5 秒数不可缺；五模块、原文保真和续跑行为通过回归。旧实现的 97 项通过不能代替新需求验收。
