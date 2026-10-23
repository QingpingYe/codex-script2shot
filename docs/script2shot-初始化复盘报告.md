# script2shot 插件初始化配置复盘报告

日期：2026-10-23（Asia/Shanghai）
范围：`@script2shot` 插件在本机的首次初始化配置（`script2shot:setup` 技能目标）
结论：初始化已完成并验证通过；过程中暴露出 3 类阻塞点和 6 个逻辑缺陷，其中 2 个具备"误建飞书应用"级别的风险。

---

## 一、最终状态

`health` 返回 `ok: true`，9 项检查中 8 项 pass，1 项 warn。

| 检查项 | 状态 | 结果 |
| --- | --- | --- |
| `lark_cli` | pass | `C:\Users\lvan\AppData\Roaming\npm\node_modules\@larksuite\cli\bin\lark-cli.exe` |
| `lark_cli_version` | pass | 1.0.98 |
| `auth` | pass | 用户身份：黄东城 |
| `config` | pass | `C:\Users\lvan\.codex-script2shot\config.toml` |
| `space_a_reachable` | pass | `7695983197091302359` |
| `base_b_reachable` | pass | 已校验 `tblUOrjzQJKrjCBS`、`tbl3XcUQcedY8AW2` |
| `local_dirs` | pass | cache / index / logs 已创建 |
| `index` | warn | `INDEX_NOT_BUILT`，首次同步前属预期 |

写入的配置要点（`base_b` 按掩码规则处理）：

```toml
[lark]
cli_path = "C:\\Users\\lvan\\AppData\\Roaming\\npm\\node_modules\\@larksuite\\cli\\bin\\lark-cli.exe"
profile = "cli_aa504d698da1dd1a"
space_a = "7695983197091302359"
base_b = "WRrVbl…"
knowledge_cards_table_id = "tblUOrjzQJKrjCBS"
sync_state_table_id = "tbl3XcUQcedY8AW2"

[[lark.project_roots]]
node_token = "Ou9Vw0emviJajPklYjQc4fqjnie"
project_id = "wufu-linmen"

[retrieval]
default_top_k = 12
```

AI 库 `init_knowledge_b` 的判定结果是 `action: "validated"`：`KnowledgeCards` 与 `SyncState` 两张表已存在且字段清单一致，`drift` 为空，只需要回填 `table_id`。这修正了"首次初始化必然建表"的预期。

---

## 二、时间线

1. 读取 `script2shot:setup` 技能，按其要求先做只读 `health` 预检。
2. 发现技能依赖的 `health`、`write_config`、`init_knowledge_b` 在会话中不可调用，插件仓库目录内也没有可启动的服务。
3. 确认插件自带 `mcp.json` 指向 `./scripts/launch_script2shot_mcp`，而该启动器要求 `server/dist/server.mjs`，此文件不存在，`server/node_modules` 同样不存在。
4. 在工作区复制一份服务源码，安装锁定依赖并编译，得到可调用的 MCP 服务，用它完成预检。
5. 预检结果：`LARK_CLI_NOT_FOUND`、`CONFIG_MISSING`、`LOCAL_DIRS_MISSING`、`INDEX_NOT_BUILT`。
6. 安装 `lark-cli`：官方 `npx install` 路径连续失败，改为下载官方二进制压缩包并在工作区解压，得到 1.0.98。
7. 出网与 home 写入被沙箱阻断，且当轮没有可用的提权工具，流程中断并向用户说明。
8. 用户确认可以提权后，用沙箱外执行跑完剩余步骤：应用注册、设备登录、配置写入、AI 库校验。
9. 完成全局安装 `@larksuite/cli@1.0.98`，把 `cli_path` 改回标准路径。
10. 在插件安装目录内补建 `server/dist/server.mjs`，验证插件自带服务可启动，`health` 全绿。

---

## 三、阻塞点

### 3.1 插件安装后缺少构建产物（最高影响）

插件 `mcp.json` 直接引用 `./scripts/launch_script2shot_mcp`，启动器在 `server/dist/server.mjs` 不存在时只打印"尚未构建，请先运行 npm --prefix server run build"并退出。实际情况是该目录既没有 `dist`，也没有 `node_modules`，而 `setup` 技能的第一步就要求调用 `health`，形成"没有构建就进不了流程、流程第一步又依赖构建产物"的闭环阻塞。

影响：任何从市场安装该插件的用户，在无人手动构建前都无法使用任何技能。

### 3.2 初始化天然需要提权，但技能未声明

本流程必须完成两件沙箱外动作：

- 出网：访问 `accounts.feishu.cn` 完成应用注册与设备授权，读取原始知识库、校验 AI 库。
- 写 home：创建并写入 `C:\Users\lvan\.codex-script2shot\config.toml` 与 `cache/index/logs`。

这两点都不在默认沙箱可写范围内。技能文档只写了"确认 lark-cli 与登录状态"，没有前置说明"本流程必须提权"。

### 3.3 提权通道存在窗口期

沙箱环境变量 `CODEX_SANDBOX_NETWORK_DISABLED=1`，出网请求报 `WSAEACCES`。同时满足下列两条时流程完全无法推进：

- 审批策略中 `sandbox_approval=false`，使 `require_escalated` 直接被拒：`reject command — you cannot ask for escalated permissions if the approval policy is Granular(...)`。
- 绑定的提权工具 `request_permissions` 在该轮未注册，调用返回 `unsupported call: request_permissions`。

用户侧调整策略后才恢复。这说明技能的失败处理表里缺少"无法提权"这一类的处置建议。

---

## 四、逻辑缺陷（自研执行脚本暴露，建议同步进技能）

### 4.1 重复创建飞书应用的风险（P0）

`lark-cli config show` 把 JSON 输出到 stdout、把配置文件路径提示输出到 stderr。初版脚本把两路拼接后整体解析，解析失败被当作"未配置"，于是再次执行 `config init --new`，重新发起了一次应用注册。发现后立即中断，返回 `app registration failed: app registration cancelled: context canceled`，未产生第二个应用。

若无人值守运行，这一步会重复创建自建应用并覆盖 `~/.lark-cli/config.json`。

修正做法：分别解析 stdout 与 stderr，优先 stdout；并且只以 `config show` 的 `appId` 是否存在判断是否需要初始化。

### 4.2 登录判定用错字段（P1）

初版以 `auth status --json` 的顶层 `ok` 判断登录。实际上 bot 身份就绪时该命令返回成功，而用户身份仍可能是 `missing`：

```json
{ "identities": { "bot": { "status": "ready" }, "user": { "status": "missing" } } }
```

结果是脚本跳过登录直接写配置，而插件后续用 `--as user` 访问知识库会失败。唯一可靠判据是 `identities.user.status == "ready"`。

### 4.3 把退出码当作登录失败（P1）

`auth login --recommend` 在部分权限被用户跳过时以非零码退出。实测跳过了日历、邮箱、OKR、考勤等域，核心域（`wiki`、`base`、`docs`、`drive`）已授权，登录实际成功，但脚本据退出码直接终止并打印"登录未完成"。

修正做法：登录后重新查询 `auth status`，以身份状态为准。

### 4.4 默认 profile 不可直接使用（P0）

技能与 `SETUP_DEFAULTS` 给出的默认 profile `cli_aa20f40faa785d11` 是插件作者的 app ID。本机新建应用后实际 profile 是 `cli_aa504d698da1dd1a`，两者不一致。若按默认值写入配置，后续所有 CLI 调用都会因 profile 不存在而失败。

修正做法：用 `profile list` 取 `active: true` 的 `name`，或用 `config show` 的 `appId`，显式传给 `write_config`。

### 4.5 `write_config` 入参契约未写入技能（P2）

工具入参是 `{ config: { lark, retrieval }, create_local_dirs?, dry_run? }`，不是平铺字段。按平铺结构调用会返回：

```
CONFIG_INVALID: 配置字段 "config" 必须提供且为普通对象。
```

技能文档的配置项表格按字段列出，容易让人误以为直接平铺。

### 4.6 `lark-cli` 安装链路在本机全部受阻（P1）

三个独立故障叠加：

- npm 默认缓存目录不可写：`npm error code EPERM ... mkdir 'C:\Users\lvan\AppData\Local\npm-cache'`。改用 `--cache .npm-cache` 可绕过。
- 官方安装器的全局安装步骤失败，只提示 `Failed to install globally. Run manually: npm install -g @larksuite/cli`。
- 包的 `postinstall` 用 `curl` 下载二进制，在 Windows 上报 TLS 凭据错误：`curl: (35) schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`。改用 Node `fetch` 下载同一官方地址后正常，压缩包 15,093,400 字节，sha256 `b13a5d71...da1ccdc`。

另需注意 npm 新版的脚本拦截：全局安装时提示 `1 package has install scripts not yet covered by allowScripts: @larksuite/cli@1.0.98 (postinstall: node scripts/install.js)`，`esbuild` 的 postinstall 同样被拦。本次因为包内自带 `bin\lark-cli.exe` 未被影响，但这属于运气而非设计。

### 4.7 环境辅助问题（P2）

- `esbuild` CLI 在沙箱内构建时报 `Cannot read directory "../../../../../..": Access is denied`，需要用 Node API 显式指定 `absWorkingDir` 或改为沙箱外执行。
- 该轮 `apply_patch` 与 `functions.exec` 不可用，只能用 `exec_command` 与 Node 运行时兜底，属于宿主环境问题，与插件无关但会拖慢排障。

---

## 五、设计上做得好的地方

- `health` 逐项检查且单点失败不中断后续，`detail` 只放路径、版本、`table_id` 与 token 前缀，未泄漏敏感值。
- `write_config` 的 dry-run 语义清晰，返回可读 diff、`created_dirs` 与 `applied_defaults`，能直接看出本次套用了哪些默认键。
- 配置写入使用同目录临时文件加原子替换。
- `init_knowledge_b` 用 `validated` / `drift` / 建表三类结果区分处理路径，`drift` 不自动改表，边界清楚。
- `INDEX_NOT_BUILT` 在首次同步前给出 warn 而非 fail，与实际的缓存降级策略一致。

---

## 六、改进建议

按优先级排列：

1. 插件分发里直接包含 `server/dist/server.mjs`，或在插件安装、首次加载时自动执行构建；启动器的错误提示应带上可复制的构建命令与依赖安装步骤。
2. `setup` 技能增加"环境前置条件"章节，明确列出需要出网、需要写 `~/.codex-script2shot`、以及无法提权时的退出条件。
3. 把本节 4.1 至 4.4 的修正固化为技能步骤：`config show` 解析规则、`identities.user.status` 判据、退出码与身份状态分离、profile 从 `profile list` 解析。
4. 将初始化流程做成插件自带的确定性脚本（类似本次临时构建的执行器），技能只负责编排与确认，避免每次由模型手写命令。
5. 在技能里补上 `write_config` 的完整入参形状示例。
6. 官网安装链路增加 Windows 回退：缓存不可写时自动选临时目录，下载优先用 Node 而不是 `curl`。
7. 首次 `$knowledge-sync` 提供 `--dry-run` 清单确认，与 `setup` 的整批确认语义对齐。

---

## 七、下次初始化清单

1. 确认 `~/.codex/plugins/cache/.../server/dist/server.mjs` 存在，不存在先构建。
2. 确认 `lark-cli` 可用（`--version`），并确认 npm 脚本拦截策略不会影响其安装。
3. 确认当前会话可出网、可写 `~/.codex-script2shot`；否则先申请提权。
4. 记录 `config show` 的 `appId` 与 `profile list` 的 active profile。
5. 执行设备授权登录，完成后以 `identities.user.status == "ready"` 复核。
6. `write_config` 先 dry-run，核对 `applied_defaults` 与 `created_dirs` 后再写入。
7. `init_knowledge_b` 先 dry-run，`action: "validated"` 只需回填 `table_id`；出现 `drift` 时人工处理。
8. 复查 `health`，`index` 为 `missing` 属预期，交给首次 `$knowledge-sync` 建立索引。

---

## 八、遗留风险

- 本次为让插件在本机可用，在插件缓存目录内补建了 `server/dist/server.mjs` 与 `server/node_modules`。插件更新或重新安装时该目录可能被替换，构建产物会丢失，需要重新构建。
- 工作区保留了一份备用 `lark-cli` 副本与初始化脚本（`tools\lark-cli`、`work\script2shot-server-setup`、`tools\run-script2shot-setup.cmd`），当前配置已不引用它们，可按需清理。
- 首次知识同步尚未执行，本地索引为空，`$script2shot` 的检索会走缓存降级路径。