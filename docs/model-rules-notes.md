# 模型规则来源说明（Seedance 规划子集与硬规则子集）

本文件记录 `rules/models/seedance-2.0.json` 与 `rules/models/seedance-2.5.json`
中规划子集字段（时长、画幅、镜头拆分边界）与硬规则子集字段（`required_fields`、
`forbidden`）的逐值来源。全部值的检索/核对日期均为 **2026-10-22**。

范围说明：Task 4b-1 落规划子集（§2.1 / §2.2）；Task 4c-2 追加硬规则子集
`required_fields` 与 `forbidden`（§2.3）；`render` 由 4c-3 补齐，补齐时在本文件
追加对应来源。

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

取值：`["subject", "action", "setting", "camera_movement", "lighting", "color", "style"]`

| 字段 | 规则取值 | 来源 | 核对日期 |
| --- | --- | --- | --- |
| `required_fields[0]` | `subject` | 原始库 `通用知识/Seedance 2.0 提示词指南`（`source_revision=5`）卡片 `src:RpJHdwWB5onT8qx5fWqcw6Qnn9c:prompt_technique:003` 的进阶公式「精准主体 + 动作细节 + 场景环境 + 光影色调 + 镜头运镜 + 视觉风格 + 画质 + 约束条件」的「精准主体」 | 2026-10-22 |
| `required_fields[1]` | `action` | 同一公式的「动作细节」 | 2026-10-22 |
| `required_fields[2]` | `setting` | 同一公式的「场景环境」 | 2026-10-22 |
| `required_fields[3]` | `camera_movement` | 同一公式的「镜头运镜」 | 2026-10-22 |
| `required_fields[4]` | `lighting` | 同一公式的「光影色调」中的「光影」 | 2026-10-22 |
| `required_fields[5]` | `color` | 同一公式的「光影色调」中的「色调」 | 2026-10-22 |
| `required_fields[6]` | `style` | 同一公式的「视觉风格」+「画质」；PromptIR 没有独立画质字段，画质口径并入 `style` | 2026-10-22 |

公式中的「约束条件」由 `negative_prompt` 承载，允许为空数组，不列入 `required_fields`；
`time`、`camera_angle`、`continuity`、`knowledge_refs` 由 schema 保证存在，但不要求非空。

#### 2.3.2 `forbidden`（提示词正文字段不得命中的禁止项）

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
- `forbidden` 匹配口径由 `server/src/tools/validate_prompt.ts` 定义：大小写不敏感的
  子串匹配（中文提示词没有词边界）；扫描范围是最终渲染进提示词正文的文本，即
  `subject` / `action` / `setting` / `time` / `camera_angle` / `camera_movement` /
  `lighting` / `color` / `style`、`continuity.character_state` /
  `continuity.environment_state`、以及 `negative_prompt[]` 条目；`knowledge_refs` 是知识
  溯源元数据，不渲染进正文，不参与扫描。改扫描范围需在同一改动内同步代码与本文件。
