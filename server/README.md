# script2shot 本地 MCP Server

本目录是插件的 stdio MCP Server。当前支持 MCP 握手，`tools/list` 已注册 10 个工具：
`health`、`write_config`、`init_knowledge_b`、`scan_knowledge_a`、`read_sync_state`、
`build_sync_plan`、`fetch_knowledge_a_doc`、`replace_doc_cards`、`update_doc_sync_state`、
`delete_doc_cards`；检索与阶段工具待 Phase 3+ 注册。

## 环境要求

- Node.js >= 24（本机实测：系统 Node v26.8.2、npm 11.19.1，2026-10-20）。
- Codex 桌面端自带 Node 运行时；启动脚本会优先使用它，系统 Node 只是最后兜底。
- `package.json` 的 `"engines": {"node": ">=24"}` 是安装和运行时的最低版本约束。

## 安装、构建、测试

在仓库根目录执行：

```powershell
npm --prefix server install
npm --prefix server run typecheck   # tsc --noEmit
npm --prefix server run build   # esbuild 打包为 server/dist/server.mjs
npm --prefix server test        # vitest run
```

验证顺序固定为 `typecheck → build → test`。

构建产物 `server/dist/` 和依赖目录 `server/node_modules/` 不入库；
`server/package-lock.json` 入库。

握手测试通过启动脚本拉起真实 stdio Server，因此请先构建再测试。
`skills_contract` 在 `skills/*/SKILL.md` 尚未创建时跳过（Task 6 后生效）。

## 本地启动

Windows：

```powershell
cmd.exe /d /c scripts\launch_script2shot_mcp.cmd
```

POSIX：

```sh
sh scripts/launch_script2shot_mcp
```

POSIX 脚本带可执行位，也可以直接执行 `./scripts/launch_script2shot_mcp`。

两个启动脚本按同一顺序定位 Node 运行时：

1. `CODEX_MCP_NODE_PATH`
2. `CODEX_ELECTRON_RESOURCES_PATH/cua_node`
3. `CODEX_CLI_PATH` 同级的 `cua_node`
4. `~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node`
5. 系统 `node`

全部缺失时输出「请更新 Codex 或安装 Node.js >= 24」并以 127 退出。
`server/dist/server.mjs` 不存在时输出构建提示并退出（提示包含
`npm --prefix server run build`）。

## `mcp.json` 字段对照（核对日期 2026-10-21）

| 字段 | 取值 | 依据 |
| --- | --- | --- |
| `$schema` | `https://agent-plugins.org/schemas/1.0.0/mcp.schema.json` | Agent Plugins 1.0.0 MCP schema |
| `mcpServers.script2shot.type` | `"stdio"` | 同上，stdio 条目的 `type` 只能是 `stdio` |
| `mcpServers.script2shot.command` | `"./scripts/launch_script2shot_mcp"` | 可移植包中 `command` 只能是裸命令名或插件内 `./` 相对路径；Windows 上由 Codex 的 MCP 程序解析器按 `PATHEXT` 解析到同目录的 `launch_script2shot_mcp.cmd` |
| `mcpServers.script2shot.cwd` | `"${PLUGIN_ROOT}"` | 官方本地 stdio 示例使用 `${PLUGIN_ROOT}` 占位符 |

核对来源（均为 2026-10-21 读取）：

- OpenAI Docs：Package your plugin
  https://developers.openai.com/plugins/build/plugins
  （可移植布局 = 根目录 `plugin.json` + `mcp.json`；OpenAI 专属字段放
  `extensions.com.openai`。）
- OpenAI Docs：Submit desktop-only plugins
  https://developers.openai.com/plugins/deploy/desktop-only
  （本地 stdio 条目使用 `type` / `command` / `args` / `cwd`，`${PLUGIN_ROOT}`
  是内置占位符；本地 stdio 插件属于 desktop-only。）
- Agent Plugins 1.0.0 MCP schema
  https://agent-plugins.org/schemas/1.0.0/mcp.schema.json
  （`stdioServer` 只允许 `type`、`command`、`args`、`env`、`cwd`。）
- openai/codex `main` 分支源码
  `codex-rs/codex-mcp/src/agent_plugin_config.rs`（可移植 `mcp.json` 的
  `./` 相对 `command` 会解析到插件根目录）与
  `codex-rs/rmcp-client/src/program_resolver.rs`（Windows 用 `which` +
  `PATHEXT` 解析无扩展名命令，因此无扩展名的启动脚本在 Windows 上会命中
  同名的 `.cmd`）。
- 本机官方插件缓存样例 `code-review` 与 `codex-app-tools`（2026-10-21 核对）：
  `code-review` 的 `.mcp.json` 使用显式 `cmd.exe` 调用
  `"args": ["/d", "/c", "scripts\\launch_code_review_mcp.cmd"]`；
  `codex-app-tools` 使用
  `"args": ["/d", "/s", "/c", "call", "./scripts/launch_codex_app_tools_mcp.cmd", "./server.mjs"]`。
  两者都是 Codex 兼容布局，并在同目录提供对应的 `.cmd` 启动脚本。

## Base 日期字段换算（Task 1 决定）

- `updated_at`、`last_synced_at` 在逻辑模型中为 ISO 8601；写入飞书 Base 的
  datetime CellValue 时固定换算为 `YYYY-MM-DD HH:mm`（不带秒），读回时还原为
  带 `+08:00` 偏移的 ISO 8601。
- Base datetime 写入用 `YYYY-MM-DD HH:mm`（+08:00 墙钟）、读回可能是 ISO 8601
  （含毫秒与偏移），映射层统一按时间点换算回 `+08:00` ISO。
- 换算首版固定按 `+08:00` 墙钟时间处理，不读取系统时区；换算函数集中放在
  `server/src/base_mapping.ts`（`iso8601_to_base_cell`、`base_cell_to_iso8601`），
  其他模块不得自行实现时间换算。
- Base datetime 单元格只保留分钟精度，写入时秒被截断；`obj_edit_time` 是不透明
  字符串，原样进出，不做任何时间换算。

## 已知限制

- 已注册上列 10 个工具（健康检查、配置写入、知识库 B 初始化与知识库同步）；
  检索与阶段工具由 Phase 3+ 注册。
- 启动依赖已构建的 `server/dist/server.mjs`，源码目录不直接运行。
