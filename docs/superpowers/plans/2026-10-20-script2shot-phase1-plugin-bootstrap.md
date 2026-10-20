# Phase 1：插件骨架与飞书连接 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal：** 让插件能被 Codex 本地加载，用户跑通 `$setup` 后 `health` 能完成 lark-cli 路径发现、登录检查、知识库 A/B 连接检查和本地目录初始化。

**Architecture：** 根目录 `plugin.json` + `mcp.json`（可移植布局，官方依据见大纲 §6.5）+ `skills/setup/SKILL.md` + `server/` 下的 MCP Server。MCP Server 通过子进程调用 `lark-cli`，本阶段只实现连接类确定性能力，不写知识库。

**Tech Stack：** Node.js >= 24 + TypeScript；esbuild 打包为 `server/dist/server.mjs`；vitest（`vitest run`）；`node:sqlite`（Phase 3 使用）。已于 2026-10-20 确认并写入架构 §7.1。

**Spec：** `docs/architecture.md` §7（插件组成、本地数据目录、本地配置）、§8（MCP Tool）、§9.1（setup）、§14 Phase 1；依据大纲见 `docs/superpowers/plans/2026-10-20-script2shot-implementation-outline.md`。

**前置：** 无。本阶段 Task 1 是唯一允许先于技术栈确认存在的任务。

## Global Constraints

- 不写代码前先确定技术栈并写回 `docs/architecture.md` §7.1（架构 §7.1、设计复盘 R-11）。
- 插件不写知识库 A；本阶段任何工具都不得出现对 A 的写操作（架构 §1.1-10）。
- 外部写操作默认 dry-run；本阶段唯一的本地写操作（config.toml、目录创建）也要先展示将写入的内容。
- 不提交密钥与 token；fixture 中的真实 token 必须替换为占位值（AGENTS.md §3）。
- 面向人的文档用中文；代码、标识符、路径用英文（AGENTS.md §3）。
- 本阶段不实现知识库 B 的建表与同步（Phase 2），`health` 对索引状态只报告 `not_built`。

## Review Focus

1. `LARK_CLI_PATH` 指向不存在的路径：应继续按顺序回退到配置、PATH、常见目录，最终给出可操作的错误，而不是直接崩溃（Task 4 用例 `resolver.falls_back_when_env_path_invalid`）。
2. 登录已过期：`health` 必须返回 `AUTH_REQUIRED` 和 `lark-cli auth login` 指引，整体 `ok=false`（Task 5 用例 `health.fails_with_login_hint_when_auth_missing`）。
3. 配置缺失或损坏：缺失时给 `CONFIG_MISSING` 且绝不创建或覆盖用户文件；损坏时给 `CONFIG_INVALID` 并指出文件路径（Task 3 用例 `load_config reports missing file without creating it`、`load_config reports invalid toml with file path`）。
4. Windows 下 lark-cli 安装路径或用户名含空格、中文：子进程必须用参数数组调用，不做字符串拼接（Task 4 用例 `process.spawns_with_argument_array_for_paths_with_spaces`）。
5. `mcp.json` 指向尚未构建的启动产物：握手必须给出「请先构建」的明确错误，README 写明构建步骤（Task 2 用例 `handshake fails with build hint when dist missing`）。

---

### Task 1: 技术栈决策与文档同步（已完成，2026-10-20）

**Files:**
- Modify: `docs/architecture.md`（§7.1）
- Modify: `docs/superpowers/plans/*.md`
- Test: `rg "<(ext|test-ext|test-cmd|build-cmd|run-cmd)>" docs/superpowers/plans/`

**Interfaces:**
- Consumes: 大纲 §2 绑定表。
- Produces: 架构 §7.1 技术栈决策块（Node.js >= 24、esbuild 单文件、启动脚本、vitest、`node:sqlite`、目录补充）；计划文件中已展开的扩展名与命令。

- [x] **Step 1: 决策已确认** —— 2026-10-20 用户确认 Node.js + TypeScript。
- [x] **Step 2: 写入 `docs/architecture.md` §7.1** —— 语言与运行时、构建与启动方式、Node 解析顺序、测试命令、`node:sqlite`、`scripts/` 等目录补充。
- [x] **Step 3: 展开计划占位符** —— `.ts`、`.test.ts`、`npm --prefix server test --`、`npm --prefix server run build`、启动脚本 `scripts/launch_script2shot_mcp.cmd` / `scripts/launch_script2shot_mcp`。
- [x] **Step 4: 验证无残留占位符**

Run: `rg "<(ext|test-ext|test-cmd|build-cmd|run-cmd)>" docs/superpowers/plans/`
Expected: 无输出。（2026-10-20 执行）

- [ ] **Step 5: Commit**

```bash
git add docs/
git commit -m "docs: record MCP server stack decision and expand phase plans"
```

### Task 2: 插件清单与最小 MCP Server

**Files:**
- Create: `plugin.json`
- Create: `mcp.json`
- Create: `.gitignore`
- Create: `server/README.md`
- Create: `server/package.json`（scripts：`build`、`test`；依赖按架构 §7.1）
- Create: `scripts/launch_script2shot_mcp.cmd`、`scripts/launch_script2shot_mcp`
- Create: `server/src/index.ts`
- Create: `server/tests/mcp_handshake.test.ts`
- Create: `server/tests/plugin_manifest.test.ts`
- Create: `server/tests/skills_contract.test.ts`
- Create: `server/tests/fixtures/`（目录，Task 7 放入录制样例）

**Interfaces:**
- Consumes: Task 1 的绑定表结论。
- Produces: `plugin.json`（`name=script2shot`、semver `version`、`extensions.com.openai.onboardingSkill` 指到 `./skills/setup/SKILL.md`）；`mcp.json`（`mcpServers.script2shot`，`type` 为本地 stdio transport）；启动脚本可拉起的 stdio MCP Server（`tools/list` 可响应）。

- [ ] **Step 1: 写失败的清单测试**

`plugin_manifest`：解析 `plugin.json`，断言 `name=="script2shot"`、`version` 匹配 semver、`description` 非空、`$schema` 为 `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`；解析 `mcp.json`，断言存在 `$schema` 与 `mcpServers.script2shot`，且 `mcpServers.script2shot.type` 非空、命令路径最终落到 `server/` 内；断言 `skills/` 目录存在。

```text
test("plugin manifest declares identity, mcp server and skills path")
test("mcp server entry command stays inside the plugin root")
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm --prefix server test -- plugin_manifest`
Expected: FAIL —— `plugin.json` 不存在。

- [ ] **Step 3: 写失败的握手测试**

`mcp_handshake`：以子进程启动平台对应的启动脚本（Windows：`cmd /d /c scripts\launch_script2shot_mcp.cmd`；POSIX：`sh scripts/launch_script2shot_mcp`），完成 stdio MCP `initialize`，再发 `tools/list`，断言返回结构合法；并写补充用例：当构建产物不存在时，启动失败信息包含构建提示。

```text
test("stdio server completes initialize and returns tool list")
test("handshake fails with build hint when dist missing")
```

- [ ] **Step 4: 实现清单与最小 Server**

按官方可移植布局创建 `plugin.json`、`mcp.json`（本地 stdio server 的确切字段以 https://developers.openai.com/plugins/deploy/desktop-only 与 `mcp.schema.json` 为准，实施时把核对日期写进 `server/README.md`；若该布局不支持本地 stdio，则改用 Codex 兼容布局 `.codex-plugin/plugin.json` + `.mcp.json`，并在同一提交内更新架构 §7.1）。Server 只注册 MCP 初始化与空的 `tools/list`。

同时创建两个启动脚本，按官方启动脚本顺序定位 Node（`CODEX_MCP_NODE_PATH` -> `CODEX_ELECTRON_RESOURCES_PATH/cua_node` -> `CODEX_CLI_PATH` 同级 `cua_node` -> `~/.cache/codex-runtimes/.../node` -> 系统 `node`），全部缺失时输出「请更新 Codex 或安装 Node.js >= 24」；启动目标为 `server/dist/server.mjs`。

`skills/` 先建目录并放 `skills/setup/.gitkeep` 之外的占位由 Task 6 完成；本任务只保证目录存在。

- [ ] **Step 5: 写失败的技能契约测试**

`skills_contract`：扫描 `skills/*/SKILL.md`，断言 YAML frontmatter 的 `name` 与目录名一致、`description` 非空。

```text
test("every skill has matching name and non-empty description")
```

- [ ] **Step 6: 运行全部测试**

Run: `npm --prefix server run build`；`npm --prefix server test`
Expected: `mcp_handshake` 与 `plugin_manifest` PASS；`skills_contract` 在 Task 6 前允许 SKIP（目录为空）。

- [ ] **Step 7: 写 `server/README.md` 与 `.gitignore`**

README 写清 Node >= 24 要求、构建、测试、本地启动命令（两个启动脚本的用法）、`mcp.json` 字段对照官方文档的核对日期和本阶段的已知限制；`.gitignore` 覆盖 `.script2shot/`、构建产物、依赖目录和日志。

- [ ] **Step 8: Commit**

```bash
git add plugin.json mcp.json .gitignore server/ skills/
git commit -m "feat: add plugin manifests and minimal stdio MCP server"
```

### Task 3: 本地配置模块

**Files:**
- Create: `server/src/config.ts`
- Create: `server/tests/config.test.ts`

**Interfaces:**
- Consumes: Task 2 的项目骨架。
- Produces: `resolve_home()`（`SCRIPT2SHOT_HOME` 覆盖 `~/.codex-script2shot`）；`load_config() -> { exists: false } | { exists: true, config, warnings[] } | error(CONFIG_INVALID)`；`save_config(config, { dry_run }) -> { dry_run, path, diff }`；`ensure_local_dirs() -> { created[], home }`（创建 `cache/`、`index/`、`logs/`）。配置字段与架构 §7.3 一致：`lark.cli_path`、`lark.profile`、`lark.space_a`、`lark.base_b`、`lark.knowledge_cards_table_id`、`lark.sync_state_table_id`、`retrieval.default_top_k`（默认 12）。

- [ ] **Step 1: 写失败测试**

```text
test("resolve_home honours SCRIPT2SHOT_HOME override")
test("load_config reports missing file without creating it")
test("load_config reports invalid toml with file path")
test("save_config dry run returns diff and writes nothing")
test("config roundtrip preserves lark and retrieval sections")
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm --prefix server test -- config`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现最小模块**

写盘用临时文件 + 原子替换；`load_config` 对缺字段只补默认值并写 warning，不猜测必填项。

- [ ] **Step 4: 运行并确认通过**

Run: `npm --prefix server test -- config`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/src/config.* server/tests/config.*
git commit -m "feat: add local config module"
```

### Task 4: lark-cli 发现、版本与能力探测

**Files:**
- Create: `server/src/lark_cli.ts`
- Create: `server/tests/lark_cli.test.ts`
- Create: `server/tests/fixtures/fake-lark-cli`（按绑定表的可执行脚本，行为由 `FAKE_SCENARIO` 环境变量切换：`ok` / `no-auth` / `old-version` / `missing-capability` / `bad-json`）

**Interfaces:**
- Consumes: Task 3 的 `load_config()`。
- Produces: `resolve_lark_cli(config) -> { path, source } | error(LARK_CLI_NOT_FOUND)`，查找顺序 = `LARK_CLI_PATH` → `lark.cli_path` → `PATH` → 常见目录（`~/.lark-cli/`、`%LOCALAPPDATA%/Programs/lark-cli/`、`/usr/local/bin`、`~/.local/bin`）；`get_version(cli) -> { version }`（解析 `lark-cli version X.Y.Z`）；`get_auth_status(cli, { verify }) -> { logged_in, identity, user_name? } | error(AUTH_REQUIRED)`（调用 `<cli> auth status --json [--verify]`）；`probe_capabilities(cli) -> { wiki_node_list, docs_fetch, base_table_create, base_record_batch_create, base_record_delete, base_record_list, auth_status }` 布尔映射（通过各命令 `--help` 输出探测，不发起真实写操作）；所有子进程调用使用参数数组，绝不拼接 shell 字符串。

- [ ] **Step 1: 写失败测试**

```text
test("resolver follows env config path common order")
test("resolver falls back when env path is invalid")
test("resolver reports LARK_CLI_NOT_FOUND with searched locations")
test("version parses lark-cli version output")
test("auth status maps not logged in to AUTH_REQUIRED")
test("probe detects missing subcommand capability")
test("spawns with argument array for paths with spaces")
```

最后一条用含空格与中文的临时目录放置 fake-lark-cli，断言可以执行成功。

- [ ] **Step 2: 运行并确认失败**

Run: `npm --prefix server test -- lark_cli`
Expected: FAIL。

- [ ] **Step 3: 实现最小模块**

子进程统一走一个 `run_cli(args, { cwd?, env? })` 封装：超时、退出码、stdout JSON 解析、错误归一化（`LARK_CLI_NOT_FOUND` / `AUTH_REQUIRED` / `INTERNAL`）。JSON 解析失败返回 `error.code=INTERNAL` 且带原始 stderr 摘要（截断）。

- [ ] **Step 4: 运行并确认通过**

Run: `npm --prefix server test -- lark_cli`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/src/lark_cli.* server/tests/lark_cli.* server/tests/fixtures/
git commit -m "feat: add lark-cli discovery, version and capability probe"
```

### Task 5: `health` 工具

**Files:**
- Create: `server/src/tools/health.ts`
- Create: `server/tests/health.test.ts`
- Modify: `server/src/index.ts`（注册 `health`）
- Modify: `server/tests/mcp_handshake.test.ts`（`tools/list` 现在包含 `health`）

**Interfaces:**
- Consumes: Task 3 的配置与目录能力；Task 4 的 lark-cli 能力。
- Produces: `health() -> { ok, checks[], warnings[] }`。`checks[].id` 固定为：`lark_cli`、`lark_cli_version`、`auth`、`config`、`space_a_reachable`、`base_b_reachable`、`local_dirs`、`index`。每项 `{ id, status: pass|warn|fail, message, detail? }`；任一 `fail` ⇒ `ok=false`。`space_a_reachable` 只发一页 `wiki +node-list --space-id <space_a> --page-size 1 --as user`；`base_b_reachable` 只发 `base +table-list --base-token <base_b>` 并检查配置的 table_id 是否存在；`index` 在 Phase 1 固定返回 `status=warn`、`detail.state="not_built"`。

- [ ] **Step 1: 写失败测试**

```text
test("health passes on fully configured fake environment")
test("health fails with login hint when auth missing")
test("health fails when space a unreachable")
test("health fails when base b unreachable")
test("health fails when config missing and never writes it")
test("health reports index as not_built in phase 1")
test("tools list includes health")
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm --prefix server test -- health`
Expected: FAIL。

- [ ] **Step 3: 实现 `health`**

按顺序执行检查，单项失败不中断后续检查（除 `lark_cli` 失败时其余标记 `warn` 并注明 skipped）；输出保持机器可读，`message` 用中文，`detail` 只放非敏感字段（路径、版本、table_id 存在性；token 只出现前 6 位）。

- [ ] **Step 4: 运行并确认通过**

Run: `npm --prefix server test -- health`、`npm --prefix server test -- mcp_handshake`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/src/tools/health.* server/tests/health.* server/src/index.* server/tests/mcp_handshake.*
git commit -m "feat: add health tool with lark-cli, config and reachability checks"
```

### Task 6: `setup` Skill

**Files:**
- Create: `skills/setup/SKILL.md`
- Modify: `plugin.json`（确认 `extensions.com.openai.onboardingSkill` 指向该文件）
- Modify: `server/tests/plugin_manifest.test.ts`（断言 onboardingSkill 路径存在且 frontmatter 合法）

**Interfaces:**
- Consumes: `health` 工具（Task 5）、配置模块（Task 3）、lark-cli 发现（Task 4）。
- Produces: 用户可通过 `$setup` 触发的引导流程：查找/确认 lark-cli → 登录检查（未登录给 `lark-cli auth login` 指引）→ 收集知识库 A（Wiki URL 或 space_id，URL 先经 `wiki +node-get`/`+space-list` 解析成数字 space_id）→ 收集 Base B（URL 或 token）→ **预览 config.toml 将写入的内容** → 用户确认后写入 → 创建本地目录 → 再次运行 `health` → 报告结果（含「Phase 2 后可选的首次同步」占位说明）。

- [ ] **Step 1: 写失败的清单断言**

在 `plugin_manifest` 增加：`extensions.com.openai.onboardingSkill == "./skills/setup/SKILL.md"`，且该文件存在、frontmatter `name=="setup"`。

```text
test("plugin declares onboarding skill that exists")
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm --prefix server test -- plugin_manifest`
Expected: FAIL —— `skills/setup/SKILL.md` 不存在。

- [ ] **Step 3: 写 `skills/setup/SKILL.md`**

frontmatter：`name: setup`、`description`（中文，说明「安装后配置 lark-cli、知识库 A/B 和本地目录」）。正文包含固定小节：`适用时机`、`流程`、`配置项`（与架构 §7.3 字段一一对应）、`失败处理`（引用健康检查的错误码与用户动作）、`安全约定`（不打印 token 全文、写配置前预览、不写知识库 A）。

- [ ] **Step 4: 运行并确认通过**

Run: `npm --prefix server test -- plugin_manifest`、`npm --prefix server test -- skills_contract`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add skills/setup/SKILL.md plugin.json server/tests/plugin_manifest.*
git commit -m "feat: add setup skill"
```

### Task 7: 真实环境验证与能力记录

**Files:**
- Create: `docs/lark-cli-capability-notes.md`
- Create: `server/tests/fixtures/lark-wiki-node-list.sample.json`
- Create: `server/tests/fixtures/lark-docs-fetch.sample.json`
- Create: `server/tests/fixtures/lark-base-table-list.sample.json`

**Interfaces:**
- Consumes: 前六个任务的全部交付。
- Produces: 机器可读的脱敏 fixture（供 Phase 2 使用）+ 人工可读的能力记录（版本、日期、命令、结果、偏差）。

- [ ] **Step 1: 在真实 Codex 会话运行 `$setup`（live）**

用真实 wiki space 与 Base B 跑通 setup 流程；记录每一步的实际输出摘要。若任一步失败，先修实现再重跑，不跳过。

- [ ] **Step 2: 录制并脱敏 fixture（live）**

保存真实 `wiki +node-list`、`docs +fetch`、`base +table-list` 的响应到 `server/tests/fixtures/`，把所有 token 替换为 `EXAMPLExxx` 样式占位值，保持字段结构不变。校验脱敏：`rg -n "cn_|tbl|wikcn|doccn" server/tests/fixtures/` 只应出现占位样式。

- [ ] **Step 3: 写 `docs/lark-cli-capability-notes.md`**

记录：lark-cli 版本与路径、核对日期、「Phase 1 能力探测」结果表（本大纲 §6.5 的五行事实逐条标注实测通过/偏差）、`obj_edit_time` 与 shortcut 节点的实测观察、真实 setup 与 health 的结果摘要。模板列：`命令 | 目的 | 结果 | 备注`。

- [ ] **Step 4: 回归全部测试**

Run: `npm --prefix server run build`；`npm --prefix server test`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add docs/lark-cli-capability-notes.md server/tests/fixtures/
git commit -m "docs: record lark-cli capability verification and add sanitized fixtures"
```

---

## 阶段出口检查

- [ ] `$setup` 在真实环境跑通，`health` 无未解释的 fail。
- [ ] `docs/lark-cli-capability-notes.md` 已记录版本、日期与偏差。
- [ ] 测试全绿；`rg "<(ext|test-ext|test-cmd|build-cmd|run-cmd)>" docs/superpowers/plans/` 无输出。
- [ ] 架构 §7.1 与实现一致（技术栈、目录、运行方式）。
