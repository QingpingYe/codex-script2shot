# 模型规则来源说明（Seedance 规划子集与硬规则子集）

本文件记录 `rules/models/seedance-2.0.json` 与 `rules/models/seedance-2.5.json`
中规划子集字段（时长、画幅、镜头拆分边界）与硬规则子集字段（`required_fields`、
`forbidden`）的逐值来源。全部值的检索/核对日期均为 **2026-10-22**。

范围说明：Task 4b-1 落规划子集（§2.1 / §2.2）；Task 4c-2 追加硬规则子集
`required_fields` 与 `forbidden`（§2.3）；Task 4c-3 补齐渲染模板 `render`
（§4，插件设计决策，不对应外部来源）；Task A3 追加台词通道并重定义禁止项扫描
边界（§2.4、§3、§4）。

## 1. 来源清单

| 简称 | 来源 | 用途 |
| --- | --- | --- |
| Ark 任务 API | <https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh> | `duration`、`ratio` 的官方参数口径 |
| Ark Seedance 2.0 | <https://docs.volcengine.com/docs/ark/seedance-2-0?lang=zh> | 2.0 系列输出时长与示例默认值 |
| Ark Seedance 2.5 | <https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh> | 2.5 时长默认值与范围、编辑/延长/首帧任务画幅限制 |
| Ark 2.0 提示词指南 | <https://docs.volcengine.com/docs/ark/seedance-2-0-prompt-guide?lang=zh> | 2.0 提示词口径（被原始库卡片引用） |
| 原始库卡片 | 原始库路径：`通用知识/视频生成模型说明`；`source_revision=43`；卡片 id：`src:Jb6wdU3X3ocpzdxEgLhctgtNnkh:seedance_rule:003`（「时长与镜头拆分边界」）、`src:Jb6wdU3X3ocpzdxEgLhctgtNnkh:seedance_rule:013`（「模型选型决策建议与生成默认口径」） | 镜头拆分边界；经 AI 库同步卡片只读核对 |
| 原始库卡片（硬规则子集） | 原始库路径：`通用知识/Seedance 2.0 提示词指南`；`source_revision=5`；卡片 id：`src:RpJHdwWB5onT8qx5fWqcw6Qnn9c:prompt_technique:003`（「进阶公式：按空间层与时间层组织提示词」；卡片正文自带来源 <https://docs.volcengine.com/docs/ark/seedance-2-0-prompt-guide?lang=zh>，检索日期 2026-10-22） | `required_fields` 的提示词公式依据 |
| 原始库卡片（硬规则子集） | 原始库路径：`通用知识/视频生成模型说明`；`source_revision=43`；卡片 id：`src:Jb6wdU3X3ocpzdxEgLhctgtNnkh:seedance_rule:013`（「模型选型决策建议与生成默认口径」，含「提示词正文只保留画面、动作、声音、风格和约束，不夹带工程配置」） | `forbidden` 的「不夹带工程配置」依据 |

原始库卡片内容只读核对：规划子集由控制方在 2026-10-22 实检下发；硬规则子集由实现者
在 2026-10-22 只读读取本地 AI 库缓存 `cards.json` 逐条核对卡片正文与 revision。
两次核对都未修改原始库或 AI 库中的任何内容。

## 2. 逐值来源

### 2.1 Seedance 2.0（`rules/models/seedance-2.0.json`）

| 字段 | 规则取值 | 来源 | 核对日期 |
| --- | --- | --- | --- |
| `duration.min_sec` | 4 | Ark 任务 API：Seedance 2.0 系列 `duration` 取值范围 [4, 15]（或 -1 = 自动） | 2026-10-22 |
| `duration.max_sec` | 15 | Ark 任务 API：同上 [4, 15]；Ark Seedance 2.0：输出时长 4~15 秒 | 2026-10-22 |
| `duration.default_sec` | 5 | Ark Seedance 2.0：示例 `duration` 为 5 | 2026-10-22 |
| `aspect_ratios` | `16:9`、`4:3`、`1:1`、`3:4`、`9:16`、`21:9` | Ark 任务 API：`ratio` 可选 16:9、4:3、1:1、3:4、9:16、21:9、adaptive；2.0 系列默认 adaptive | 2026-10-22 |
| `shot_split.prefer_max_sec` | 15 | 原始库 `通用知识/视频生成模型说明`（`source_revision=43`）卡片 `src:Jb6wdU3X3ocpzdxEgLhctgtNnkh:seedance_rule:003`「时长与镜头拆分边界」：Seedance 2.0 系列最长按 15 秒规划 | 2026-10-22 |
| `shot_split.multi_action_rule` | 「每段提示词只安排一个主要动作或一个主要情绪，避免把多个独立事件压进同一段；内容超过单段上限（15 秒）时拆成多个独立提示词再剪辑组接；不为填满时长添加原文没有的动作、台词或事件。」 | 由原始库同文档卡片 `seedance_rule:003`（「每个镜头只保留一个主要动作或一个主要情绪，避免把多个独立事件压进同一段」「2.0 超出上限时拆成多个独立提示词再剪辑组接」「不为填满时长添加原文没有的动作/台词/事件」）与卡片 `seedance_rule:013`（「每段提示词只安排一个主要动作或一个主要情绪；超过目标模型单段上限的内容拆成多个提示词」）改写 | 2026-10-22 |
| `source` | Ark 任务 API、Ark Seedance 2.0、Ark 2.0 提示词指南三个 URL | 见 §1 来源清单（2.0 提示词指南被原始库卡片引用） | 2026-10-22 |
| `checked_at` | `2026-10-22` | 本文件全部值的集中核对日期 | 2026-10-22 |

### 2.2 Seedance 2.5（`rules/models/seedance-2.5.json`）

| 字段 | 规则取值 | 来源 | 核对日期 |
| --- | --- | --- | --- |
| `duration.min_sec` | 4 | Ark 任务 API：Seedance 2.5 `duration` 取值范围 [4, 30]（或 -1 = 自动） | 2026-10-22 |
| `duration.max_sec` | 30 | Ark 任务 API：同上 [4, 30]；Ark Seedance 2.5：范围 [4, 30] | 2026-10-22 |
| `duration.default_sec` | 5 | **插件规划约定，不是官方默认值**：官方默认是 `-1`（自动适配）。取 5 的原因是与 Seedance 2.0 的 Ark 示例默认值（5）及「单主动作镜头」口径一致，便于默认生成单段 5 秒提示词。 | 2026-10-22 |
| `aspect_ratios` | `16:9`、`4:3`、`1:1`、`3:4`、`9:16`、`21:9` | Ark 任务 API：`ratio` 可选 16:9、4:3、1:1、3:4、9:16、21:9、adaptive；2.5 系列默认 adaptive | 2026-10-22 |
| `shot_split.prefer_max_sec` | 30 | 原始库 `通用知识/视频生成模型说明`（`source_revision=43`）卡片 `src:Jb6wdU3X3ocpzdxEgLhctgtNnkh:seedance_rule:003`「时长与镜头拆分边界」：Seedance 2.5 最长按 30 秒规划，一个提示词可覆盖一个连续镜头内的多个节拍 | 2026-10-22 |
| `shot_split.multi_action_rule` | 「一段提示词可覆盖同一连续镜头内的多个连续节拍，但必须有统一的叙事目标，且只保留一个主要动作或一个主要情绪；避免把多个独立事件压进同一段；不为填满时长添加原文没有的动作、台词或事件。」 | 由原始库同文档卡片 `seedance_rule:003`（2.5 长镜可含连续节拍；「每个镜头只保留一个主要动作或一个主要情绪，避免把多个独立事件压进同一段」；不为填满时长添加原文没有的动作/台词/事件）与卡片 `seedance_rule:013`（「每段提示词只安排一个主要动作或一个主要情绪」）改写 | 2026-10-22 |
| `source` | Ark 任务 API、Ark Seedance 2.5 两个 URL | 见 §1 来源清单 | 2026-10-22 |
| `checked_at` | `2026-10-22` | 本文件全部值的集中核对日期 | 2026-10-22 |

### 2.3 硬规则子集（`seedance-2.0.json` 与 `seedance-2.5.json` 取值一致，Task 4c-2）

#### 2.3.1 `required_fields`（提示词正文必须非空的 PromptIR 镜头字段）

取值：`["shot_size", "subject", "action", "setting", "camera_movement", "lighting", "color", "style"]`

| 字段 | 规则取值 | 来源 | 核对日期 |
| --- | --- | --- | --- |
| `required_fields[0]` | `shot_size` | **插件设计裁决，无外部来源**：景别取自 `schemas/shot_plan.schema.json` 的冻结 9 值中文枚举，PromptIR 用英文枚举一一对应（见 §4.2、§4.3）；上游已有该信息，渲染出的提示词正文按「景别、机位与运镜」成节，因此要求非空 | 2026-10-22 |
| `required_fields[1]` | `subject` | 原始库 `通用知识/Seedance 2.0 提示词指南`（`source_revision=5`）卡片 `src:RpJHdwWB5onT8qx5fWqcw6Qnn9c:prompt_technique:003` 的进阶公式「精准主体 + 动作细节 + 场景环境 + 光影色调 + 镜头运镜 + 视觉风格 + 画质 + 约束条件」的「精准主体」 | 2026-10-22 |
| `required_fields[2]` | `action` | 同一公式的「动作细节」 | 2026-10-22 |
| `required_fields[3]` | `setting` | 同一公式的「场景环境」 | 2026-10-22 |
| `required_fields[4]` | `camera_movement` | 同一公式的「镜头运镜」 | 2026-10-22 |
| `required_fields[5]` | `lighting` | 同一公式的「光影色调」中的「光影」 | 2026-10-22 |
| `required_fields[6]` | `color` | 同一公式的「光影色调」中的「色调」 | 2026-10-22 |
| `required_fields[7]` | `style` | 同一公式的「视觉风格」+「画质」；PromptIR 没有独立画质字段，画质口径并入 `style` | 2026-10-22 |

公式中的「约束条件」由 `negative_prompt` 承载，允许为空数组，不列入 `required_fields`；
`time`、`camera_angle`、`continuity`、`knowledge_refs` 由 schema 保证存在，但不要求非空。
`shot_size` 是 I1.1 新增的插件设计裁决项：它没有外部公式依据，只保证上游景别不被第三
阶段丢掉；`required_fields` 的数组顺序与 `schemas/prompt_ir.schema.json` 的 `required`
顺序（`aspect_ratio` 之后、`subject` 之前）保持一致。

#### 2.3.2 `forbidden`（由 Agent 撰写、可改写的提示词正文字段不得命中的禁止项）

取值：`["--ar", "aspect_ratio", "duration", "fps", "resolution", "run_id", "seedance"]`

| 字段 | 规则取值（词表项） | 来源 | 核对日期 |
| --- | --- | --- | --- |
| `forbidden[0]` | `--ar` | 原始库 `通用知识/视频生成模型说明`（`source_revision=43`）卡片 `src:Jb6wdU3X3ocpzdxEgLhctgtNnkh:seedance_rule:013`：「提示词正文只保留画面、动作、声音、风格和约束，不夹带工程配置」；`--ar` 是画幅运行参数记号 | 2026-10-22 |
| `forbidden[1]` | `aspect_ratio` | 同上：PromptIR / 接口的画幅参数名，属于工程配置 | 2026-10-22 |
| `forbidden[2]` | `duration` | 同上：时长参数名，属于工程配置 | 2026-10-22 |
| `forbidden[3]` | `fps` | 同上：帧率参数名，属于工程配置 | 2026-10-22 |
| `forbidden[4]` | `resolution` | 同上：分辨率参数名，属于工程配置 | 2026-10-22 |
| `forbidden[5]` | `run_id` | 同上：run 元数据字段名，属于工程配置 | 2026-10-22 |
| `forbidden[6]` | `seedance` | 同上：模型标识；提示词正文描述画面，不写模型名 | 2026-10-22 |

`forbidden` 的扫描范围口径是「由 Agent 撰写、可改写的提示词正文字段」：PromptIR 中
由本插件 Agent 生成、重新生成镜头时可以替换措辞的正文文本。`dialogue` 不在这个
范围里——台词取自上游 `dialogue_units.text` 原文，是**原文保真豁免区**；为通过
禁止项扫描而改写、删词或屏蔽台词会破坏保真，因此 `validate_prompt` 不对
`dialogue` 做禁止项扫描（Task A3 裁决）。台词包含 `fps` / `duration` 等词时，
校验仍返回 `ok: true`，渲染仍逐字保留原文。豁免的代价是最终提示词正文可能保留
这些词，该边界优先于「正文不夹带工程配置」；两条裁决测试
（`server/tests/validate_prompt.test.ts`、`server/tests/render_prompt.test.ts`）
钉住这一行为。

### 2.4 台词与声音语法来源（Task A3）

本节的核对口径：官方页面在当前运行环境不可访问（网络受限），以下事实逐条对照本地
AI 库缓存 `cards.json`（只读）中已同步的知识卡正文，卡片正文自带来源与检索日期。
**待官方复核**：官方页面恢复可达后应重新核对本节的语法与语种口径。

| 事实 | 来源卡片 | 核对日期 |
| --- | --- | --- |
| Seedance 2.0 台词用 `{}` 包裹；台词语言需统一、避免中英文混用（专有名词除外）；台词为小语种（非中英文）时需标注语种，例如「用日语说道{こんにちは}」。同一卡片还给出音效 `<…>`、音乐 `(…)`、字幕 `【…】` 的符号约定 | `src:RpJHdwWB5onT8qx5fWqcw6Qnn9c:prompt_technique:013`「语言与特殊字符规范」（原始库 `通用知识/Seedance 2.0 提示词指南`，`source_revision=5`；卡片正文自带来源 <https://docs.volcengine.com/docs/ark/seedance-2-0-prompt-guide?lang=zh> 与检索日期 2026-10-22） | 2026-10-22 |
| Seedance 2.5 台词用 `{}`、音效用 `<>`、音乐用 `()`、字幕用 `【】`；来源为飞书文档 `OsiUdR1OxoDqvnxsK8LczYx7nPd`《Seedance 2.5 提示词撰写指南》 | `src:YcFddglYToIItoxnK3mcXXctnJb:prompt_technique:007`「声音与文字的特殊字符约定」（原始库 `通用知识/Seedance 2.5 提示词指南`，`source_revision=39`） | 2026-10-22 |
| 台词语种差异：2.0 以中文、英语为主并支持若干常见语种，小语种需明确标注；2.5 支持更多语种；多人对话仍需逐句标明说话人与语言 | `src:Jb6wdU3X3ocpzdxEgLhctgtNnkh:seedance_rule:011`「Seedance 2.0 与 2.5 的提示词维度差异对照」（原始库 `通用知识/视频生成模型说明`，`source_revision=43`） | 2026-10-22 |

引用范围（Task A3 裁决）：本节的模型语言差异只记录在本文件，供后续 Task B3 的
规则文件 `prompt_guidance` 落地；`skills/shot-prompting/SKILL.md` 只写通用取材
规则（原文保真、`language` 只在可判定时填写、多人逐句标说话人、无对白留空数组），
不写 2.0 / 2.5 的语言差异。

## 3. 口径说明与裁决记录

- 官方 `ratio` 可选值包含 `adaptive`（2.0 / 2.5 系列默认）。规划子集要求每个镜头落到
  确定性画幅，因此规则文件只收录 6 个确定性画幅，不收录 `adaptive`。4c-2 裁决：
  `validate_prompt` 的 `aspect_ratio` 校验直接用规则文件集合（6 个确定性画幅），
  schema enum、规则文件与校验三处保持一致，不放开 `adaptive`；若将来放开，需同时改
  这三处与本文件。
- 官方口径：Seedance 2.5 的编辑 / 延长 / 首帧任务 `ratio` 仅支持 `adaptive`。本规则文件
  面向文本生成与规划，不覆盖这些任务类型。
- `duration.default_sec = 5`（2.5）与 `shot_split.prefer_max_sec` 都只约束「规划默认口径」，
  不改变官方取值范围；校验逻辑只能使用 `min_sec` / `max_sec` 判越界。
- `shot_plan.json` 的 `duration_sec` 采用「整数秒 + 范围」双口径：先由校验层判定
  `Number.isInteger`，非整数直接返回 `OUT_OF_RANGE` 且不再判范围（每镜头至多一条时长
  错误）；整数再与目标模型 `min_sec` / `max_sec` 比较。`schemas/shot_plan.schema.json`
  保持 `type: number`，不收紧为 `integer`：冻结接口不因校验口径变化，整数约束由
  `validate_stage_artifact` 执行。
- `forbidden` 匹配口径由 `server/src/tools/validate_prompt.ts` 定义：大小写不敏感的
  子串匹配（中文提示词没有词边界）；扫描范围是**由 Agent 撰写、可改写的提示词正文
  字段**，即 `subject` / `action` / `setting` / `time` / `camera_angle` /
  `camera_movement` / `lighting` / `color` / `style`、`continuity.character_state` /
  `continuity.environment_state`、以及 `negative_prompt[]` 条目。`dialogue` 是原文
  保真豁免区（台词必须逐字保留，见 §2.3.2），`knowledge_refs` 是知识溯源元数据，
  两者都不参与扫描。改扫描范围需在同一改动内同步代码与本文件。

## 4. 提示词渲染模板（Task 4c-3，插件设计决策，无外部来源）

`rules/models/*.json` 的 `render` 字段是插件自己的渲染模板，不属于官方 API 参数，
本节全部内容为插件设计裁决，不引用外部资料。两个规则文件的 `render` 当前只在
`title`（模型 label）上不同，节标签与节顺序一致。

### 4.1 模板字段

| 字段 | 含义 | 当前取值 |
| --- | --- | --- |
| `title` | 文档一级标题（含 `#`），逐字输出 | `# Seedance 2.0 提示词` / `# Seedance 2.5 提示词` |
| `shot_heading` | 单镜头分节标题模板，占位符 `{shot_id}` / `{duration}` / `{aspect_ratio}` | `## 镜头 {shot_id}（时长 {duration} 秒，画幅 {aspect_ratio}）` |
| `section_labels` | 节 key → 中文节标签 | 见 §4.2 |
| `section_order` | 节输出顺序 | `subject_action` → `dialogue` → `setting_time` → `camera` → `light_color` → `style` → `continuity` → `negative` |
| `empty_negative` | 空 `negative_prompt` 的稳定占位 | `无` |
| `empty_dialogue` | 空 `dialogue`（无对白镜头）的稳定占位 | `无对白；人物自然闭口，无旁白` |

规则文件只承载「人可见的中文标题与节标签 / 节顺序」；字段到节内容的组装在
`server/src/tools/render_prompt.ts`。`section_order` 必须是节 key 全集的固定顺序：
渲染层持有节 key 全集，多节 / 少节都按插件安装损坏处理（`RENDER_FAILED`）。

### 4.2 节顺序与 brief 冻结顺序的对应

| 冻结顺序 | 模板落点与节内格式 |
| --- | --- |
| 镜头号与时长 | `shot_heading` 分节标题行；PromptIR 的 `aspect_ratio` 必须进入产物但不在冻结的八个节名内，与镜头号、时长同一行 |
| 主体与动作 | `subject_action`：`主体：{subject}；动作：{action}` |
| 对白 | `dialogue`：条目按 `{speaker}用{language}{delivery}说：{text}` 拼接（`text` 用 `{}` 包裹），条目间用「；」连接；空数组渲染为 `empty_dialogue` |
| 环境与时间 | `setting_time`：`环境：{setting}；时间：{time 中文标签}` |
| 景别、机位与运镜 | `camera`：`景别：{shot_size 中文标签}；机位：{camera_angle 中文标签}；运镜：{camera_movement 中文标签}` |
| 光线与色彩 | `light_color`：`光线：{lighting}；色彩：{color}` |
| 风格 | `style`：`{style}`（单字段，无子标签） |
| 连续性 | `continuity`：`承接镜头：{previous_shot}；角色状态：{character_state}；环境状态：{environment_state}` |
| 负面约束 | `negative`：`{negative_prompt 条目以「、」连接}`；空数组渲染为 `empty_negative` |

### 4.3 裁决记录

- 空 `negative_prompt`：**不省略节**，稳定渲染 `- 负面约束：无`（占位可配）。理由：
  每个镜头维持同一套节骨架，便于逐镜头复制与快照比对；`negative_prompt` 允许为空
  （4c-2 未列入 `required_fields`），省略节会让节数随内容变化。
- 空 `dialogue`：同样**不省略节**，稳定渲染
  `- 对白：无对白；人物自然闭口，无旁白`（占位可配 `render.empty_dialogue`）。
  理由与空 `negative_prompt` 相同（保持节骨架）；占位文本还明确告诉模型该镜头
  不出话、不加旁白，避免静默镜头被模型自行补台词。
- 对白拼接（Task A3 冻结格式）：条目按 `{speaker}用{language}{delivery}说：{text}`
  拼接，`text` 逐字放进 `{}`（`{}` 是 Seedance 的台词记号，来源见 §2.4），条目间用
  「；」连接；`language` / `delivery` 缺失或为纯空白串时省略对应片段，判定与拼接都
  用去掉首尾空白后的值，两个字段用中文短词。台词原文逐字保留、不翻译、不删改
  （原文保真豁免区，见 §2.3.2）。
- 中文正文与自由文本：节标签、子标签为中文；`subject` / `action` / `setting` /
  `lighting` / `color` / `style` 与 `continuity` 状态字段是自由文本，渲染层原样输出、
  不翻译。
- 时间词本地化（Task A2，**插件设计裁决，无外部来源**）：`time` 是结构化时间术语，
  但「最终渲染的 Seedance 提示词正文统一使用中文」（`docs/architecture.md` §11.3），
  因此渲染层对收录的时间词做中文映射，`TIME_LABELS` 的键顺序为：
  `night`→夜晚、`day`→白天、`dawn`→清晨、`dusk`→黄昏、`morning`→早晨、`noon`→正午、
  `afternoon`→下午、`evening`→傍晚。映射表在
  `server/src/tools/render_prompt.ts`；`time` 字段的 schema 口径不变，仍是英文术语，
  只有渲染层本地化。未收录词（如 `holographic-noon`）原样透传，不发明未定义的映射；
  空 `time` 不生成「时间」子标签（沿用空子字段口径）。
- 英文枚举 → 中文：冻结枚举 `shot_size` / `camera_angle` / `camera_movement` 做映射，
  取值与 `schemas/prompt_ir.schema.json` 的字段描述、`schemas/shot_plan.schema.json` 的
  中文枚举一一对应（9 个景别、13 个机位、16 个运镜；映射表在
  `server/src/tools/render_prompt.ts`）。`shot_size` 由 I1.1 加入 `camera` 节，
  节 key 不变，只是节标签改为「景别、机位与运镜」、节内子标签从两项变三项。
- 空子字段：可为空的子字段（`time`、`previous_shot` 缺省 / `null`）为空时不生成子
  标签；必填字段由 4c-2 硬规则保证非空。
- 校验失败不渲染：`render_prompt` 先调用 `validate_prompt`；不通过返回
  `HARD_RULE_VIOLATION`（`details.errors` 为校验错误明细）且不创建目录、不写文件。
- 文档级元信息：标题行含模型 label；单镜头正文不写模型名、`run_id`、时间戳等工程
  信息（与 §2.3.2 的 forbidden 口径一致：禁止项扫描只作用于 PromptIR 正文字段）。
  渲染产物不含时间戳，行尾统一 `\n`，同输入逐字节一致。
- golden 先行：`tests/fixtures/prompts/seedance-2.0.golden.md` 与
  `seedance-2.5.golden.md` 按本设计手写，再让实现对齐 golden；对齐过程中未修改
  golden，因此没有需要记录的「迁就实现」修改。快照按字节比较，行尾参与比对：
  `.gitattributes` 对 `tests/fixtures/prompts/*.golden.md` 固定 `text eol=lf`，
  避免 Windows 上的 `core.autocrlf` 在检出时改写快照。
