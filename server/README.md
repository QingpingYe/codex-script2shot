# script2shot MCP Server（v2）

本地 MCP Server 提供知识库同步、检索、运行目录、阶段校验和提示词渲染工具。
LLM 创作仍由四个 Skill 承担。

## 运行工具

- `init_run`：创建 v2 run；未提供 `aspect_ratio` 时默认 9:16，未提供 `display_timeline` 时默认 false；
  保存 `input_references`，返回 `run_context_hash`。
- `read_run`：先拒绝旧/混合版本，再校验三阶段产物、身份和内容指纹；返回
  `run_context_hash`，上游变化时把下游标为待重跑。
- `update_run_state`：只更新阶段状态与 warning，不改运行输入。

## 阶段与提示词工具

- `validate_stage_artifact`：
  - `script_breakdown` 校验 v2 解析语义，成功返回 `content_hash`；
  - `shot_planning` 接受可选 `script_analysis_path`，校验 clip 时长、内部镜头时间轴、
    对白、声音和参考图上限，成功返回 `content_hash`。
- `validate_prompt`：接受可选 `shot_plan_path`、`script_analysis_path`，校验 v2 PromptIR、
  五模块数据、素材标签、上游指纹和模型规则。错误形状为
  `{ clip_id, shot_id, field, code, message }`；无归属 ID 用空字符串。
- `render_prompt`：一个 clip 输出一份五模块 Markdown。2.5 强制秒数，2.0 按
  `display_timeline`；失败时不创建或覆盖输出文件。

## 聚合

- `aggregate_knowledge_refs`：解析、规划和 PromptIR 引用统一带 `clip_id`；PromptIR
  共用引用 `shot_id: null`，按视频和镜头顺序聚合。
- `write_warnings`：汇总运行 warning 与解析 `missing_info`。

## 验证

```text
npm run typecheck
npm run build
npm test
```

`server/dist/server.mjs` 是本地启动器使用的构建产物；当前环境首次迁移前曾因沙箱写入
权限拒绝构建，需要在允许写入 `server/dist` 的条件下运行构建验证。
