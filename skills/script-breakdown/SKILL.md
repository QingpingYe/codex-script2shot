---
name: script-breakdown
description: 把剧本解析为 script_analysis v2：建立实体、参考图占位和完整过程，逐个动作/情绪/对白单元记录来源，保存 run_context 指纹。
---

# script-breakdown

把剧本文本解析成 `script_analysis.json`。产物是 v2，不是镜头清单：它先建立实体、
参考素材槽和完整过程，再由 `shot-planning` 决定哪些过程放进一个视频、视频内部如何切镜。

## 输入

- 剧本文本（片段、单集或多集）。
- `run.json`：`schema_version: 2`、`run_id`、`input_mode`、`project_id`、
  `target_model`、可选 `input_references`、可选 `display_timeline`。
- `run_context_hash`：由入口从 `init_run` / `read_run` 返回，写入产物的
  `input_hashes.run_context`。
- 知识：先按角色、场景首次出现做项目检索；脚本解析可以是通用知识检索。
  只读取本地索引/缓存，不写远端库。

## 流程

1. **读取并校验 run。** `read_run` 必须返回 v2。缺版本、v1、未来版本立即报告
   `ARTIFACT_VERSION_UNSUPPORTED`，不生成新产物。
2. **拆集拆场。** 保留 `scene_id`、heading、summary、地点、时间和角色，不新增剧情。
3. **建立实体台账。** 顶层 `entities[]` 覆盖：
   - 每个角色：`entity_type: character`；
   - 每个实际场景：`entity_type: scene`；同一实景跨场次复用同一 `entity_id`；
   - 每个关键道具：参与动作、剧情证据、交接归属或连续性变化的道具才建 `prop`。
   每个实体写 `name`、`description`、`source_scene_ids[]`。不确定的外观明确待补充。
4. **建立参考素材槽。** 顶层 `reference_assets[]`：
   - 仅剧本输入时，为每个角色、场景、关键道具分别建至少一个 `image` 占位；
   - `status: placeholder` 不得写伪造 `source`；
   - 用户实际提供的素材写 `status: provided` 和真实本地路径或素材标识；
   - 每个素材写 `adopt[]` 与 `exclude[]`，说明采用范围和需排除内容；
   - 同一实体跨场次复用同一个 `asset_id`。
5. **建立原文单元和过程。** 场景内：
   - `action_units[]`、`emotion_units[]`、`dialogue_units[]` 保留稳定 ID 和原文；
   - 三类单元均写 `entity_ids[]`；
   - `processes[]` 写 `process_id`、`goal`、`enter_state`、`exit_state`、
     `action_unit_ids[]`、`emotion_unit_ids[]`、`dialogue_unit_ids[]`、`entity_ids[]`；
   - 每个应表现的原文单元必须且只能归入一个过程；
   - 一个过程是完整叙事过程，不等于一个镜头或一个视频。
6. **检索连续性。** 只使用检索结果补全外观、场景布局和风格；不得补写原文没有的
   剧情、关系、动作或台词。把引用写入 `knowledge_refs[]`，阶段层固定
   `clip_id: null`、`shot_id: null`。
7. **写 `missing_info[]`。** 参考图待提供、外观不明和必须回问的信息写结构化条目。
   只有剧本输入不阻断，继续产出带占位槽的完整草稿。
8. **校验并返回指纹。**
   `validate_stage_artifact({ stage: "script_breakdown", path })` 成功返回
   `content_hash`，交给规划阶段保存为 `input_hashes.script_analysis`。

## 输出要点

```text
script_analysis.json
  schema_version: 2
  input_hashes.run_context
  episodes[].scenes[].processes[]
  entities[]
  reference_assets[]
  continuity
  missing_info
  knowledge_refs
  generated_at
```

## 失败处理

- 版本不支持：停止，报告文件与 `found_version`。
- 实体、过程或素材引用无法解析：停止，报告 `path` 和错误码。
- 关键外观不确定：写 `missing_info`，不要编造。
- 参考图缺失：创建占位槽，不要假装已提供。
- 校验失败：按 `errors[].path` 修正并整体重写，不在旧接口上补丁。
