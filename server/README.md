# script2shot 本地 MCP Server

本目录是插件的 stdio MCP Server。Phase 1 结束时它只支持 MCP 握手和空的
`tools/list`；`health` 等工具在后续任务中注册。

## 环境要求

- Node.js >= 24（本机实测：系统 Node v26.8.2、npm 11.19.1，2026-10-20）。
- Codex 桌面端自带 Node 运行时；启动脚本会优先使用它，系统 Node 只是最后兜底。

## 安装、构建、测试

在仓库根目录执行：

```powershell
npm --prefix server install
npm --prefix server run build   # esbuild 打包为 server/dist/server.mjs
npm --prefix server test        # vitest run
```

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

## `mcp.json` 字段对照（核对日期 2026-10-20）

| 字段 | 取值 | 依据 |
| --- | --- | --- |
| `$schema` | `https://agent-plugins.org/schemas/1.0.0/mcp.schema.json` | Agent Plugins 1.0.0 MCP schema |
| `mcpServers.script2shot.type` | `"stdio"` | 同上，stdio 条目的 `type` 只能是 `stdio` |
| `mcpServers.script2shot.command` | `"./scripts/launch_script2shot_mcp"` | 可移植包中 `command` 只能是裸命令名或插件内 `./` 相对路径；Windows 上由 Codex 的 MCP 程序解析器按 `PATHEXT` 解析到同目录的 `launch_script2shot_mcp.cmd` |
| `mcpServers.script2shot.cwd` | `"${PLUGIN_ROOT}"` | 官方本地 stdio 示例使用 `${PLUGIN_ROOT}` 占位符 |

核对来源（均为 2026-10-20 读取）：

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
- 本机官方插件缓存样例 `codex-security`（2026-10-20 核对）：
  `.mcp.json` 使用 `"command": "./scripts/launch_codex_security_mcp"`，
  并在同目录提供 `launch_codex_security_mcp.cmd`。

## Phase 1 已知限制

- 未注册任何工具，`tools/list` 返回空数组；`health` 由 Task 5 实现。
- 不包含 lark-cli 路径发现、登录检查、知识库读写；Phase 1 只实现连接类能力。
- 启动依赖已构建的 `server/dist/server.mjs`，源码目录不直接运行。
