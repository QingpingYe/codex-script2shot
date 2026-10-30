# codex-script2shot

把剧本转换成 AI 视频生成提示词的插件，同时支持 Codex 与 Claude Code（同一仓库、
同一套技能与 MCP Server，两个宿主各读各自的清单）。当前 v2 面向短剧：最终交付单位是
一个待生成视频的一段提示词，一个视频可以包含多个电影镜头。

## 安装

Claude Code（含桌面端 Code tab；图形入口：输入框旁 **+ → Add plugins**）：

```bash
claude plugin marketplace add QingpingYe/codex-script2shot && claude plugin install script2shot@script2shot-git
```

Codex：在 Codex 应用中打开 Plugins 侧栏，选择本仓库的 marketplace（`.agents/plugins/marketplace.json`），在 Coding 分类下安装 `Script2Shot`。

首次使用前运行一次安装引导（Claude Code 里输入 `/script2shot:setup`，Codex 里输入
`$setup`）：AI 会自动完成环境自举、lark-cli 安装、登录与配置写入，人类只做浏览器
授权和一次写入确认。Claude Code 不自带 Node 运行时时，引导会先自动补装私有 Node。

## 主流程

```text
剧本 + 可选参考素材
  → script-breakdown
      script_analysis.json：实体、参考图占位、原文单元、完整过程、run_context 指纹
  → shot-planning
      shot_plan.json：scenes[].clips[].shots[]、秒数、对白轨、AudioCue、script_analysis 指纹
  → shot-prompting
      prompts.ir.json + prompts.<model>.md：五模块视频提示词
  → knowledge_refs.json + warnings.md
```

一个完整过程默认保留在一个视频中。切镜不是拆分理由；只有超过模型时长或图片上限时，
才在自然节点拆分并交代前后状态。所有 clip、shot、对白和声音 cue 的时间边界都使用
整数秒；镜头时长按节拍估算，超过 6 秒的 shot 必须写 `long_take_reason`。

## 五模块

每段正文固定：

1. 【生成目标】
2. 【参考素材职责】
3. 【主体与关系】
4. 【事件脚本】
5. 【保持一致】

- Seedance 2.5：每个内部镜头、对白片段和声音 cue 必须带秒数。
- Seedance 2.0：默认顺序叙述，`display_timeline` 默认为 false，用户开启后显示秒数。
- 视频宽高比默认 9:16；Seedance 2.5 固定显示秒数。
- 仅剧本输入：为每个角色、场景、关键道具分别建立 image 占位，标记“待提供”。

## 主要能力

- `script-breakdown`：实体台账、参考素材槽、动作/情绪/对白单元、完整过程。
- `shot-planning`：过程 → 视频 clip → 内部 shot；对白分片和 AudioCue 时间轴。
- `shot-prompting`：五模块 PromptIR 和确定性 Markdown 渲染。
- `script2shot`：三阶段编排、内容指纹交接、v1 拒绝续跑、引用和 warning 聚合。
- 本地 MCP Server：知识检索、运行目录、schema/语义校验、渲染与聚合。

## 运行产物

输出到 `<workspace>/.script2shot/outputs/<run_id>/`：

```text
run.json
script_analysis.json
shot_plan.json
prompts.ir.json
prompts.<model>.md
knowledge_refs.json
warnings.md
```

## 版本与续跑

- 四个基础产物使用 `schema_version: 2`。
- 旧 run、未来版本或版本混杂返回 `ARTIFACT_VERSION_UNSUPPORTED`，不自动迁移。
- `read_run` 核对运行上下文和内容指纹；上游文字变化会使下游待重跑，即使 ID/时间未变。
- 支持 `from <stage>` 与 `only <stage>`，但每个阶段都要重新校验上游。

## 文档

- [总体架构](docs/architecture.md)
- [阶段约定](references/stage-conventions.md)
- [模型规则说明](docs/model-rules-notes.md)
- [本轮设计与计划](docs/superpowers/specs/2026-10-26-shortdrama-video-prompts-design.md)
- [双宿主设计（Claude Code + Codex）](docs/superpowers/specs/2026-10-30-claude-code-dual-harness-design.md)

## 权限（Claude Code）

插件自身的 MCP 工具默认需要批准。若要减少确认次数，可在 `~/.claude/settings.json`
预允许（工具全名为 `mcp__plugin_script2shot_core__<tool>`）：

```json
{ "permissions": { "allow": ["mcp__plugin_script2shot_core__*"] } }
```

## 边界

本轮不生成图片、不上传素材、不实际生成视频、不写远端知识库；不新增原文没有的剧情、
台词、声音或关键道具。占位参考图不等于图片已提供。
