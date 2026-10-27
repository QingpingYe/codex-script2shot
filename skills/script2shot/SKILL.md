---
name: script2shot
description: script2shot v2 入口编排：接收剧本与可选参考素材，按「解析 → 视频与镜头规划 → 视频提示词」三阶段执行，逐阶段传递内容指纹，最后聚合引用与警告。
---

# script2shot

把剧本文本组织成一次 v2 run：`script_breakdown → shot_planning → shot_prompting`。
最终交付单位是一个待生成视频的一段完整提示词；一个视频可以包含多个电影镜头。

入口只做编排，不做创作、检索、校验或渲染。设计以 `docs/architecture.md` 与
`references/stage-conventions.md` 为准。

## 新 run

1. 收集参数；缺必填项时先向用户确认，不得自行假设：
   - 必填：`project_id`、`input_mode`、单一 `target_model`。任一缺失时先问用户，不得用默认值、上一次 run 的值或
     推测代替；用户同时给出多个模型时，先让用户选定一个；
   - 可选：`aspect_ratio`。未指定时先问用户；确实无法询问时才能用显式默认，并把默认值与
     来源写进 run 级 warning；
   - 可选：`input_references[]`：用户提供的参考素材、本地路径或素材标识、职责和排除范围；
   - 可选：`display_timeline`：2.0 是否显示秒数；2.5 由模型规则强制显示。
2. 刷新本地索引，按 dry-run 结果执行刷新。外部知识库只读。
3. 调用：
   `init_run({ workspace_root, input_mode, project_id, target_model, aspect_ratio, input_references, display_timeline })`。
   保存返回的 `run_id`、`run_json_path`、`run_context_hash`。没有真实素材时不要阻断，
   继续创建占位槽，由解析阶段生成 `待提供` 参考图。
4. 依次执行三个 Skill：
   - `script-breakdown`：写 `script_analysis.json`，保存 `input_hashes.run_context`；
   - `shot-planning`：写 `shot_plan.json`，保存解析产物的 `content_hash`；
   - `shot-prompting`：写 `prompts.ir.json` 与 `prompts.<model>.md`，保存解析和规划指纹。
5. 每阶段先校验，再更新 `run.json`：
   - 解析：`validate_stage_artifact({ stage: "script_breakdown", path })`；
   - 规划：`validate_stage_artifact({ stage: "shot_planning", path, script_analysis_path })`；
   - 提示词：`validate_prompt({ prompt_ir_path, shot_plan_path, script_analysis_path })`；
   - 成功返回的 `content_hash` 交给下游，不自行估算；
   - 只有校验通过后才 `update_run_state(..., status: "done")`。
6. 聚合 `knowledge_refs.json` 与 `warnings.md`，报告视频数、内部镜头数、产物路径和警告。

## 续跑

- `from <stage>`：从指定阶段重跑，保留未受影响的上游产物，重新校验所有上游。
- `only <stage>`：只重跑一个阶段，但 `only shot-prompting` 必须同时校验规划和解析。
- `read_run` 返回 `run_context_hash`，并核对四个产物的 `schema_version` 与内容指纹。
- 缺版本、v1、未来版本或混合版本一律返回 `ARTIFACT_VERSION_UNSUPPORTED`，不改写旧 run。
- 上游文字或素材职责变化但 ID/时间未变时，旧 `input_hashes` 仍应让下游变为待重跑。
- 人工只改对象键顺序不算内容变化；数组顺序变化算变化。

## 视频打包策略

- 先识别完整过程，再估算对白与动作时间，再设计内部切镜，最后才检查模型上限并拆段。
- 一个视频可以有正反打、插入特写和多段连续动作；切镜本身不是新提示词的成立理由。
- 多个互不相关的过程不要为减少条数硬塞进同一视频。
- 超过单次生成时长或图片上限时，在动作完成、短句结束、信息揭示等自然边界拆分；
  同一过程的分段保留同一 `process_id`，写清前后状态。
- 普通信息或反应镜头可使用短节奏，但必须服从原文内容、对白语速、动作难度和悬念，
  不硬套固定镜头数或固定秒数。

## 输出

七个文件名不可更改：

`run.json`、`script_analysis.json`、`shot_plan.json`、`prompts.ir.json`、
`prompts.<target_model>.md`、`knowledge_refs.json`、`warnings.md`。

每段提示词正文固定五模块：

1. 【生成目标】
2. 【参考素材职责】
3. 【主体与关系】
4. 【事件脚本】
5. 【保持一致】

Seedance 2.5 每个视觉镜头、对白片段和声音 cue 都显示秒数；2.0 默认顺序叙述，
用户开启 `display_timeline` 后再显示。

## 边界

- 不生成图片、不上传素材、不实际生成视频、不编辑或延长视频。
- 不写远端知识库。
- 不新增原文没有的剧情、台词、声音或关键道具。
- 不把参考图占位描述成已经提供；占位只表示待提供。
- 不自行解释或改码工具错误；不跳过校验继续下游。
