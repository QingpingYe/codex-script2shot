# 模型规则来源说明（Seedance 规划子集）

本文件记录 `rules/models/seedance-2.0.json` 与 `rules/models/seedance-2.5.json`
中规划子集字段（时长、画幅、镜头拆分边界）的逐值来源。全部值的检索/核对日期均为
**2026-10-22**。

范围说明：本任务（Task 4b-1）只落规划子集；`required_fields`、`forbidden`、
`render` 由 4c 任务补齐，补齐时在本文件追加对应来源。

## 1. 来源清单

| 简称 | 来源 | 用途 |
| --- | --- | --- |
| Ark 任务 API | <https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh> | `duration`、`ratio` 的官方参数口径 |
| Ark Seedance 2.0 | <https://docs.volcengine.com/docs/ark/seedance-2-0?lang=zh> | 2.0 系列输出时长与示例默认值 |
| Ark Seedance 2.5 | <https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh> | 2.5 时长默认值与范围、编辑/延长/首帧任务画幅限制 |
| Ark 2.0 提示词指南 | <https://docs.volcengine.com/docs/ark/seedance-2-0-prompt-guide?lang=zh> | 2.0 提示词口径（被原始库卡片引用） |
| 原始库卡片 | 原始库路径：`通用知识/视频生成模型说明`；`source_revision=43`；卡片 id：`src:Jb6wdU3X3ocpzdxEgLhctgtNnkh:seedance_rule:003`（「时长与镜头拆分边界」）、`src:Jb6wdU3X3ocpzdxEgLhctgtNnkh:seedance_rule:013`（「模型选型决策建议与生成默认口径」） | 镜头拆分边界；经 AI 库同步卡片只读核对 |

原始库卡片内容只读核对，本次核对未修改原始库或 AI 库中的任何内容。

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

## 3. 口径说明与待裁决项

- 官方 `ratio` 可选值包含 `adaptive`（2.0 / 2.5 系列默认）。规划子集要求每个镜头落到
  确定性画幅，因此规则文件只收录 6 个确定性画幅，暂不收录 `adaptive`；是否在 4c 硬规则
  校验中放开 `adaptive`，在 4c 任务中裁决并同步本文件。
- 官方口径：Seedance 2.5 的编辑 / 延长 / 首帧任务 `ratio` 仅支持 `adaptive`。本规则文件
  面向文本生成与规划，不覆盖这些任务类型。
- `duration.default_sec = 5`（2.5）与 `shot_split.prefer_max_sec` 都只约束「规划默认口径」，
  不改变官方取值范围；校验逻辑只能使用 `min_sec` / `max_sec` 判越界。
