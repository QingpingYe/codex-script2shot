# 模型规则说明（v2）

核对日期：2026-10-27

本文记录 `rules/models/*.json` 的运行时事实来源和 v2 语义。模型规则文件是时长、画幅、
参考素材上限和时间轴强制的唯一运行时来源；Skill 不复制硬边界。

## 1. 外部来源

- Seedance 2.5 官方教程：<https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh>
  - 单次输出时长 4–30 秒；
  - 参考图片最多 30 张。
- Seedance 2.0 官方教程与提示词指南：
  <https://docs.volcengine.com/docs/ark/seedance-2-0?lang=zh>、
  <https://docs.volcengine.com/docs/ark/seedance-2-0-prompt-guide?lang=zh>、
  <https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh>
  - 单次输出时长 4–15 秒；
  - 参考图片最多 9 张。
- Seedance 2.5 提示词指南（2026-10-27 核对）：<https://docs.volcengine.com/docs/ark/seedance-2-5-prompt-guide?lang=zh>，其中时间戳以 1 秒为单位，2.5 响应整数秒时间戳。
- 上述模型限制作用于一次生成，不限制一个视频内部的电影镜头数量；插件统一要求 clip、shot、对白和 AudioCue 使用整数秒，这是插件一致性规则，不能写成两个模型的共同官方限制。

## 2. 规则文件字段

| 字段 | Seedance 2.0 | Seedance 2.5 | 含义 |
| --- | --- | --- | --- |
| `duration.min_sec` / `max_sec` | 4 / 15 | 4 / 30 | clip 总时长边界 |
| `reference_limits.max_images` | 9 | 30 | 单个 clip 最多图片素材数 |
| `timeline.required_in_prompt` | false | true | 是否强制显示结构化秒数 |
| `shot_split.prefer_max_sec` | 15 | 30 | 规划阶段建议的单段上限 |
| `render.clip_heading` | 视频标题模板 | 视频标题模板 | 一个 clip 一份提示词 |
| `render.section_order` | 五模块 | 五模块 | 固定顺序见下 |

五模块：

1. `generation_goal` → 生成目标
2. `reference_duties` → 参考素材职责
3. `subjects_relations` → 主体与关系
4. `event_script` → 事件脚本
5. `consistency` → 保持一致

## 3. 时长语义

- 模型 `duration` 只校验 clip 总时长，要求整数秒。
- `shot.start_sec` / `shot.end_sec`、对白和 AudioCue 时间都是整数秒；校验使用精确相等，不使用小数容差。
- 内部视觉轨从 0 连续覆盖到 clip 总时长，最后一镜结束时间精确等于 clip 总时长。
- 短于模型下限的完整过程只能通过原文已有动作或可见结束状态的合理停留满足；
  不能新增剧情或强行拼接无关过程。
- 超过上限时优先在动作完成、短句结束、信息揭示等自然节点拆分；同一过程保留
  `process_id`，并用 `previous_clip_id`、进入/离开状态说明承接。

## 4. 参考素材

- 仅剧本输入时，每个角色、场景和关键道具各建至少一个 image 占位。
- `placeholder` 不写 source；`provided` 必须有用户提供的本地路径或素材标识。
- 每段视频只绑定本段涉及实体，素材 `asset_id` 跨视频稳定，本段 `tag` 可重新编号。
- 参考职责必须同时说明 `adopt[]` 与 `exclude[]`。
- 超过 max_images 时先按自然过程边界拆段；不可拆场面仍超限则报告冲突。

## 5. 时间轴与声音

- 2.5：每个 shot、对白片段、AudioCue 必须显示秒数。
- 2.0：默认按镜头顺序描述；`display_timeline: true` 时显示每轨秒数。
- 2.5 的强制时间轴不能被知识卡或普通风格偏好关闭。
- 对白使用 UTF-16 半开 offset，跨视频片段按自然句界拆分，拼接后逐字还原原文。
- 全程环境声/音乐覆盖 0 到 clip 总时长；瞬时音效使用具体短区间，来源可回指。

## 6. 模板与安全

- 五模块名称和顺序不可改变。
- 台词使用 `{}`，音效使用 `<>`，音乐使用 `()`；台词不参与禁止项扫描。
- 画面内容优先正向描述；负面约束只写素材职责、编辑范围或容易误带入内容。
- 不输出工程参数（如 `--ar`、`aspect_ratio`、`fps`、`resolution`），不自动加水印、
  字幕或质量包。
