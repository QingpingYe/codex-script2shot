# setup 自动化实施计划（AI 执行 + 确定性自举）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal：** 让 `$setup` 的常规路径只剩"浏览器操作 + 一次写入确认"两类人类动作：新增零依赖自举脚本承担环境探测、运行时补装、CLI 安装、构建自检、登录编排与工具调用；MCP 侧扩展 `read_config` 与 `pending_config`，并修掉"重跑覆盖既有配置"与"默认 profile 取作者机器值"两个缺陷。

**Architecture：** 保持既有分层——Skill 只做编排、翻译与收集确认；MCP 工具继续负责确定性读写；新增 `scripts/setup_bootstrap.mjs`（纯 ESM、零依赖、依赖可注入）承担插件自举与运行时准备；`call-tool` 以 stdio JSON-RPC 复用 MCP 工具，使 setup 不依赖会话级 MCP 注册。

**Tech Stack：** Node.js >= 24 + TypeScript + vitest；MCP stdio（`@modelcontextprotocol/sdk` 1.32.1，协议版本 `2025-11-25`）；零新增生产依赖。

**Spec：** `docs/superpowers/specs/2026-10-23-setup-automation-design.md`（含 §14 复盘覆盖对照、§15 复审覆盖对照）

## Global Constraints

- 文档优先（AGENTS.md §2）：Task 1 先把 `docs/architecture.md` §7.1 / §7.3 / §8 / §9.1 / §13 改到位，后续 Task 才允许动实现；行为、文档、测试在同一次改动内保持一致。
- 不新增生产依赖、不更换技术栈；脚本只用 Node 内置能力与系统既有工具（`npm`、`tar`）。
- `server/dist/` 与 `server/node_modules/` 继续不入库，任何 Task 都不得提交构建产物。
- 掩码规则：`base_b` 只显示前 6 位加 `…`；`config show` 的 JSON 含 `appSecret`，只允许提取 `appId`，不得整段回显或落盘。
- 不调用 `lark-cli profile use` / `profile remove`；profile 不一致只改本地配置值。
- 人类动作只有三类：浏览器操作、写入确认、授权决策；任何 Task 的产物（技能、脚本输出、错误文案）都不得出现"请用户运行命令"式文案。
- 统一验证命令：`npm --prefix server test -- <过滤词>`。若 `server/dist/server.mjs` 被占用导致 pretest 构建失败，改用 `npm --prefix server exec -- vitest run --root server <过滤词>`，并在交付说明里写明"构建步骤未验证"。
- 每个 Task 一次提交，提交信息用英文祈使句（`feat:` / `fix:` / `docs:` / `test:` / `chore:`）。
- CI 不访问真实飞书资源；真实初始化演练属手动 live smoke，不作为 CI 验收条件。

## Review Focus

1. 重跑覆盖既有配置：`write_config` 的 `preserve_existing` 必须保留用户自定义的 `space_a` / `base_b` / 两个 `table_id` / `project_roots`，且掩码字段不经过对话（Task 2、3、13 的测试）。
2. 默认知识库不可达：只读预检 `health(pending_config)` 必须给出结构化错误（Task 5），技能契约必须要求预检先于写入并在 `KB_A_UNREACHABLE` / `KB_B_UNREACHABLE` 时停止（Task 13），避免产生半成品配置。
3. `pending_config` 不得通向执行路径：`dry_run: false` 携带它必须 `CONFIG_INVALID`（Task 4）。
4. 敏感入参流转：`call-tool` 默认走 stdin；退化为私有临时文件时必须即刻删除，日志与错误详情不含内容（Task 12）。
5. 无 npm 机器与构建器脚本拦截：`ensure-runtime` 必须能补装私有 Node；构建器被宿主策略拦住时返回 `BUILD_TOOL_BLOCKED` 而不是静默绕过（Task 7、9）。

---

## Task 1: 设计文档对齐（architecture.md）

**Files:**
- Modify: `docs/architecture.md`（§7.1、§7.3、§8、§9.1、§13）

**Interfaces:**
- Consumes: 本计划与 `docs/superpowers/specs/2026-10-23-setup-automation-design.md` 的全部结论。
- Produces: 供后续 Task 引用的权威描述——脚本入口与子命令清单、`pending_config` 契约、`read_config`、错误码表、人类动作边界。

- [ ] **Step 1: 改 §7.1（分发与自举）**

写清：脚本入口 `scripts/setup_bootstrap.mjs` 与两个包装脚本；8 个子命令清单；包装脚本复用 `launch_script2shot_mcp*` 的 Node 解析顺序；私有运行时目录 `~/.codex-script2shot/runtime/node-<version>/` 的下载、`SHASUMS256.txt` 校验与解压规则；构建后以 `initialize` + `tools/list` 非空做握手自检；`server/dist` 仍不入库。

- [ ] **Step 2: 改 §7.3（lark 配置语义）**

删除 `lark.profile` 的默认值描述（"取本机 lark-cli 活动 profile"那一条），改为：profile 无默认值，由 setup 解析活动 profile 后显式传入；`write_config` 的缺省语义把 `profile` 从"undefined 时套默认"移出，改为缺失即 `CONFIG_INVALID`（`details.missing_keys` 含 `lark.profile`）；lark-cli 发现顺序新增 `~/.codex-script2shot/cli/node_modules/@larksuite/cli/bin`；`LARK_PROFILE_MISMATCH` 的处置改为"运行 $setup 对齐配置"，明确不再提示用户执行 `profile use`。

- [ ] **Step 3: 改 §8（工具与错误码）**

工具表新增 `read_config`；给 `health` 与 `init_knowledge_b` 补 `pending_config` 入参语义（提供即替代磁盘配置；`init_knowledge_b` 仅 dry-run，执行路径携带即 `CONFIG_INVALID`；成功结果带 `config_source`）；在失败处理部分补 `NODE_*` / `NPM_*` / `BUILD_TOOL_BLOCKED` / `CLI_*` / `APP_*` / `USAGE_ERROR`。

- [ ] **Step 4: 改 §9.1（setup 技能职责）**

写清三类人类动作与验收口径、既有配置优先的三元决策、默认知识库不可达的两条合法路径，以及"技能不得要求用户执行命令"。

- [ ] **Step 5: 验证文档断言**

Run: `rg -n "setup_bootstrap|pending_config|read_config|BUILD_TOOL_BLOCKED" docs/architecture.md`
Expected: 四类关键词都有命中。

Run: `rg -n "提示用户.{0,12}profile use|请运行.{0,12}profile use" docs/architecture.md`
Expected: 无输出（退出码 1）。

- [ ] **Step 6: 提交**

```bash
git add docs/architecture.md
git commit -m "docs: align architecture with setup automation design"
```

---

## Task 2: `read_config` 只读工具

**Files:**
- Create: `server/src/tools/read_config.ts`
- Modify: `server/src/index.ts`（`TOOLS` 中 `health` 之后注册）、`server/tests/mcp_handshake.test.ts`（工具清单断言）
- Test: `server/tests/read_config.test.ts`

**Interfaces:**
- Consumes: `load_config()`、`resolve_home()`、`CONFIG_FILE_NAME`（`server/src/config.ts`）。
- Produces: `read_config(): ReadConfigResult`；成功 `{ exists: boolean; path: string; config?: ReadConfigSnapshot; warnings: ConfigWarning[] }`，失败 `{ ok: false; error: { code: "CONFIG_INVALID"; message: string; details: { path: string; field?: string } } }`；`ReadConfigSnapshot.lark` 用 `base_b_prefix`（前 6 位 + `…`）替代 `base_b`，其余字段原样。

- [ ] **Step 1: 写失败测试**

`server/tests/read_config.test.ts`（照 `write_config.test.ts` 用 `SCRIPT2SHOT_HOME` 指向临时 home）断言：

1. 配置不存在 → `exists === false`、`warnings` 为空、无 `config`；
2. 正常配置 → `config.lark.base_b_prefix === "baseto…"`，且序列化结果里不含完整 `base_b`；`space_a`、两个 `table_id`、`project_roots`、`retrieval` 原样返回；
3. 坏 TOML → `error.code === "CONFIG_INVALID"` 且 `details.path` 指向配置文件。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix server test -- read_config`
Expected: FAIL（模块不存在或断言失败）。

- [ ] **Step 3: 实现并注册**

实现 `read_config()`：复用 `load_config()`，成功时把 `base_b` 换成 `base_b_prefix`；`index.ts` 注册工具 `read_config`（`inputSchema: { type: "object", properties: {}, additionalProperties: false }`），描述注明"只读、`base_b` 已掩码"；`mcp_handshake.test.ts` 清单断言加 `expect(toolNames).toContain("read_config")`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix server test -- read_config mcp_handshake`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add server/src/tools/read_config.ts server/tests/read_config.test.ts server/src/index.ts server/tests/mcp_handshake.test.ts
git commit -m "feat: add masked read_config tool"
```

---

## Task 3: `write_config` 保留既有配置 + 去掉 `lark.profile` 默认值 + 私有 prefix 发现

**Files:**
- Modify: `server/src/setup_defaults.ts`、`server/src/tools/write_config.ts`、`server/src/lark_cli.ts`
- Test: `server/tests/write_config.test.ts`、`server/tests/lark_cli.test.ts`

**Interfaces:**
- Consumes: `SETUP_DEFAULTS`（唯一默认值来源）。
- Produces: `WriteConfigInput.preserve_existing?: unknown`（缺省 `true`）；成功回执新增 `preserved_existing: string[]`，`applied_defaults` 只含真正套用默认值的键；`SetupDefaults.lark` 不再含 `profile`（无磁盘值且未显式提供 → `CONFIG_INVALID` + `details.missing_keys: ["lark.profile"]`）；`resolve_lark_cli()` 额外在 `<home>/.codex-script2shot/cli/node_modules/@larksuite/cli/bin` 下查找（`LarkCliSource` 仍为 `"common"`）。

- [ ] **Step 1: 写失败测试**

`write_config.test.ts` 补五类用例：

1. 先写入含自定义 `space_a` / `base_b` / 两个 `table_id` / `project_roots` / `default_top_k` 的配置，再只传 `profile` + `cli_path` 调 `write_config` → 自定义字段全部保留，`preserved_existing[]` 列出它们，`applied_defaults[]` 不含它们，落盘后 `base_b` 仍是自定义原值；
2. 无磁盘配置且未传 `profile` → `CONFIG_INVALID`，`details.missing_keys` 含 `lark.profile`；无磁盘配置但传了 `profile` → 照常套 `space_a` / `base_b` 默认值；
3. 磁盘已有 `profile` 且未显式传 → 沿用磁盘值（不进 `applied_defaults`）；
4. `preserve_existing: false` → 自定义值被默认值覆盖（反例，锁定旧"纯默认"语义）；
5. 磁盘配置文件是坏 TOML → `CONFIG_INVALID`（默认 `preserve_existing: true` 下不得静默丢弃）。

`lark_cli.test.ts` 补：临时 home 的 `<home>/.codex-script2shot/cli/node_modules/@larksuite/cli/bin` 放 fake `lark-cli`，清空 `PATH` 与 `LARK_CLI_PATH` → `resolve_lark_cli(undefined, { env, home_dir })` 返回该路径且 `source === "common"`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix server test -- write_config lark_cli`
Expected: FAIL（当前无 `preserved_existing`、`applied_defaults` 含 `lark.profile`；私有 prefix 未被发现）。

- [ ] **Step 3: 实现**

`setup_defaults.ts` 删除 `profile` 字段与值；`write_config.ts` 按 **显式 > 既有（`preserve_existing`）> 默认** 逐字段判定：显式值优先；未显式且磁盘有非空值时保留并记入 `preserved_existing[]`；否则套 `SETUP_DEFAULTS` 并记入 `applied_defaults[]`；`profile` 不参与默认回填，磁盘也没有时按 `CONFIG_INVALID` + `missing_keys` 返回；`preserve_existing: false` 跳过全部磁盘值；磁盘 TOML 解析失败时返回 `CONFIG_INVALID`。`lark_cli.ts` 的 `common_directories()` 追加私有 prefix（导入 `DEFAULT_HOME_DIR_NAME`）。

- [ ] **Step 4: 全量回归既有用例**

Run: `npm --prefix server test`
Expected: PASS；若其他用例依赖旧默认 profile，更新 fixture 使其显式传 `profile`（不得放宽必填校验）。

- [ ] **Step 5: 提交**

```bash
git add server/src/setup_defaults.ts server/src/tools/write_config.ts server/src/lark_cli.ts server/tests
git commit -m "fix: preserve existing config and require explicit lark profile"
```

---

## Task 4: `init_knowledge_b.pending_config`

**Files:**
- Modify: `server/src/tools/write_config.ts`（导出 normalizer）、`server/src/tools/init_knowledge_b.ts`、`server/src/index.ts`
- Test: `server/tests/init_knowledge_b.test.ts`

**Interfaces:**
- Consumes: `write_config` 的 `normalize_config`（导出后复用，禁止复制规则）。
- Produces: `InitKnowledgeBInput.pending_config?: unknown`；成功结果新增 `config_source: "pending" | "disk"`。

- [ ] **Step 1: 写失败测试**

在 `init_knowledge_b.test.ts` 补四类用例：

1. 磁盘无配置 + `pending_config`（含 `cli_path` / `profile` / `space_a` / `base_b`）→ dry-run 返回 `action` 与 `config_source === "pending"`；
2. 磁盘配置损坏 + `pending_config` → 仍可预览（证明不读磁盘）；
3. `pending_config` 非法（如 `base_b` 为空）→ `CONFIG_INVALID`；
4. `dry_run: false` 携带 `pending_config` → `CONFIG_INVALID`（`details.field === "pending_config"`），配置文件零写入。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix server test -- init_knowledge_b`
Expected: FAIL（`pending_config` 被忽略或 schema 拒绝）。

- [ ] **Step 3: 实现**

导出 `normalize_config`；`init_knowledge_b` 顺序：(a) 校验 `dry_run`；(b) `pending_config` + `dry_run === false` → `CONFIG_INVALID`；(c) `pending_config` → normalize，失败按其错误返回；(d) 否则走现有 `load_config()`。后续 `resolve_lark_cli` / `list_tables` 使用解析出的 config，成功结果带 `config_source`。`index.ts` 该工具 schema 增 `pending_config`（`type: "object"`），保持 `additionalProperties: false`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix server test -- init_knowledge_b`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add server/src/tools/write_config.ts server/src/tools/init_knowledge_b.ts server/src/index.ts server/tests/init_knowledge_b.test.ts
git commit -m "feat: allow dry-run preview with pending config"
```

---

## Task 5: `health.pending_config` + profile 文案

**Files:**
- Modify: `server/src/tools/health.ts`、`server/src/index.ts`
- Test: `server/tests/health.test.ts`

**Interfaces:**
- Consumes: Task 4 导出的 `normalize_config`。
- Produces: `HealthOptions.pending_config?: unknown`；`HealthResult.config_source: "pending" | "disk" | "none"`。

- [ ] **Step 1: 写失败测试**

1. 磁盘无配置 + 合法 `pending_config` → `config_source === "pending"`，`space_a_reachable` / `base_b_reachable` 正常执行（fake CLI 调用记录里出现对应命令）；
2. `pending_config` 非法 → `ok === false`，`config` check 为 fail、`detail.code === "CONFIG_INVALID"` 并带 `missing_keys`；
3. profile mismatch 用例改为断言 message **不含** `lark-cli profile use`，且包含 `$setup`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix server test -- health`
Expected: FAIL（当前无 `pending_config`，mismatch 文案含 `profile use`）。

- [ ] **Step 3: 实现**

把配置来源收敛为一个函数：提供 `pending_config` → normalize 后用其结果（`"pending"`）；normalize 失败 → 直接返回只含 `config` fail check 的结果（`config_source: "none"`）；否则走 `load_config()`（存在 → `"disk"`，否则 `"none"`）。`LARK_PROFILE_MISMATCH` 文案改为结构化差异 + `运行 $setup 可自动对齐配置（插件不会调用 profile use 切换）`，`detail` 字段名保持不变。`index.ts` 给 `health` schema 加 `pending_config`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix server test -- health mcp_handshake`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add server/src/tools/health.ts server/src/index.ts server/tests/health.test.ts
git commit -m "feat: preview health with pending config and reword profile mismatch"
```

---

## Task 6: `setup_bootstrap.mjs` 骨架 + `doctor`

**Files:**
- Create: `scripts/setup_bootstrap.mjs`、`scripts/setup_bootstrap`、`scripts/setup_bootstrap.cmd`
- Test: `server/tests/setup_bootstrap.test.ts`

**Interfaces:**
- Consumes: `scripts/launch_script2shot_mcp*` 的 Node 解析顺序（包装脚本照抄，不改动原启动器）。
- Produces: `run_cli(argv, options): Promise<number>`、`doctor(options): Promise<DoctorResult>`；`EXIT_OK = 0` / `EXIT_FAILED = 1` / `EXIT_NEEDS_HUMAN = 2`；成功形状 `{ ok: true, ... }`、失败形状 `BootstrapFailure = { ok: false, error: { code, message, details?, next_actions? } }`（后续 Task 复用该类型名）；退出码映射固定为 `APP_REGISTRATION_PENDING` / `AUTH_LOGIN_PENDING` / `NEEDS_ESCALATION` → 2，其余失败 → 1；`options = { env, home_dir, io: { stdout, stderr }, deps }`，`deps = { run, fetch_json, fetch_bytes, extract, now }`。

- [ ] **Step 1: 写失败测试**

`server/tests/setup_bootstrap.test.ts` 用 `await import("../../scripts/setup_bootstrap.mjs")`，断言：

1. `doctor({ home_dir, env, deps })` 返回 `capabilities` 四个布尔（`can_write_home` / `can_write_plugin_dir` / `can_reach_network` / `can_build`）与固定 checks id 集合（`plugin_dir` / `node` / `npm` / `network` / `home` / `lark_cli` / `config` / `dist` / `index`）；
2. `run_cli(["doctor"], { ... })` 的 stdout 是合法 JSON、退出码 0；
3. `run_cli(["nope"], { ... })` 退出码 1，`error.code === "USAGE_ERROR"`；
4. deps 全为假实现时不得发起真实子进程与网络（计数断言）；
5. 包装脚本 smoke（按平台二选一，离线可跑）：Windows 跑 `scripts\setup_bootstrap.cmd nope`、POSIX 跑 `sh scripts/setup_bootstrap nope`，stdout 是含 `USAGE_ERROR` 的合法 JSON、退出码 1（证明包装脚本能解析到 Node 并转发参数；`doctor` 的网络探测由注入式单测覆盖）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix server test -- setup_bootstrap`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现骨架与 doctor**

实现子命令分发（未识别 → `USAGE_ERROR`）、JSON 输出到 stdout、进度写 stderr、`deps` 注入；两个包装脚本的平台差异照 `launch_script2shot_mcp(.cmd)` 处理。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix server test -- setup_bootstrap`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add scripts/setup_bootstrap.mjs scripts/setup_bootstrap scripts/setup_bootstrap.cmd server/tests/setup_bootstrap.test.ts
git commit -m "feat: add setup bootstrap entry with doctor command"
```

---

## Task 7: `ensure-runtime`（私有 Node 运行时）

**Files:**
- Modify: `scripts/setup_bootstrap.mjs`
- Test: `server/tests/setup_bootstrap.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `deps.run` / `fetch_json` / `fetch_bytes` / `extract`。
- Produces: `ensure_runtime(options): Promise<EnsureRuntimeResult>`；成功 `{ ok: true, node_path, npm_path, version, source: "system" | "private", archive_url?, checksum_source? }`。

- [ ] **Step 1: 写失败测试**

1. 系统 `node`/`npm` 满足 `>= 24` → `source === "system"`，`fetch_bytes` 调用次数为 0；
2. 系统缺失 → 假 `index.json` 选出 `major >= 24` 且 `lts !== false` 的最高版本，校验通过并落地到 `<home>/runtime/node-<version>/`，`node_path` / `npm_path` 指向落地文件；
3. 校验值不符 → `error.code === "NODE_CHECKSUM_MISMATCH"`，运行目录不存在；
4. 不支持的平台/架构 → `error.code === "NPM_UNAVAILABLE"`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix server test -- setup_bootstrap`
Expected: FAIL（`ensure_runtime` 未实现）。

- [ ] **Step 3: 实现**

版本解析：`https://nodejs.org/dist/index.json` 取 `major >= 24` 且 `lts !== false` 的最高版本（`--node-version` 可固定）；归档映射 `win-x64` → `.zip`、`darwin-arm64` / `darwin-x64` → `.tar.gz`、`linux-x64` → `.tar.xz`，其余 `NPM_UNAVAILABLE`；先取同版本目录 `SHASUMS256.txt` 校验 sha256 再解压；解压后定位顶层目录并归一化 `node_path` / `npm_path`（Windows `npm.cmd`，POSIX `bin/npm`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix server test -- setup_bootstrap`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add scripts/setup_bootstrap.mjs server/tests/setup_bootstrap.test.ts
git commit -m "feat: provision private node runtime when npm is missing"
```

---

## Task 8: `install-cli`（四级回退）

**Files:**
- Modify: `scripts/setup_bootstrap.mjs`
- Test: `server/tests/setup_bootstrap.test.ts`

**Interfaces:**
- Consumes: Task 7 的 `ensure_runtime()`（取 `npm_path`）。
- Produces: `install_cli(options): Promise<InstallCliResult>`；成功 `{ ok: true, cli_path, version, source: "reuse" | "npm-prefix" | "package-installer" | "archive" | "global" }`。

- [ ] **Step 1: 写失败测试**

1. 已有 `>= 1.0.98` → `source === "reuse"`，不调用 npm；
2. npm 安装成功但二进制缺失 → 追加执行包内 `scripts/install.js`（断言参数与 `LARK_CLI_RUN=1` 环境）；
3. npm 与包内安装器都失败 → `error.code === "NPM_INSTALL_FAILED"`，不得返回成功；
4. 已存在版本 `< 1.0.98` → 走安装而不是复用；
5. 私有 prefix 固定为 `<home>/cli`，`cli_path` 指向 `@larksuite/cli/bin/lark-cli[.exe]`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix server test -- setup_bootstrap`
Expected: FAIL（`install_cli` 未实现）。

- [ ] **Step 3: 实现**

顺序：复用（`>= 1.0.98`）→ `npm install --prefix <home>/cli --cache <tmp>/script2shot-npm-cache @larksuite/cli@1.0.98` → 二进制缺失时 `node <prefix>/node_modules/@larksuite/cli/scripts/install.js`（`LARK_CLI_RUN=1`）→ Node `fetch` 官方归档 + 校验后解压到同一 prefix；`--allow-global` 才允许 `npm install -g`。输出带 `version` 与 `source`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix server test -- setup_bootstrap`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add scripts/setup_bootstrap.mjs server/tests/setup_bootstrap.test.ts
git commit -m "feat: install lark-cli into a private prefix with fallbacks"
```

---

## Task 9: `build-server`（构建 + 失败分类 + 握手自检）

**Files:**
- Modify: `scripts/setup_bootstrap.mjs`
- Test: `server/tests/setup_bootstrap.test.ts`

**Interfaces:**
- Consumes: `npm_path`（Task 7）、`plugin_root` 选项（默认由脚本位置推导）。
- Produces: `build_server(options): Promise<BuildServerResult>`；成功 `{ ok: true, dist_path, tools_count }`。

- [ ] **Step 1: 写失败测试**

1. 插件 `server/` 不可写 → `PLUGIN_DIR_READONLY`；
2. npm stderr 含 `EPERM` / `EACCES` → `NEEDS_ESCALATION`；
3. npm stderr 含 `ENOTFOUND` / `EAI_AGAIN` → `NETWORK_BLOCKED`，含 `ERESOLVE` 或 404 → `NPM_SOURCE_FAILED`；
4. 构建后 `node_modules/esbuild` 二进制缺失或 dist 未生成 → `BUILD_TOOL_BLOCKED`；
5. 成功路径（fake npm 写出最小 dist，或复用真实构建产物）→ `tools_count >= 1`，且返回前完成 `initialize` + `tools/list` 握手。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix server test -- setup_bootstrap`
Expected: FAIL（`build_server` 未实现）。

- [ ] **Step 3: 实现**

先做插件目录写权限预检；依次执行 `npm ci --cache <tmp>/script2shot-npm-cache` 与 `npm run build`；按 stderr 关键字分类；随后以 stdio JSON-RPC（`initialize` 请求 `protocolVersion: "2025-11-25"` → `notifications/initialized` → `tools/list`）自检，工具数为 0 → `SERVER_HANDSHAKE_FAILED`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix server test -- setup_bootstrap mcp_handshake`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add scripts/setup_bootstrap.mjs server/tests/setup_bootstrap.test.ts
git commit -m "feat: build mcp server with classified failures and handshake check"
```

---

## Task 10: `ensure-app`（应用守卫）

**Files:**
- Modify: `scripts/setup_bootstrap.mjs`
- Test: `server/tests/setup_bootstrap.test.ts`

**Interfaces:**
- Consumes: `lark_cli` 路径（Task 6 / 8）。
- Produces: `ensure_app(options): Promise<EnsureAppResult>`；成功 `{ ok: true, status: "reused" | "created", app_id }`；未配置 → `APP_NOT_CONFIGURED` + `next_actions`；agent 上下文拒绝 → `APP_REGISTRATION_PENDING`。

- [ ] **Step 1: 写失败测试**

1. `config show` 的 stdout 含 `appId`、stderr 另有路径提示 → `status === "reused"` 且**不调用** `config init`（复盘 P0 守卫）；
2. stdout 无 `appId` → `APP_NOT_CONFIGURED`，`next_actions` 说明需用户同意后创建；
3. `--create` 但 CLI 以 agent 上下文拒绝 → `APP_REGISTRATION_PENDING`，`next_actions` 指向"取得用户同意后加 `--force`"；
4. 含 `appSecret` 的 stdout 不得出现在结果或日志里。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix server test -- setup_bootstrap`
Expected: FAIL（`ensure_app` 未实现）。

- [ ] **Step 3: 实现**

只解析 stdout JSON 且只取 `appId`；`--create` 执行 `config init --new --lang zh`（`--force` 时附 `--force-init`），阻塞期间把授权链接转发到 stderr，完成后重新读 `appId` 复核。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix server test -- setup_bootstrap`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add scripts/setup_bootstrap.mjs server/tests/setup_bootstrap.test.ts
git commit -m "feat: guard feishu app registration behind appId check"
```

---

## Task 11: `auth-login` 与 `profile`

**Files:**
- Modify: `scripts/setup_bootstrap.mjs`
- Test: `server/tests/setup_bootstrap.test.ts`

**Interfaces:**
- Consumes: `lark_cli` 路径。
- Produces: `auth_login(options): Promise<AuthLoginResult>`（`status: "pending_human" | "ready"`，含 `verification_url` / `user_code`）、`resolve_profile(options): Promise<{ ok: true; profile: string } | BootstrapFailure>`。

- [ ] **Step 1: 写失败测试**

1. `auth login --no-wait --json` 输出含 `verification_url` 与 `user_code` → `status === "pending_human"`，参数含 `--domain wiki,base,docs,drive`；
2. `--device-code <code>` 续跑后 `auth status --json` 返回 `identities.user.status === "ready"` 且 `available === true` → `status === "ready"`；
3. `auth login` 退出码非 0 但身份复核 ready → 仍返回成功（退出码不作判据）；
4. 身份 `missing` → `AUTH_LOGIN_FAILED`；
5. `profile list` 两个 `active: true` → `PROFILE_AMBIGUOUS`；唯一 active → 返回该 `name`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix server test -- setup_bootstrap`
Expected: FAIL（两个函数未实现）。

- [ ] **Step 3: 实现**

登录委托给 lark-cli（不自行实现 OAuth）；身份判据固定为 `identities.user.status === "ready" && available === true`；`device_code` 只出现在 JSON 结果里，stderr 与日志不打印。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix server test -- setup_bootstrap`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add scripts/setup_bootstrap.mjs server/tests/setup_bootstrap.test.ts
git commit -m "feat: orchestrate device login and active profile resolution"
```

---

## Task 12: `call-tool`（stdio 桥 + 入参安全）

**Files:**
- Modify: `scripts/setup_bootstrap.mjs`
- Test: `server/tests/setup_bootstrap.test.ts`

**Interfaces:**
- Consumes: 已构建的 `server/dist/server.mjs`（Task 9）；`~/.codex-script2shot/tmp/`。
- Produces: `call_tool(name, input, options): Promise<CallToolResult>`；返回工具原始 JSON 结果，脚本不把入参内容写入 stdout / stderr / 日志。

- [ ] **Step 1: 写失败测试**

1. `call_tool("health", { pending_config: <合法配置> })` → 结果里 `config_source === "pending"`；
2. 入参含敏感串（如 `"SENSITIVE-TOKEN-1"`）时，命令返回值与 stderr 都不含该串，`<home>/tmp/` 为空（默认 stdin 路径不落盘）；
3. `--input <file>` 兜底路径：文件必须在 `<home>/tmp/` 下、子进程启动后被删除；注入删除失败 → 结果带 `warnings[].code === "INPUT_TEMP_CLEANUP_FAILED"`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix server test -- setup_bootstrap`
Expected: FAIL（`call_tool` 未实现）。

- [ ] **Step 3: 实现**

默认从 stdin 读入参；`--input` 仅作兜底且文件限定在 `<home>/tmp/`、创建时权限最小化、子进程启动后删除。JSON-RPC 流程：`initialize`（`protocolVersion: "2025-11-25"`，`clientInfo.name = "setup_bootstrap"`）→ `notifications/initialized` → `tools/call`；把 `content[].text` 解析为 JSON 后返回，工具返回 `{ ok: false }` 时原样透出。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix server test -- setup_bootstrap mcp_handshake`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add scripts/setup_bootstrap.mjs server/tests/setup_bootstrap.test.ts
git commit -m "feat: add stdio tool bridge with safe input handling"
```

---

## Task 13: 技能重写 + 启动器文案 + 契约测试

**Files:**
- Modify: `skills/setup/SKILL.md`、`scripts/launch_script2shot_mcp`、`scripts/launch_script2shot_mcp.cmd`
- Test: `server/tests/skills_contract.test.ts`

**Interfaces:**
- Consumes: Task 1 的 architecture §7.1 / §7.3 / §8 / §9.1；Task 6–12 的子命令与错误码。
- Produces: 技能文档中固定的执行流程、人类动作边界、失败处理表与 `write_config` 入参形状示例。

- [ ] **Step 1: 写失败测试**

在 `skills_contract.test.ts` 补断言（读 `skills/setup/SKILL.md` 文本）：

1. 文本含 `setup_bootstrap` 与全部子命令名（`doctor` / `ensure-runtime` / `install-cli` / `build-server` / `ensure-app` / `auth-login` / `profile` / `call-tool`）；
2. 含三类人类动作关键词（浏览器、写入确认、授权）；
3. 含 `{ config: { lark, retrieval }` 入参形状示例；
4. 不匹配 `/请用户运行|请你在终端|自己去终端/`，也不匹配 `/profile use/`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix server test -- skills_contract`
Expected: FAIL（当前技能仍写"指引用户在自己的终端运行 lark-cli auth login"）。

- [ ] **Step 3: 重写技能与启动器文案**

按架构 §9.1 重写 `skills/setup/SKILL.md`：环境前置与执行责任（脚本位置相对本 Skill 文件定位插件根目录）、八步流程、三类人类动作与验收口径、默认知识库不可达的两条路径、失败处理表（按 Task 6–12 的错误码）、禁止项与 `write_config` 入参形状示例。其中必须写清：默认只传显式替换项与解析出的 `profile` / `cli_path`，其余字段的"保留"由 `write_config` 的 `preserve_existing` 完成，预览里展示 `preserved_existing[]` 与 `applied_defaults[]`。两个启动器脚本的"尚未构建"提示各补一句：`可由 scripts/setup_bootstrap build-server 自动完成`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix server test -- skills_contract plugin_manifest mcp_handshake`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add skills/setup/SKILL.md scripts/launch_script2shot_mcp scripts/launch_script2shot_mcp.cmd server/tests/skills_contract.test.ts
git commit -m "feat: rewrite setup skill for ai-executed bootstrap flow"
```

---

## Task 14: 收尾回归与记录

**Files:**
- Modify: `docs/script2shot-pilot-notes.md`（新增回归小节）、`docs/superpowers/specs/2026-10-23-setup-automation-design.md`（状态改为已实施）

**Interfaces:**
- Consumes: Task 1–13 的全部产物。
- Produces: 可核对的回归记录与手动 live smoke 清单。

- [ ] **Step 1: 跑全量回归**

Run: `npm --prefix server test`
Expected: 全量 PASS（构建 + 全部测试文件）。

Run: `npm --prefix server run typecheck`
Expected: 无输出（PASS）。

- [ ] **Step 2: 手动 live smoke（不进 CI）**

在一台已安装插件的机器上：删除 `<plugin_root>/server/dist` → 让 AI 从 `$setup` 走 `doctor` → `ensure-runtime` → `build-server` → `install-cli` → `ensure-app` → `auth-login` → 预览 → 一次确认 → `health`；记录人类动作次数（应为浏览器操作 1–2 次 + 写入确认 1 次）与是否出现任何终端命令要求。

- [ ] **Step 3: 写回归记录**

在 `docs/script2shot-pilot-notes.md` 追加小节：命令、结果、live smoke 读数、未验证项（含 Node 归档版本与校验值的待复核状态）。设计文档头部状态改为"已实施（2026-10-23）"。

- [ ] **Step 4: 提交**

```bash
git add docs/script2shot-pilot-notes.md docs/superpowers/specs/2026-10-23-setup-automation-design.md
git commit -m "docs: record setup automation regression and live smoke results"
```

## 任务总览

| Task | 产物 | 依赖 |
| --- | --- | --- |
| 1 | architecture §7.1 / §7.3 / §8 / §9.1 / §13 对齐 | — |
| 2 | `read_config` 工具 | 1 |
| 3 | profile 去默认值 + 私有 prefix 发现 | 1 |
| 4 | `init_knowledge_b.pending_config` | 3 |
| 5 | `health.pending_config` + 文案 | 4 |
| 6 | 脚本骨架 + `doctor` | 1 |
| 7 | `ensure-runtime` | 6 |
| 8 | `install-cli` | 7 |
| 9 | `build-server` | 7 |
| 10 | `ensure-app` | 8 |
| 11 | `auth-login` + `profile` | 8 |
| 12 | `call-tool` | 5、9 |
| 13 | 技能重写 + 契约测试 | 5、12 |
| 14 | 收尾回归与记录 | 13 |

## 未验证项（交付时必须如实说明）

- Node 官方分发的具体版本号与 `SHASUMS256.txt` 校验值：本轮网络受限未取回，Task 7 按解析规则在运行期确定并回显（设计 §11 标"待复核"）。
- npm 新版拦截安装脚本对 `@larksuite/cli` 与 `esbuild` 的实际影响：来自复盘记录，未在本机复现；Task 9 的 `BUILD_TOOL_BLOCKED` 分类需在真实拦截环境下补一次 live 验证。
- 真实飞书初始化（应用创建 + 设备授权 + AI 库建表）只能人工演练，Task 14 的 live smoke 是其唯一覆盖。
