# 阶段约定（v2）

状态：Implemented
日期：2026-10-26
最近修订：2026-10-26（短剧多镜头视频提示词 v2）

本文件是 `script2shot` 入口和三个创作阶段共同遵守的交接约定。架构冲突时以
`docs/architecture.md` 为准。

## 1. 阶段与产物

| 阶段 key | Skill | 产物 |
| --- | --- | --- |
| `script_breakdown` | `script-breakdown` | `script_analysis.json` |
| `shot_planning` | `shot-planning` | `shot_plan.json` |
| `shot_prompting` | `shot-prompting` | `prompts.ir.json`、`prompts.<model>.md` |

运行目录仍是 `.script2shot/outputs/<run_id>/`，七个运行文件名不变。
四个基础产物均带 `schema_version: 2`；缺少版本、版本 1、未来版本或混合版本均拒绝
续跑，返回 `ARTIFACT_VERSION_UNSUPPORTED`。

内容指纹使用 Node 内置 SHA-256，对 JSON 递归排序对象键、保留数组顺序。阶段成功时
`validate_stage_artifact` 返回 `content_hash`；入口返回 `run_context_hash`。代理不得自行
计算或修改这些指纹。

## 2. 阶段交接

- 只通过文件产物、适用知识包和模型规则交接，不依赖会话上下文。
- 运行阶段前先校验所有上游产物；人工修改上游后必须重新校验。
- 解析产物保存 `input_hashes.run_context`。
- 规划产物保存 `input_hashes.script_analysis`。
- PromptIR 保存 `input_hashes.script_analysis` 与 `input_hashes.shot_plan`。
- `read_run` 在任何状态写回前检查版本和跨产物链接；上游内容变化时，受影响下游标记
  为待重跑并保留原文件供检查。
- 阶段失败不把该阶段写成 `done`，不进入下游。

## 3. 数据层级

```text
script_analysis.episodes[].scenes[].processes[]
  → shot_plan.scenes[].clips[].shots[]
  → prompts.ir.clips[].shots[]
```

- `process` 是一个完整叙事过程。
- `clip` 是一个待生成视频，可以包含多个内部 `shot`。
- `shot` 是视频内部电影镜头。
- clip 的 `duration_sec` 是模型单次生成时长，使用整数秒。
- 内部 shot 使用正数秒区间，允许小数秒，不受模型最小生成时长单独限制。

## 4. 解析产物

`script_analysis.json` 顶层包含：

- `entities[]`：角色、场景、关键道具；稳定 `entity_id`，跨场次复用。
- `reference_assets[]`：image/video/audio；placeholder 不伪造 source；provided 必须有
  source；每个素材写 `entity_ids`、`adopt`、`exclude`。
- 每个场景的 `processes[]`，以及带 `entity_ids[]` 的 action/emotion/dialogue units。
- `input_hashes.run_context`、连续性、missing_info 和 knowledge_refs。

仅剧本输入时，每个角色、场景和关键道具至少有一个 image 占位。不能用群像占位替代
多个角色。

## 5. 规划产物

`shot_plan.json` 使用 `scenes[].clips[].shots[]`。

clip 包含身份、过程、总时长、实体、参考素材、前后连续性、拆分原因、内部镜头、对白轨
和三轨 AudioCue。shot 包含内部秒数区间、景别/机位/运镜/转场、切镜目的、动作/情绪来源
和进入/离开状态。

规划顺序固定为：

```text
完整过程 → 对白与动作时间 → 内部切镜 → 模型上限检查 → 自然节点拆段
```

切镜本身不是新视频的理由。

## 6. PromptIR 与渲染

`prompts.ir.json` 顶层为 `clips[]`，每个 clip 是一份视频提示词。PromptIR 包含：

- `display_timeline`；
- `generation_goal`；
- `reference_bindings[]` 和本段标签；
- `subjects_and_relations`；
- 多镜头 `shots[]`；
- 对白轨、AudioCue、连续性、风格和 negative_prompt。

渲染正文严格使用五模块且顺序固定：

1. 【生成目标】
2. 【参考素材职责】
3. 【主体与关系】
4. 【事件脚本】
5. 【保持一致】

Seedance 2.5 强制显示秒数，每条视觉镜头、对白分片和 AudioCue 都有自己的区间。
Seedance 2.0 默认顺序叙述；`display_timeline` 为 true 时显示秒数。五模块之外可显示视频
ID、总时长、画幅和素材待提供提示。

## 7. 检索配方

- `script-breakdown`：开场方法论、首次出现的角色/场景/道具；不做目标模型过滤。
- `shot-planning`：按场景和过程检索；需要时补充内部镜头上下文；必须按 `target_model`
  过滤。
- `shot-prompting`：优先按 clip 组织共享上下文，必要时逐镜头补充；避免同一知识卡
  在多个镜头重复装载；必须按 `target_model` 过滤。
- 允许分类和来源预算继续遵守 `docs/architecture.md` §10。
- 用户本轮结构、秒数和视频打包要求优先于冲突的旧经验卡；本轮不自动写远端知识库。

## 8. knowledge_refs

每个阶段把本阶段引用写进自己的主产物。引用字段为：

```json
{
  "card_id": "src:doc-token:category:001",
  "scene_id": "ep01-sc01",
  "clip_id": "ep01-sc01-c01",
  "shot_id": "ep01-sc01-c01-s01",
  "query": "查询词",
  "usage": "used",
  "source_doc_token": "doc-token",
  "source_path": "项目知识/demo/...",
  "source_revision": 12,
  "last_synced_at": "2026-10-26T12:00:00+08:00"
}
```

- 解析阶段：`clip_id: null`、`shot_id: null`。
- 规划阶段：视频级引用可有 `clip_id`，`shot_id` 可为 null。
- PromptIR：`clip_id` 必填，视频共用引用 `shot_id: null`，镜头引用保留 shot ID。
- 聚合顺序：阶段固定顺序 → clip 顺序 → shot 顺序；同阶段重跑整体替换。

## 9. 输出与 warning

入口在三阶段完成后生成 `knowledge_refs.json` 和 `warnings.md`。warning 只追加，不覆盖；
`write_warnings` 汇总运行级 warning 与解析 `missing_info`。参考图待提供是 warning，不是
阻断错误。

## 10. 失败码与处理

- `ARTIFACT_VERSION_UNSUPPORTED`：旧 run 或版本混杂；不改写原文件。
- `INPUT_HASH_MISMATCH`：上游内容已变化；从受影响阶段重跑。
- `TIMELINE_INVALID`：clip 时长、内部镜头连续覆盖、对白/声音区间或 display timeline
  不合法。
- `SOURCE_COVERAGE_INVALID`：原文单元、过程、镜头、对白或声音来源覆盖不完整。
- `REFERENCE_ASSET_INVALID`：参考素材身份、状态、实体绑定或职责不合法。
- `REFERENCE_LIMIT_EXCEEDED`：单视频图片数超过模型上限；先按自然过程边界拆分。

确定性校验不能证明模型会严格按秒或按镜头执行；完整过程是否被无故切碎、语速与拆分点
是否自然，仍需语义审查。
