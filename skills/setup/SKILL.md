---
name: setup
description: 安装后的一次性引导：由 AI 通过 scripts/setup_bootstrap.mjs 完成环境自举、lark-cli 安装、登录编排与配置写入；人类只做浏览器操作、一次写入确认与异常路径的授权决策。
---

# setup

插件安装后的初始化引导。AI 负责全部确定性步骤，人类只做三类动作。本 Skill 不写
原始库；AI 库的建表由 `init_knowledge_b` 负责；不执行知识同步，只在最后提示用户
可以在需要时运行一次 `$knowledge-sync`。

## 环境前置与执行责任

- 脚本位置：插件根目录下的 `scripts/setup_bootstrap.mjs`。从本 Skill 文件定位插件
  根目录：`skills/setup/SKILL.md` 向上两层即插件根，再进 `scripts/`；Windows 用
  `scripts/setup_bootstrap.cmd`，POSIX 用 `scripts/setup_bootstrap`（两个薄包装
  与 MCP 启动器用同一套 Node 解析顺序）。
- 必须由 AI 执行：环境探测、补装 Node 运行时、安装 lark-cli、构建并自检 MCP
  Server、检查飞书应用、编排设备登录、解析活动 profile、读写配置与建表。
- 人类只做三类动作：浏览器操作（应用创建、设备授权）、一次写入确认、异常路径的
  授权决策（提权申请、允许系统级安装、`--force-init` 同意）。
- 命令一律不转交给用户：需要提权时向用户说明影响并申请提权后重跑；网络受限时
  列出需要放行的域名后重试；完全不允许提权是终态，说明需要用户改什么，然后停止。
- 本会话即使 MCP 未注册也能走完：配置写入与建表都通过 `call-tool` 走 stdio 调用
  已构建的 server；构建完成后新开会话即可正常使用其余技能。

## 流程（八步）

每步都读脚本返回的 JSON；失败按 `error.code` 走「失败处理」表，不要自行改命
令序列。

1. `doctor`：只读探测，读 `checks[]` / `capabilities` / `next_actions`。`dist` 缺失
   或 Node 不满足要求时继续自愈，不用问用户。
2. `ensure-runtime`：复用系统 `node` + `npm`（`>= 24`）；否则补装私有 Node
   （下载 + `SHASUMS256.txt` 校验 + 解压），成功输出 `node_path` / `npm_path`。
3. `build-server`：`npm ci` + `npm run build`，随后做 `initialize` + `tools/list`
   握手自检；成功输出 `dist_path` 与 `tools_count`（必须 >= 1）。
4. `install-cli`：复用 `>= 1.0.98` 的 lark-cli，否则装到私有 prefix；只有用户
   明确同意系统级安装时才带 `--allow-global`。
5. `ensure-app`：`config show` 的 stdout 里有 `appId` 就直接复用（其余字段一律
   丢弃）；没有 `appId` 时先向用户说明，取得同意后带 `--create` 重跑，必要时再带
   `--force`。
6. `auth-login`：默认返回 `status: "pending_human"` 与 `verification_url` /
   `user_code`；请用户在浏览器完成授权，然后用 `auth-login --device-code <code>`
   续跑，直到 `status: "ready"`（判定只看 `identities.user.status == "ready"` 且
   `available == true`，退出码不作判据）。
7. 组装配置 → 只读预检 → 预览 → 一次确认 → 执行（见下一节）。
8. `call-tool health`：逐项复查并汇报；`index` 为 `INDEX_NOT_BUILT` 在首次同步前
   属预期。

### 第 7 步展开

1. `profile`：解析唯一活动 profile；`PROFILE_AMBIGUOUS` 时停止并说明冲突，不切换
   profile。
2. `call-tool read_config`：读取既有配置的掩码快照（`base_b_prefix`），用于预览
   「哪些字段会被保留」。
3. 组装 config：默认**只**传显式替换项与本次解析出的 `profile` / `cli_path`；其余
   字段（`base_b`、`space_a`、两个 `table_id`、`project_roots`、
   `retrieval.default_top_k`）的「保留」由 `write_config` 的 `preserve_existing`
   （缺省 `true`）在服务端完成，掩码字段不经过对话。
4. `call-tool health`（带 `pending_config`）：写入前的只读预检，检查默认知识库
   可达性；不写盘。
5. `call-tool write_config`（`dry_run` 缺省 true）：把 `diff`、`created_dirs`、
   `preserved_existing[]`、`applied_defaults[]` 翻译成人话摘要。
6. `call-tool init_knowledge_b`（`dry_run` 缺省 true，`pending_config` 与 config
   同形状）：把 `action`、`drift`、`warnings`、`tables` 讲清楚。
7. 摘要里说明「将要写入什么、哪些既有值会被保留、要建哪些表」，请用户确认一次。
8. 得到确认后执行 `call-tool write_config`（`dry_run: false`）与
   `call-tool init_knowledge_b`（`dry_run: false`），然后 `call-tool health` 复查。

## 人类动作与验收口径

| 类型 | 内容 | 次数 |
| --- | --- | --- |
| 浏览器操作 | 应用创建（仅本机无应用时）、设备授权 | 常规路径 1–2 次 |
| 写入确认 | 对一次只读预览的人话摘要回复「可以」 | 常规路径 1 次 |
| 授权决策 | 提权申请、允许系统级 npm 安装、`--force-init` 同意 | 仅异常路径，按需各 1 次 |

- 常规路径（本机已有应用、网络与提权可用、默认知识库可达）只出现前两类；授权决策
  只在结构化错误码触发时出现，必须由 AI 说明影响（改什么、风险是什么、不做的
  后果），由用户在对话里回答。
- 另有一类可选输入：默认知识库不可达且用户主动要求替换时，用户可以粘贴 Wiki /
  Base 链接（只粘链接，不填 token、不填路径），由 AI 解析并回显确认。

## 配置决策

重跑 setup 时按 **用户显式替换 > 既有非空值（保留）> `SETUP_DEFAULTS`（默认）**
决定每个字段，由 `write_config` 落地；`lark.profile` **没有默认值**，必须由本次
解析结果显式提供。预览必须同时展示 `preserved_existing[]` 与 `applied_defaults[]`。

默认知识库的 token 由工具侧套用，AI 不把 `base_b` 明文带进对话或命令行；所有回显
只保留前 6 位加 `…`。

## 默认知识库不可达

`call-tool health`（带 `pending_config`）报 `KB_A_UNREACHABLE` /
`KB_B_UNREACHABLE` 时**不进入写入确认**，按下面两条路径之一处理：

- 权限类（应用未被加入该空间 / Base）：停止，用一句话说明「需要管理员把本机自建
  应用加入该资源」以及所需 scope，等用户处理后重跑；不重试、不降级。
- 用户主动要求替换：请用户粘贴 Wiki / Base 链接，由 AI 用 lark-cli 解析成 id 并
  回显确认，然后重新走预览 + 确认。

## 工具入参形状

- `write_config`：`{ config: { lark, retrieval }, dry_run }`（不是平铺字段）；
  `config.lark` 含 `cli_path` / `profile` / `space_a` / `base_b` /
  `knowledge_cards_table_id` / `sync_state_table_id` / `project_roots`，
  `config.retrieval` 含 `default_top_k`。
- `init_knowledge_b` 与 `health` 的 `pending_config` 与上面的 `config` 同形状；
  `init_knowledge_b` 只在 `dry_run` 预览时接受它，执行路径携带会返回
  `CONFIG_INVALID`。
- 示例与工具 schema 不一致时以工具 schema 为准。

## 失败处理

按脚本的 `error.code`（或 `health` 的 `checks[].detail.code`）处理：

| 错误码 | 处理方式 |
| --- | --- |
| `PLUGIN_DIR_READONLY` | 说明构建需要写插件目录，申请提权后重跑 `build-server` |
| `NEEDS_ESCALATION` | 向用户申请提权（说明改什么、风险、不做的后果），得到允许后重跑；完全不允许提权是终态 |
| `NETWORK_BLOCKED` | 列出需要放行的域名（`nodejs.org` / `registry.npmjs.org` / `github.com`）后重试 |
| `NODE_UNAVAILABLE` / `NODE_DOWNLOAD_FAILED` / `NODE_CHECKSUM_MISMATCH` | 说明是运行时缺失、下载失败还是校验不符；校验不符立即停止，不得绕过 |
| `NPM_UNAVAILABLE` | 说明当前平台/架构不支持自动补装，停止并等用户处理 |
| `NPM_INSTALL_FAILED` / `NPM_SOURCE_FAILED` | 说明 npm 安装或依赖源失败；核对源与权限后重试 |
| `BUILD_TOOL_BLOCKED` | 说明宿主策略拦住了构建器安装脚本，属终态；只有用户决定允许该脚本才能继续，不得静默绕过 |
| `CLI_DOWNLOAD_FAILED` / `CLI_CHECKSUM_MISMATCH` / `CLI_VERSION_TOO_OLD` | 说明 lark-cli 安装链路失败；校验不符立即停止 |
| `APP_NOT_CONFIGURED` | 向用户说明要新建自建应用，取得同意后重跑 `ensure-app --create` |
| `APP_REGISTRATION_PENDING` | 说明 lark-cli 在 agent 上下文里拒绝创建；取得用户明确同意后才加 `--force` 重跑 |
| `APP_REGISTRATION_FAILED` | 展示（已掩码的）失败原因，确认浏览器操作是否完成，必要时重试 |
| `AUTH_LOGIN_PENDING` | 请用户在浏览器完成设备授权，然后用 `auth-login --device-code <code>` 续跑 |
| `AUTH_LOGIN_FAILED` | 复核身份仍是 `missing` / 未 `available`；重新发起或续跑登录 |
| `PROFILE_AMBIGUOUS` | 说明活动 profile 不唯一，请用户确认；插件不切换 profile |
| `SERVER_BUILD_FAILED` / `SERVER_HANDSHAKE_FAILED` | 构建失败或 `tools/list` 为空：不得宣称成功，报告 `dist_path` 与失败原因 |
| `TOOL_CALL_FAILED` | 工具调用失败：按返回的错误详情处理，必要时重新构建后重试 |
| `USAGE_ERROR` | 参数用法错误：修正调用参数后重试，不要把命令交给用户 |
| `CONFIG_INVALID` | 配置损坏或字段缺失：把现状讲给用户听，按 `details.missing_keys` 补齐；不静默覆盖 |
| `CONFIG_MISSING` | 配置不存在：继续走本流程生成配置 |
| `KB_TABLE_AMBIGUOUS` / `KB_READ_FAILED` / `KB_WRITE_FAILED` | AI 库同名表冲突、读取失败或建表失败：按 `details` 处理后再重跑 dry-run |
| `drift`（不是错误） | `init_knowledge_b` 返回 `action: "drift"` 时停止执行，把 `drift[]` 讲清楚，等人工处理后再重跑 |
| `INDEX_NOT_BUILT` | 首次 `$knowledge-sync` 前属预期；提示用户可在需要时运行该 Skill |

## 禁止项

- 不把命令、路径、参数交给用户代跑，也不要求用户打开终端；需要终端能力时由 AI
  申请提权执行。
- 不复述 token；`base_b` 与用户粘贴的链接 token 只显示前 6 位加 `…`。
- 不调用 lark-cli 的 profile 切换 / 删除命令；插件只读 `profile list`，不一致时
  重新解析活动 profile 并更新本地配置值。
- 不跳过 dry-run：`write_config` 与 `init_knowledge_b` 都必须先预览、展示摘要、
  得到用户确认后再执行 `dry_run: false`。
- 不写原始库；不在 setup 内执行 `$knowledge-sync`。
- 不把 `config show` 的输出整体回显或落盘：只取 `appId`，`appSecret` 一律丢弃。
