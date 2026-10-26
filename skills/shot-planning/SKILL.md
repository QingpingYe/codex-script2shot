---
name: shot-planning
description: 在 script2shot 第二阶段把解析过程规划为待生成视频 clip 与内部 shots：clip 总时长受模型范围约束，内部镜头允许小数秒，完整过程优先不因切镜拆段。
---

# shot-planning

把 `script_analysis.json` 落实为 `shot_plan.json`。规划单位是：

```text
process → clip（一个待生成视频）→ shot（视频内部镜头）
```

`clip` 才受模型单次生成时长和参考素材上限约束；`shot` 是视频内部镜头，允许小数秒，
不受模型 min/max 单独限制。

## 输入与校验

1. 调：
   `validate_stage_artifact({ stage: "script_breakdown", path: script_analysis_path })`。
2. 保存返回的 `content_hash` 到 `input_hashes.script_analysis`。
3. 读取 `run.json` / `script_analysis.json` 核对 run、项目、模型和 aspect ratio。
4. 读取目标模型规则文件的 `duration`、`reference_limits` 和 `shot_split`；不在 Skill
   内复制硬上限。

## 规划顺序

1. 识别完整过程。
2. 估算对白、动作和声音需要的自然时间。
3. 先在过程内部设计镜头。
4. 检查 clip 总时长和参考图上限。
5. 必要时在自然节点拆分。

禁止先逐镜头各生成一段，再用剪辑合并。

## clip 字段

每个 clip 写：

- `clip_id`、`order`、`scene_id`、`process_id`；
- `goal`、`duration_sec`（整数秒）；
- `entity_ids[]`、`reference_asset_ids[]`；
- `continuity: { previous_clip_id, enter_state, exit_state }`；
- `split_reason: none|duration_limit|reference_limit|explicit_user_request`；
- `shots[]`、`dialogue[]`、`audio`。

一个 process 默认一个 clip。超过时长或图片上限时，保留同一 `process_id`，后继 clip
用 `previous_clip_id` 承接进入/离开状态。自然进入新过程应新建 `process_id`，不要伪造
拆分原因。

## shots

每镜写：

- `shot_id`、`order`、`start_sec`、`end_sec`；
- `shot_size`、`camera_angle`、`camera_movement`、`transition`；
- `purpose`；
- `source_action_unit_ids[]`、`source_emotion_unit_ids[]`；
- `continuity.enter_state`、`continuity.exit_state`。

视觉时间轴从 0 开始，相邻镜头首尾相接，最后一镜结束时间等于 clip 总时长。同一动作
或情绪可以被多个内部镜头引用；重复来源不等于事件重复。切镜必须服务信息变化、反应、
证据揭示或动作重点。

普通信息/反应镜头可用短节奏，爆点、对白和动作按内容需要加长。不要使用固定镜头数；
不要为了填满时长新增原文没有的动作。

## dialogue

- 每条对白写 `dialogue_segment_id`、`dialogue_unit_id`、`speaker_id`、
  UTF-16 半开 `start_offset`/`end_offset`、视频内 `start_sec`/`end_sec`。
- 默认一个完整台词单元是一个片段；确需跨 clip 时只在自然句界切分。
- 同一原文单元的全部片段按序连续覆盖 `[0, text.length)`，不重复、不漏字、不改字。
- 切镜不重启或截断台词。

## audio

`ambience[]`、`sfx[]`、`music[]` 的每项是 AudioCue，结构为：

`{ cue_id, text, start_sec, end_sec, source_refs[{ kind: scene|unit|knowledge, id }] }`

- 全程环境声或音乐写 0 到 clip 总时长；
- 门响、脚步等瞬时音效写具体短区间；
- 来源必须可回指原文场次、原文单元或已有知识；无来源时留空。

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

- `TIMELINE_INVALID`：修正 clip 总时长、镜头起止、空洞、重叠或越界。
- `SOURCE_COVERAGE_INVALID`：补齐原文单元覆盖、process 归属或前后状态。
- `REFERENCE_LIMIT_EXCEEDED`：在自然节点拆分或报告无法满足，不删必要实体。
- `REFERENCE_ASSET_INVALID`：修正占位/提供状态、实体绑定或采用排除范围。
- 上游指纹过期：停止，回到解析阶段重新校验，不直接覆盖。
