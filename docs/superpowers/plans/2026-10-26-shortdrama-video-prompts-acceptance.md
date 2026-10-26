# 短剧多镜头视频提示词 v2 验收记录

日期：2026-10-26

## 实现范围

- 四个运行 schema 升级到 `schema_version: 2`：run、script_analysis、shot_plan、
  prompts.ir。
- 新增版本检查、稳定内容指纹、实体/素材/过程/时间轴/对白/AudioCue/跨产物语义校验。
- 规划层级改为 `scenes[].clips[].shots[]`；内部 shot 允许小数秒，模型时长只约束
  clip 总时长。
- 渲染改为一个 clip 一份五模块提示词：【生成目标】【参考素材职责】【主体与关系】
  【事件脚本】【保持一致】。
- Seedance 2.5 强制显示秒数；Seedance 2.0 按 `display_timeline`。
- 仅剧本输入时为角色、场景、关键道具建立独立 image 占位，并在 warning 中标记待提供。
- `read_run` 在写回前拒绝 v1/混合版本；上游文字变化通过内容指纹使下游待重跑。
- 四个 Skill、README、server README、阶段约定、架构和模型规则说明已同步。
- 完成独立只读审查并修复对白秒数、MCP 根级输入、局部上游指纹、时间轴自检、required_fields、独立图片槽、全运行 ID 唯一性、错误归属和引用排序问题。

## 实际验证

在 `E:\codex-script2shot\server` 执行：

```text
npm run typecheck
npm test
```

结果：

- `npm run typecheck`：通过。
- `npm test`：构建 `server/dist/server.mjs` 成功；Vitest 37 个测试文件通过，
  462 项通过、1 项跳过、0 项失败。
- v2 fixture、五模块 golden、MCP handshake、run 生命周期、跨产物指纹和 Skill 契约均已纳入。

## 未验证范围

- 未调用图片生成、素材上传或实际视频生成。
- 未验证真实模型对秒数、多镜头剪辑和参考图职责的执行一致性。
- 未写入远端飞书知识库；旧知识卡若仍包含单镜头或禁止秒数口径，运行时以当前插件
  v2 规则优先，后续如更新远端知识需另行预览和确认。

## 已知风险

- 确定性版权校验只能验证结构、ID、时间轴和来源覆盖，不能证明完整过程一定没有被语义
  层面的误切碎；Skill 仍要求做语义审查。
- 真实参考图缺失时只交付占位草稿，不能保证最终人物、场景和道具外观一致。
- 当前环境对 `server/` 的沙箱写入曾被拒绝；最终验证在允许写入条件下完成，后续自动化
  环境需要确保 `server/dist/server.mjs` 可写。
