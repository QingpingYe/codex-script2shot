# 复查报告：技能迭代实施计划

复查对象：`docs/superpowers/plans/2026-10-22-script2shot-skill-iteration.md`。  
复查日期：2026-10-22。  
结论：方向合理，建议先修订再执行。计划保留了 PromptIR / 渲染 / 校验 / Skill 的既有边界，并把双模型 fixture 与 golden 作为主回归，这点是稳的。但当前版本有 4 个开工前应解决的高优先级问题，另有若干测试与接口细节需要收紧。

## 复查基线

- `npm --prefix server run typecheck`：通过。
- `npm --prefix server exec -- vitest run`：32 个测试文件通过；352 个用例通过，1 个跳过。
- `npm --prefix server test` 未能进入用例阶段：`esbuild` 写 `server/dist/server.mjs` 时返回 `Access is denied`，大概率是现有 MCP 进程或编辑器进程占用打包产物。这不是本轮计划发现的设计缺陷，但执行计划的 C3 步骤前应先关闭占用方或改用可验证的测试入口。
- 本报告不修改计划代码，只提出修订建议。

## P1：开工前应解决

### 1. Task C2 的同步流程与 `knowledge-sync` 契约冲突

计划第 433 行要求「指定文档同步（先预览后执行）」，并假设会返回整批 dry-run 清单。但现有 [knowledge-sync SKILL.md](/e:/codex-script2shot/skills/knowledge-sync/SKILL.md) 的指定文档模式有两点与该假设冲突：

1. 指定文档模式跳过扫描、`build_sync_plan` 与整批确认，用户请求本身即视为替换确认。
2. 指定文档模式要求文档已有 `SyncState` 记录。C2 是新草稿首次录入原始库，通常没有记录，直接使用指定模式大概率失败。

同时，计划要求符合 AGENTS.md 的外部写操作先预览再确认。当前写法只是复述了正确目标，但没有给出可执行的路径。

建议修订 C2：

- 明确先运行扫描模式或一个可产生 dry-run 清单的流程，让新文档进入 `SyncState`。
- 若保留「指定文档 + 预览」，先更新 `docs/architecture.md` §9.2 和 `skills/knowledge-sync/SKILL.md`，为指定文档模式定义预览/确认状态；不要让计划步骤依赖不存在的工具行为。
- 同步写入 AI 库后，本地索引不会自动具备新卡检索能力。Step 4 检索前应调用 `refresh_local_index`，并按现有入口约定先 dry-run 再执行本地派生数据刷新。

### 2. B3 把模型专属数值硬编码进 Skill，违反计划的 Global Constraints

计划第 310 行要求在 Skill 中写「Seedance 2.5 单镜头时长大于 15 秒时必须阶段化」。但计划全局约束明确说：Skill、产物与注释不复制时长数值；模型差异应落在规则文件。第 379 行的 `prompt_guidance` 才是计划中存放这类模型专属写作指导的位置。

这还带来顺序问题：B3 在 C1 之前执行，因此在 B3 阶段没有可引用的 `prompt_guidance`，只能先把 15 写进 Skill，C1 再改口径。

建议修订：

- 把「阶段化阈值」作为模型规则文件的非硬校验字段加入 `prompt_guidance`，例如 `shot_structure` 中描述；或新增 `long_shot_staging_threshold_sec`。
- 调整顺序为 C1 在 B3 之前，或把 B3 拆成两部分：先加通用事件脚本规则，模型阈值在 C1 后落地。
- Skill 文案改为「按目标模型 `prompt_guidance` 的长镜头阶段化指导」，不复制 15 或 30。

### 3. 台词不参与禁词扫描会削弱「最终提示词正文不得夹带工程配置」

A3 第 191 行明确 `dialogue` 不做禁止项扫描，理由是台词原文保真。这个理由成立，但当前 `docs/model-rules-notes.md` §2.3.2 说禁止项扫描的是最终渲染进提示词正文的文本。A3 新增 dialogue 后，最终正文确实会渲染台词；如果原文台词包含 `duration`、`seedance`、`fps` 等词，`validate_prompt` 会通过，但渲染产物中仍会出现这些词。

这不是一定要把 dialogue 加入扫描；机械拒绝台词原文会与「不得扩写、不得改写」冲突。但计划必须显式解决边界，否则会出现实现、文档和测试三方口径不一致。

建议在 A3 前置裁决：

- 若台词豁免，更新 `docs/architecture.md` 与 `docs/model-rules-notes.md`，把 `forbidden` 的定义从「最终渲染正文」改为「PromptIR 中可改写的提示词正文字段」，并说明 dialogue 是原文保真豁免区。
- 增加 golden 或测试用例，覆盖台词含禁词时 `validate_prompt` 通过但渲染仍保留原文的裁决。
- 若不允许最终产物出现禁词，则应 fail-closed 回到上游或向用户报错，而不是静默渲染。不要让 LLM 删除台词中的词，因为那会破坏保真。

### 4. 多个 Task 的执行顺序违反「先更新设计文档，再改代码」

计划 Global Constraints 和 AGENTS.md 都要求设计变化先更新设计文档，再同批改 schema、工具、Skill、fixture 与测试。但 A1、A3、B1、B2 的重要步骤都是先写 fixture/test、后实现，最后才更新 `docs/architecture.md` 和 `docs/model-rules-notes.md`。例如 A1 第 89–94 行先改 schema 与代码，第 96 行才更新文档；A3 第 189–204 行同样把文档更新放在实现之后。

「同一提交内完成」不等于「文档后置」。按当前步骤执行，中间状态会导致实现者按代码反推设计。

建议把每个 Task 的第 1 步改为：根据 Interfaces 更新 `docs/architecture.md` 与 `docs/model-rules-notes.md` 的目标接口，再进入 fixture、测试与实现。或者在 Task 开头显式增加「文档接口修订」步骤。

## P2：建议修订后执行

### 5. Skill-only 改动缺少可验证测试

B3 与 B4 只运行 `skills_contract`。但现有 [skills_contract.test.ts](/e:/codex-script2shot/server/tests/skills_contract.test.ts) 对 Skill 文件主要校验 frontmatter 名称与描述，不会检查新增的「事件脚本化」「负面约束策略」「渲染前自检」内容。只靠人工对照 spec 不满足仓库的验证标准。

建议为 shot-prompting 的关键契约加一个轻量测试：

- B3 断言 Skill 包含开始/随后/结束、阶段结束状态、不凑时长等关键规则，且不出现硬编码「15 秒」。
- B4 断言 8 项自检清单完整，并声明不替代 `validate_prompt`。
- 负面约束六类也应能通过文本契约测试核对。

这不等于把写作内容写成测试魔法，但可以防止后续编辑时清单被删掉或边界表述漂移。

### 6. C1 的规则解析测试覆盖不足

C1 只测试「两模型四个键均非空」和「删除 sound 键抛错」。这无法覆盖以下实现错误：

- 只解析部分键。
- 键存在但为空字符串或纯空白。
- `prompt_guidance` 缺失、非对象或数组。

建议参数化测试四个键：`shot_structure`、`dialogue`、`sound`、`negative`，每个键分别覆盖缺失与空白字符串。同时校验 `render.section_labels` 与渲染层 SECTION_KEYS 的集合一致，避免 extra labels 被静默忽略。

### 7. C1 的来源清单有一处不可追溯

全局约束列出的 2.5 卡片是 `src:YcFddglYToIItoxnK3mcXXctnJb:prompt_technique:007`，但 C1 第 395 行改用 `prompt_technique:010`。仓库当前文档搜索不到 `010` 的内容或标题，来源清单内部不一致。

执行前应二选一：

- 修正为已核实的 007，并写清卡片标题。
- 若 010 才是正确卡，把卡片标题、来源文档路径、revision、正文摘要和检索日期补入计划与 `docs/model-rules-notes.md`。

另外 A3 Step 1 提到「2.5 指南来源文档」，但没有写 URL。为了让实现者不凭记忆补链接，应在计划中列出确切来源或明确要求先通过本地卡片核对。

### 8. PromptIR 属性顺序需要与 `SHOT_FIELD_ORDER` 一并冻结

现有 `validate_prompt.ts` 的 `SHOT_FIELD_ORDER` 注释明确要求与 `schemas/prompt_ir.schema.json` 的 shot 属性顺序一致。计划只在 A1 / B1 / B2 中说插入 `SHOT_FIELD_ORDER`，但没有同步说明 schema `properties` 的插入位置。

建议每个新字段都写明：

1. schema `required` 的插入或追加位置。
2. schema `properties` 的插入位置。
3. `SHOT_FIELD_ORDER` 的插入位置。
4. 既有测试接口、fixture 与 golden 是否因字段顺序影响错误排序。

尤其是 A1：计划说 `shot_size` 在 `aspect_ratio` 后，schema 应同样把该属性放在 `aspect_ratio` 与 `subject` 之间，而不是追加到 `knowledge_refs` 后。

### 9. `emotion` 可观察化规则有诱发虚构的风险

B1 说 `emotion` 只取 `emotion_units.tone`，但要求「触发事件 + 眼神 / 呼吸 / 姿态」。上游 schema 的 `emotion_unit` 同时有 `description` 与 `tone`；如果只允许 tone，很多镜头没有足够依据写出可观察身体表现，容易被 LLM 补出原文没有的呼吸、姿态或触发事件。

建议改为：

- 取材来源为 `emotion_units.tone` 与 `emotion_units.description`，并可引用同镜头已有 `action_units` 的动作线索。
- 只有这些来源已经支持可观察表现时才填写；否则留空。
- 明确禁止由抽象情绪反推未发生的身体动作。

这样更符合计划自己的「内容保真」和「无依据留空」原则。

### 10. C1 允许 Skill 直接读规则文件，需要同步边界描述

现有 shot-prompting Skill 明确说只调用五个 MCP 工具，不直接读取模型规则文件。C1 改为允许只读 `prompt_guidance` 是一个边界变化，计划也做了修订，但还需要同步检查：

1. Skill 的「本 Skill 只调用五个 MCP 工具」句式是否仍成立。
2. `docs/architecture.md` §9.6 是否把「读取本地模型指导」写成明确例外。
3. 若想保持 Skill 不读文件，更彻底的替代是提供只读 `get_model_guidance` MCP 工具；但计划明确不改 MCP 工具名单，所以应显式选择允许本地文件读取。

## P3：小问题与优化点

### 11. `duration_sec` 到 `duration` 的映射仍未裁决

`shot_plan.schema.json` 允许 `duration_sec` 为 number，而 `prompt_ir.schema.json` 要求 `duration` 为 integer。现有 Skill 只写「取整数秒」，没有说明四舍五入、向下取整或 fail-closed。计划 B3 使用长镜头时长阈值，会更容易碰到该边界。

建议在 A1 或 B3 前补一句：非整数 `duration_sec` 是否允许；若不允许，应在 shot-planning 校验层拒绝，而不是 shot-prompting 隐式取整。

### 12. 台词渲染的空数组占位与声音空值口径不同

A3 空对白渲染「人物自然闭口，无旁白」，B2 空声音整行省略且不输出负向暗示。二者可能都是有意的，但计划没有解释为什么对白维持节骨架、声音省略整行。建议在 `docs/model-rules-notes.md` §4 明确两个占位策略的差异，避免后续 golden 被误改。

### 13. A3 可选语言与 delivery 的确定性可以更精确

计划给出中英混合示例，但没有定义：

- `language` 与 `delivery` 同时存在时的拼接顺序。
- `language` / `delivery` 本身应使用中文还是允许英文。
- 空白字符串是否视同缺省。

这些都会影响 golden 的逐字节稳定性。建议 Interfaces 里补一段冻结格式和两个测试用例。

### 14. C2 的知识卡数量建议预留断言

C2 计划生成 7 张卡。同步后 Step 4 只说「卡片总数与预期增量一致」。建议把预期写成可核对的断言：本次涉及 N 个原始文档，替换后总增量 7；每个文档的 `card_count` 分别是多少。否则实现者容易把「预期增量」解释成全局索引增量或某个文档内增量。

### 15. Part D 的裁决顺序可补充验收产物

Part D 已明确不在本计划执行，拆分方式合理。建议在 C3 收尾时只把 I1–I3 标为 Accepted，并在状态记录中单独注明 I4 属「已采纳方向，待各自计划裁决」，避免读者误以为 I4 的前置问题已经裁决完成。

## 冗余与一致性整理

1. A3 与 C1 都会写模型语言差异。A3 只应写通用取材规则（原文保真、语言只在可判定时填写、多人逐句标说话人），2.0 / 2.5 的语言差异统一交给 C1 的 `prompt_guidance`。这样可避免同一规则在 Skill 中出现两处口径。
2. B3 的正例如果是 2.5 专属，建议推迟到 C1 后；如果保留通用正例，应避免示例中出现 2.5 专属阈值。
3. Task A1 的测试步骤可以精简：枚举对齐测试已能保证 shot_plan 与 PromptIR 的映射；golden 比对已覆盖渲染行格式。不需要同时断言某一行完整文本，除非它是新的空值路径。
4. `rules/models/` 目录级 `git add` 可改为两个具体文件，降低误提交临时规则文件的风险。

## 建议的修订顺序

1. 先修正 C2 的同步与本地索引刷新流程，因为这是外部写操作，风险最高。
2. 裁决 dialogue 的禁词豁免边界，并同步文档与测试。
3. 将 C1 提前，或把模型阶段化阈值与语言差异延迟到 C1 后。
4. 为每个 Task 补「先改文档接口」步骤。
5. 补 B3 / B4 的 Skill 契约测试，扩展 C1 规则解析测试。
6. 修正 `prompt_technique:010` 来源，确认 2.5 官方文档 URL。
7. 明确 PromptIR 属性顺序、duration 取整、emotion 取材来源等接口细节。

## 未验证项

- 本报告未执行计划中的官方文档访问，也未读取本地 AI 库缓存中的卡片正文，因此无法确认 `prompt_technique:010` 是否真实存在于当前缓存；只能确认它与计划全局清单不一致。
- 本报告未修改计划文件或源码。
- `npm --prefix server test` 的构建写入失败是环境占用问题，尚未定位占用进程；直接 Vitest 运行通过只能证明现有 bundle 可用于测试，不能替代 C3 的全量命令验收。
