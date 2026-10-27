---
name: shot-planning
description: 在 script2shot 第二阶段把解析过程规划为待生成视频 clip 与内部 shots：所有时间使用整数秒，按节拍估算镜头时长，完整过程优先不因切镜拆段。
---

# shot-planning

把 `script_analysis.json` 落实为 `shot_plan.json`。规划单位是：

```text
process → clip（一个待生成视频）→ shot（视频内部镜头）
```

`clip` 是一次生成任务，受模型单次生成时长和参考素材上限约束；`shot` 是视频内部镜头。
所有 clip、shot、对白和 AudioCue 的时间边界都必须是整数秒，不允许小数。

## 输入与校验

1. 调：
   `validate_stage_artifact({ stage: "script_breakdown", path: script_analysis_path })`。
2. 保存返回的 `content_hash` 到 `input_hashes.script_analysis`。
3. 读取 `run.json` / `script_analysis.json` 核对 run、项目、模型和 aspect ratio。
4. 读取目标模型规则文件的 `duration`、`reference_limits` 和 `shot_split`；不在 Skill
   内复制模型硬上限。

## 规划顺序

固定顺序是：节拍估算 → 镜头整数时长 → 过程镜头序列 → clip 分批 → clip 内时间轴归零。

1. 识别完整过程。
2. 把 `action_units`、`emotion_units`、`dialogue_units` 拆成节拍。节拍是最小的新信息
   或状态变化：一句对白、一次反应、一个动作变化、一次插入信息或一个必要的可见停留。
3. 估算每个节拍的自然时长。一个 shot 可以包含同一机位、同一连续动作的多个节拍；
   出现新的信息点、反应或空间关系时需要切镜。
4. 先把节拍合并成 shot，再把每镜向上取整为整数秒，形成整个过程的镜头序列。
5. 在自然边界上把镜头序列分批装入 clip，同时检查模型 `min_sec`、`max_sec` 和参考素材
   上限。
6. 每个 clip 内从 `0` 重新累计 shot 时间；`clip.duration_sec = 本批 shot 整数时长之和`。
7. 检查对白切分、AudioCue 和前后状态。

禁止先固定 clip 总时长，再按镜头数平均分配；禁止先逐镜头各生成一段，再用剪辑合并。

## 时长估算

估算过程可以使用临时小数，但不得写入产物。

| 节拍类型 | 初始估算 | 规则 |
| --- | --- | --- |
| 中文对白 | 约 3.5–4 字/秒 | 普通对白取 3.5–4；强调、哭腔、停顿取 3；向上取整 |
| 英文对白 | 约 2.5–3 词/秒 | 向上取整；专有名词和慢速表演可降速 |
| 反应 / 插入 | 1–2 秒 | 只表现一个表情、手部、道具或证据信息 |
| 简单动作 | 2–3 秒 | 一个起止明确的动作 |
| 复合动作 | 4–6 秒 | 动作有多个阶段但仍在一个镜头内完成 |
| 可见停留 / 转场 | 1 秒 | 只在原文有状态变化、空间关系或连续性需要时使用 |

- 同一镜头内对白与动作重叠时取 `max(dialogue, action)`，不把两条时间相加。
- 先后发生的节拍才相加；加总后每镜向上取整一次，最小为 1 秒。
- 反应和插入镜头不得为了填满 clip 而拉长；不得为填满时长新增动作。
- 项目知识或用户明确给出的语速可以覆盖默认估算。
- 不要使用固定镜头数或固定每镜秒数。

## 长镜头例外

每个 shot 写 `start_sec`、`end_sec`。当单镜时长超过 6 秒时，必须写非空的
`long_take_reason`，说明为什么这是不可拆的连续动作、连续视线或连续空间关系。6 秒及
以下可以省略该字段。超过 12 秒时先检查能否在动作完成、短句结束或信息揭示处拆镜；
确实保留连续长镜头时，`long_take_reason` 仍然必填。

该字段是内部规划字段，不要求出现在最终 Markdown 正文。

## clip 分批

- clip 边界必须落在镜头边界上，优先选择动作完成、短句结束、反应结束或信息揭示。
- 每个候选 clip 同时检查：整数秒、模型 `min_sec..max_sec`、参考素材上限、对白是否能
  在自然句界分配，以及 `previous_clip_id` 和进入/离开状态。
- 优先选择不超过 `max_sec` 的自然前缀，但剩余部分必须为 0 或不小于 `min_sec`。
- 例如 32 秒过程在 2.5（4–30 秒）下不能切成 `30+2`；应选择例如 `16+16` 或 `28+4`。
- 18 秒过程在 2.0（4–15 秒）下不能切成 `15+3`；应选择 `9+9` 等合法自然切分。
- 同一个 process 可拆成多个 clip，保留同一 `process_id`，后继 clip 用
  `previous_clip_id` 承接进入/离开状态。
- 多个互不相关的过程不要为减少条数硬塞进同一 clip。

## clip 与 shot 字段

每个 clip 写：

- `clip_id`、`order`、`scene_id`、`process_id`；
- `goal`、`duration_sec`（整数秒）；
- `entity_ids[]`、`reference_asset_ids[]`；
- `continuity: { previous_clip_id, enter_state, exit_state }`；
- `split_reason: none|duration_limit|reference_limit|explicit_user_request`；
- `shots[]`、`dialogue[]`、`audio`。

每镜写：

- `shot_id`、`order`、`start_sec`、`end_sec`（整数秒）；
- `shot_size`、`camera_angle`、`camera_movement`、`transition`；
- `purpose`；
- `long_take_reason`（超过 6 秒时必填）；
- `source_action_unit_ids[]`、`source_emotion_unit_ids[]`；
- `continuity.enter_state`、`continuity.exit_state`。

## dialogue 与 audio

- 对白片段写 UTF-16 半开 `start_offset`/`end_offset` 和整数秒
  `start_sec`/`end_sec`；同一原文单元的所有片段按序连续覆盖 `[0, text.length)`。
- 对白可以跨 shot 或 clip，但跨 clip 时只在自然句界切分，不重复、不漏字、不改字。
- AudioCue 的 `start_sec`/`end_sec` 也必须为整数秒。
- 全程环境声或音乐覆盖 `0` 到 clip 总时长；瞬时音效写具体短区间；来源必须可回指
  原文场次、原文单元或已有知识。

## 下了什么就必须能回指

- clip 的实体、素材 ID 必须来自解析产物；
- 动作/情绪引用必须属于该 process；
- 参考图数量超过模型上限时先按自然过程边界拆分；
- 同一不可拆场面仍超限时报告冲突，不漏实体、不冒充已提供。

## 输出与交接

写入 `shot_plan.json` 后调：

`validate_stage_artifact({ stage: "shot_planning", path, script_analysis_path })`

成功返回 `content_hash`，交给提示词阶段保存为 `input_hashes.shot_plan`。

## 失败处理

- `TIMELINE_INVALID`：修正 clip 总时长、整数秒、镜头起止、空洞、重叠或越界；不得自动
  四舍五入。
- `SOURCE_COVERAGE_INVALID`：补齐原文单元覆盖、process 归属或前后状态。
- `REFERENCE_LIMIT_EXCEEDED`：在自然节点拆分或报告无法满足，不删必要实体。
- `REFERENCE_ASSET_INVALID`：修正占位/提供状态、实体绑定或采用排除范围。
- `long_take_reason` 缺失：补写合理的长镜头说明，或把镜头拆到 6 秒以内。
- 上游指纹过期：停止，回到解析阶段重新校验，不直接覆盖。