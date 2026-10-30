# 双宿主插件设计：同时支持 Claude Code 与 Codex

- 状态：已实施（仓库改动完成，未提交；版本 0.3.0）
- 日期：2026-10-30
- 目标版本：plugin `0.3.0`，artifact `schema_version: 2` 不变
- 需求方：让 AI 视频提示词生成师在 Claude Code（Windows 桌面端 Code tab）也能使用本插件

## 1. 结论与依据

同一仓库可以同时作为 Codex 插件与 Claude Code 插件分发：两个宿主读取各自的清单目录，
共享同一份 `skills/`。结论经两类实证（均在 2026-10-30 核对）：

- 本机 Claude Code CLI `2.1.309`：在隔离配置目录中用本仓库作为本地 marketplace
  完整走通 `plugin marketplace add` → `plugin install` → 6 个技能被识别、MCP Server
  经 `.mcp.json`（`${CLAUDE_PLUGIN_ROOT}` 指向现有 `.cmd` 启动器）连接成功（22 个工具）。
- 对照 `obra/superpowers`（本机已装 `6.3.0`，上游 `v7.0.1`）：同一仓库并存
  `.claude-plugin/`（Claude Code）与 `.agents/plugins/marketplace.json`（Codex）等
  多宿主清单目录，`skills/` 只有一份；技能正文用中性的 `superpowers:<skill>` 引用，
  harness 专属触发语法只写在 README 分节里。

## 2. 文件布局（两宿主并存）

新增（Claude Code 侧，Codex 不读取）：

| 文件 | 作用 |
| --- | --- |
| `.claude-plugin/plugin.json` | Claude Code 插件清单：`name: script2shot`、`version`、`description`、`author` |
| `.claude-plugin/marketplace.json` | 仓库自带 marketplace（`name: script2shot-git`），条目 `source: "./"`、版本与清单一致 |
| `.mcp.json` | Claude Code 的 MCP 配置：`mcpServers.core.command = ${CLAUDE_PLUGIN_ROOT}/scripts/launch_script2shot_mcp`（无扩展名，宿主解析 `.cmd`/sh） |

保留不动（Codex 侧）：根 `plugin.json`、根 `mcp.json`、`.agents/plugins/marketplace.json`。

工具全名为 `mcp__plugin_script2shot_core__<tool>`；Claude Code 用户可在 settings.json
预允许 `mcp__plugin_script2shot_core__*`（插件自身不能携带权限配置）。

版本纪律：`version` 至少同步四处——根 `plugin.json`、`.claude-plugin/plugin.json`、
`.claude-plugin/marketplace.json` 条目、`server/package.json`（含 lockfile）；MCP Server
`initialize` 汇报的版本号（`server/src/index.ts`）同步。由 `plugin_manifest` 测试断言
全部一致，防止漂移。宿主只在 `version` 变化时才更新已安装插件。

## 3. 技能文本中性化

`skills/**` 正文不再使用任何单一 harness 的触发语法（`$skill-name` 只对 Codex 有效，
`/plugin:skill` 只对 Claude Code 有效）。互相引用一律写成 `script2shot:<skill>`
（如 `script2shot:knowledge-sync`），两个宿主下都是可读的说明文本；实际触发方式由
README 分宿主说明。`skills_contract` 测试新增守卫：技能正文不得出现 `$<word>` 形式。

## 4. 分发与构建产物

`server/dist/server.mjs`（esbuild 单文件，约 1.1MB）改为入库分发：

- 任何宿主都不会为用户自动构建插件；Claude Code 只对插件**根目录**的
  `package.json` 自动装依赖，本仓库依赖在 `server/` 子目录，不适用。
- `.gitignore` 改为忽略 `server/dist/*` 但保留 `server/dist/server.mjs`；
  `.gitattributes` 为该文件固定 `text eol=lf`，保证重建后工作区字节稳定。
- 已实测本机连续两次 `npm run build` 输出 sha256 一致（确定性构建）；
  发布流程约定：改源码后必须重新构建并连同 `dist` 一起提交。

## 5. Node 运行时前置

Claude Code 不自带 Node（Codex 桌面端自带，经 `CODEX_*` 链解析）。三层保障：

1. **启动器补解析**：`scripts/launch_script2shot_mcp(.cmd)` 与
   `scripts/setup_bootstrap(.cmd)` 在 `CODEX_*` 链全部落空后，先找
   `~/.codex-script2shot/runtime/node-*/node-*/`（`ensure-runtime` 的私有运行时布局，
   亦可用 `SCRIPT2SHOT_HOME` 覆盖），再退回系统 `node`；全部缺失时报中性错误
   「未找到可用的 Node 运行时」，退出码 127。
2. **无 Node 自举**：新增 `scripts/ensure_node.ps1`（Windows）与
   `scripts/ensure_node.sh`（POSIX）。它们是 `ensure-runtime` 的"无 Node 前置形态"：
   探测 PATH 与私有运行时后，从 `https://nodejs.org/dist/` 解析 `>= 24` 的最新 LTS，
   下载平台归档、以同目录 `SHASUMS256.txt` 校验 sha256、解压到
   `<home>/runtime/node-<version>/`（与 `ensure-runtime` 同一布局），输出 JSON。
   仅供 `setup` 技能在启动器报 127 时由 AI 调用；MCP 启动器**不得**自动下载。
3. **进程运行时复用**：`doctor` 与 `ensure-runtime` 在系统 `node` 探测失败时，
   若当前进程自身（`process.execPath` + 同目录 npm）满足 `>= 24`，报
   `source: "process"` 复用，避免 Claude Code 场景重复下载。测试可用
   `allow_process_runtime: false` 关闭该回退。

## 6. 兼容性

- Codex 侧：根 `plugin.json` / `mcp.json` / `.agents/` 内容不动（仅版本号递增）；
  启动器改动是追加式（`CODEX_*` 解析顺序保持第一优先）；技能正文的中性引用对
  Codex 只是说明文字，不改变其触发行为。
- 产物契约：`schema_version: 2`、七个运行文件名、MCP 工具名全部不变。
- 本地数据目录名保持 `~/.codex-script2shot`（沿用 `SCRIPT2SHOT_HOME` 覆盖），
  不因宿主改名，避免迁移成本。

## 7. 验证（2026-10-30 实测）

- `npm run typecheck`：通过。
- `npm test`（37 个测试文件）：**483 通过、1 跳过、0 失败**。新增覆盖：
  `.claude-plugin` 清单格式与版本同步（5 处版本一致 + MCP Server 汇报版本）、
  `.mcp.json` 形状（无 `cwd`、无 `type`）、技能正文无宿主专属触发语法、
  四个启动器包装的无 Node 提示与 `ensure_node` 助手存在性、
  `ensure-runtime` 的进程回退与私有运行时复用、`doctor` 的进程运行时识别。
- `claude plugin validate .`（CLI 2.1.309）：✔ 通过；仅剩两条"插件目录提交"检查
  （LICENSE 缺失、icon 缺失），只影响向官方插件目录提交，不影响本地 / 私有
  marketplace 分发。
- 真实安装演练（隔离 `CLAUDE_CONFIG_DIR`）：`plugin marketplace add E:\codex-script2shot`
  → `plugin install script2shot@script2shot-git` 成功；`plugin details` 显示
  Skills (6) 与 MCP servers (1) `core`；`mcp list` 显示
  `plugin:script2shot:core - ✔ Connected`。注：工作区内的 `tmp/`（gitignored）
  含符号链接，本地目录安装会被 EPERM 拒绝；`tmp/` 移开后安装通过，git 分发不受影响。
- 私有运行时回退（PATH 无 node，注入假 `SCRIPT2SHOT_HOME`）：
  - `.cmd` 启动器回退成功（握手返回 `serverInfo.version = 0.3.0`、22 个工具）；
  - POSIX 启动器由假 node 标记文件确认真实走了私有分支（需隔离 `XDG_CACHE_HOME`，
    否则优先命中本机残留的旧 Codex 缓存运行时——属预期优先级）；
  - `ensure_node.ps1`：系统 `node` 复用与私有运行时复用两条路径均返回正确 JSON；
    **必须携带 UTF-8 BOM**（Windows PowerShell 5.1 无 BOM 时按 ANSI 解析中文注释而报错）；
  - `ensure_node.sh`：私有运行时复用返回正确 JSON。
- 未验证：桌面端 Code tab 图形化安装的点击路径；无 Node 机器上 `ensure_node`
  的真实下载链路（仅验证了复用分支，下载分支逻辑与 `ensure-runtime` 同构且有
  单测覆盖）。
