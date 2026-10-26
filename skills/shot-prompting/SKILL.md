---
name: shot-prompting
description: 在 script2shot 第三阶段把视频 clip 复制为 PromptIR，按五模块写成一段可包含多镜头的提示词；Seedance 2.5 强制秒数，2.0 按运行偏好，且所有参考素材职责和上游指纹可追踪。
---

# shot-prompting

把一个 `clip` 写成一份待生成视频提示词。一个 clip 可以包含多个 `shots`，提示词正文
固定五模块：

1. 【生成目标】
2. 【参考素材职责】
3. 【主体与关系】
4. 【事件脚本】
5. 【保持一致】

## 上游校验

调用：

`validate_stage_artifact({ stage: "shot_planning", path: shot_plan_path, script_analysis_path })`

把返回的 `content_hash` 写入 PromptIR 的 `input_hashes.shot_plan`；解析产物指纹写入
`input_hashes.script_analysis`，不自行计算。读取 `run.json` 的 `display_timeline`：

- Seedance 2.5：必须为 `true`；
- Seedance 2.0：默认 `false`，用户明确要求时写 `true`。

## PromptIR 顶层

```text
schema_version: 2
run_id
target_model
input_hashes.script_analysis
input_hashes.shot_plan
display_timeline
clips[]
generated_at
```

每个 clip 复制上游身份、时间、镜头决策、`dialogue_segment_id`、声音和连续性，不修改计划。

## 参考素材职责

- `reference_bindings[]` 显式保存 `asset_id`、`media_type`、`entity_ids[]`、
  本段 `tag`、`status`、`adopt[]`、`exclude[]`。
- 图片按本段上传顺序编号 `@图片1`、`@图片2`；视频、音频各自独立编号。
- 同一实体跨视频使用同一 `asset_id`，不同视频的标签可以重新编号。
- 正文里的每个标签必须在本段唯一解析。
- 只有剧本输入时保留 `待提供` 占位；不得把占位写成已提供，也不得删除实体槽。
- `adopt` 写使用的部分，`exclude` 写容易误带入而必须排除的部分。

## 主体与关系

写角色身份、数量、服装、空间方位和道具归属。只使用上游原文、实体台账和已检索知识，
不从抽象情绪反推没有发生的身体动作。

## 事件脚本化

按视频内镜头顺序写。Seedance 2.5 的每个视觉镜头都要有明确秒数区间；对白和声音 cue
使用独立秒数区间，允许跨切镜。Seedance 2.0 默认按「镜头1／镜头2」顺序写，用户开启
时间轴后再显示秒数。

完整过程优先保留在一个视频中：

- 正反打、特写和连续动作不因切镜另起提示词；
- 超过模型上限时只按自然节点拆段；
- 每段写清承接、进入和离开状态；
- 长镜头是否阶段化参考 `prompt_guidance.long_shot_staging_threshold_sec`，不把阈值
  硬编码进 Skill。

台词只从上游 `dialogue_units.text` 的 offset 切片复制。跨视频片段按自然句界拆分，
全部片段按序拼接必须逐字还原原文。台词不参与禁止项扫描，但不能改字、补台词或重复
输出。

声音只使用上游已经存在的环境声、音效、音乐和 cue 区间。音效用 `<>`、音乐用 `()`、
台词用 `{}`。

## 负面约束策略

按目标模型规则文件的 `prompt_guidance.negative` 写作。画面优先正向描述；只有素材
职责、编辑范围或容易误带入内容写限制。不发明固定质量包，不自动加水印或字幕要求。
该策略是语义写作提醒，不替代 `validate_prompt` 的确定性硬规则。

## 渲染前自检

- 每个 clip 是否恰好五模块、名称和顺序正确；
- 2.5 是否每条镜头/对白/声音都有秒数；
- 2.0 的 `display_timeline` 是否符合运行偏好；
- 素材标签是否唯一、编号连续、职责同时说明采用和排除；
- 对白是否逐字还原、只消费一次；
- 声音是否有来源和时间；
- 是否新增了原文没有的事件、动作或台词；
- 是否把多个无关过程硬塞进一个视频，或把完整过程无故切碎。

自检不替代 `validate_prompt`。发现问题时整体重写 `prompts.ir.json` 后重新校验。

## 校验与渲染

1. `validate_prompt({ prompt_ir_path, shot_plan_path, script_analysis_path })`；
2. 最多两轮按 `{clip_id, shot_id, field, code, message}` 定点修复；
3. `render_prompt({ prompt_ir_path, output_path, shot_plan_path, script_analysis_path })`；
4. 校验或渲染失败不写或覆盖输出文件。

## 失败处理

- `INPUT_HASH_MISMATCH`：上游内容已变化，回到对应阶段重验，不自行改指纹。
- `TIMELINE_INVALID`：修正 clip 时长、秒数或显示偏好；2.5 不能关闭时间轴。
- `REFERENCE_ASSET_INVALID`：修正素材身份、标签、职责或绑定。
- `REFERENCE_LIMIT_EXCEEDED`：回到规划拆分，不删除必要实体。
- `SOURCE_COVERAGE_INVALID`：修正镜头、对白、声音或覆盖关系，不补剧情。
- 两轮后仍失败：停止，保留已经写出的 PromptIR，报告完整错误。
