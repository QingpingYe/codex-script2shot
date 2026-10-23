# setup 自动化设计：AI 执行、人类只做授权与确认

日期：2026-10-23（Asia/Shanghai）
状态：已实施（2026-10-23）
范围：`setup` 首次初始化链路（`skills/setup` + `scripts/` + MCP `health` /
`write_config` / `init_knowledge_b` + `docs/architecture.md` §7、§8、§9.1、§13）

## 1. 为什么做

同事在另一台机器上按 `script2shot:setup` 初始化时，得到的体验是"AI 不断让我在
终端里敲命令"，而他不熟悉命令行。复盘（`docs/script2shot-初始化复盘报告.md`）
的问题已被核实，其中与体验直接相关的三条是：

- 插件分发缺 `server/dist/server.mjs`，MCP 无法启动，`setup` 第一步要调的
  `health` 不存在，AI 只能退化为手写命令；
- 手写命令路径要过 exec 沙箱与审批策略，AI 无法把"安装 lark-cli / 写 home /
  出网"做完，于是把命令转交给人类；
- 技能没有声明"哪些步骤必须由 AI 执行、失败时该怎么办"，也没有规定命令不应
  转交用户。

结论：要减少人类操作，靠"把命令写得更清楚"不够，必须让确定性步骤有可复用的
执行体，并且把"不可自动化的人类动作"限定在浏览器操作与同意/拒绝两类上。

## 2. 目标 / 非目标 / 反目标

**目标**

- 常规路径（本机已有应用、网络与提权可用）中，人类只做两类动作：浏览器操作
  （最多 2 次）与一次写入确认。异常路径最多追加结构化的"同意 / 拒绝"
  （提权申请、允许系统级安装、`--force-init`）；人类自始至终不执行命令、
  不填写参数。验收口径见 §5.1。
- 确定性步骤（装 lark-cli、构建 MCP Server、设备码登录编排、读活动 profile、
  调用写入工具）由插件自带脚本执行，行为可测试、可复跑、幂等。
- `setup` 在 MCP 未注册或未构建的会话里也能走完，不依赖"先重启再配置"。
- 修复已核实的 P0/P1：分发缺构建产物、默认 profile 取作者机器本地值。

**非目标**

- 不改知识同步范围与节奏：setup 仍不执行 `$knowledge-sync`。
- 不引入新的生产依赖，不更换技术栈（Node >= 24 为既有要求）。
- 不改变 `knowledge-sync` / 三个阶段技能的流程与产物。
- 不调用 `profile use` / `profile remove`：profile 不一致时改配置值，不切
  lark-cli 的全局 profile（§5.3）。

**反目标（即使做出来也算失败）**

- 为了少一次确认，把写配置或建表改成不预览直接执行。
- 把敏感值（`appSecret`、`base_b` 全文）带进对话、日志或产物。
- 把 lark-cli 安装逻辑复制一份到技能文档里，让命令序列存在两个来源。

## 3. 约束

- 文档优先（`AGENTS.md` §2）：本设计批准后，先改 `docs/architecture.md` 对应小节，
  再改技能、脚本与测试，同一次改动内保持文档、实现、测试一致。
- 外部写操作先预览再确认（`AGENTS.md` §3）。本设计把"预览"收敛为一次只看人话
  摘要的确认，但预览仍然先于任何写入发生。
- 不新增生产依赖；脚本只允许使用 Node 内置能力与系统既有工具（`npm`、`tar` /
  `unzip`、`curl` 仅作回退）。
- lark-cli 自身的 agent 约束（以 `lark-cli` 1.0.98 `--help` 实测为准，2026-10-23）：
  `config init --new` 在 agent 上下文里默认拒绝并建议 `config bind`；插件不得自行
  `profile use` / `profile remove`。
- 本地写范围白名单：插件 `server/`（构建产物）、`~/.codex-script2shot/`
  （配置、数据目录、私有 CLI、私有 Node 运行时、工具入参临时文件）、系统临时
  目录（仅限 npm 缓存这类无敏感内容的临时数据；含敏感值的文件不得落在系统临时
  目录，见 §8）。`~/.lark-cli/` 只由 lark-cli 自己写。

## 4. 方案对比与选择

| 方案 | 做法 | 取舍 |
| --- | --- | --- |
| A 只改技能 | 技能里规定"AI 自己执行命令"，补齐安装/构建/登录步骤 | 零新代码、最快；仍靠模型每次手写命令，复盘 4.1–4.3 那类漂移会复发，且命令序列不可测 |
| **B 技能管编排 + 自带确定性脚本**（选定） | 新增无依赖脚本承担确定性步骤，技能只负责调用、翻译摘要、收集确认 | 行为确定、可测、可复用，能固化复盘的坑；代价是新增脚本契约与相应测试 |
| C 全部做成 MCP 工具 | 装 CLI、构建、登录都由 MCP 工具提供 | AI 侧最干净；但"未构建则 MCP 不可用"正好卡住最需要自动化的第一步，且给本地服务新增下载安装的权限面，评审成本最高 |

选 B 的理由：它同时解决"人类被要求敲命令"和"第一步依赖尚不存在的 MCP"两个
问题，且不需要改变既有工具语义（只做一处小扩展，见 §5.4）。

## 5. 设计

### 5.1 人机边界

人类动作分三类，全部是"浏览器里操作"或"回答同意 / 拒绝"，没有终端命令：

| 类型 | 内容 | 出现次数 |
| --- | --- | --- |
| 浏览器操作 | 应用创建（仅本机无应用时）、设备授权 | 1–2 次 |
| 写入确认 | 对一次只读预览的人话摘要回复"可以" | 常规路径 1 次 |
| 授权决策 | 提权申请、允许系统级 npm 安装、`--force-init` 同意 | 仅异常路径，按需各 1 次 |

验收口径：常规路径（本机已有应用、网络与提权可用、默认知识库可达）下只出现
前两类；授权决策类只在结构化错误码触发时出现，必须由 AI 发起并附一句话影响
说明（改什么、风险是什么、不做的后果），由用户在对话里回答，而不是被要求去
执行命令。

另有一条**可选**的人类输入：默认知识库不可达且用户主动要求替换时，用户可以
粘贴 Wiki / Base 链接（只粘贴链接，不填 token、不填路径），由 AI 用 lark-cli
解析与预览；该分支不改变默认路径的验收口径。

AI 动作：环境探测、安装 lark-cli、构建并自检 MCP Server、发起/轮询登录、解析
活动 profile、组装配置、预览、执行、复查 `health`。

人类不承担：任何终端命令、任何路径/参数填写、profile 切换。

### 5.2 脚本：`scripts/setup_bootstrap.mjs`

纯 ESM Node 脚本，零依赖，可在 `server/node_modules` 不存在时运行。配套
`scripts/setup_bootstrap`（POSIX）与 `scripts/setup_bootstrap.cmd`（Windows）
两个薄包装，按既有 `launch_script2shot_mcp*` 的同一顺序解析 Node 运行时。

子命令（全部输出 JSON 到 stdout；进度与人类可读信息走 stderr；敏感值一律掩码）：

| 子命令 | 作用 | 关键输出 |
| --- | --- | --- |
| `doctor` | 只读探测：平台、Node 版本与来源、插件目录可写性、网络可达性、`~/.codex-script2shot` 可写性、lark-cli 路径/版本、配置与 `dist` 是否存在、索引状态 | `checks[]` + `next_actions[]` + `capabilities`（`can_write_home` / `can_reach_network` / `can_write_plugin_dir` / `can_build`） |
| `ensure-runtime` | 构建用 Node 运行时：系统 `node` + `npm` 满足 `>= 24` 则复用；否则解析官方 `https://nodejs.org/dist/index.json`，取满足 `>= 24` 的最新 LTS，下载同版本目录下的平台归档并校验同目录 `SHASUMS256.txt`，解压到 `~/.codex-script2shot/runtime/node-<version>/`；版本可用配置项固定（默认 ">= 24 的最新 LTS"），解析结果与来源 URL / 校验值写入输出 | `node_path` / `npm_path` / `version` / `source`（`system` / `private`）/ `archive_url` / `checksum_source` |
| `install-cli` | 安装或修复 lark-cli：①已存在且 `>= 1.0.98` 则复用；②`npm install --prefix ~/.codex-script2shot/cli`（缓存指向系统临时目录，绕开 home 内不可写的 npm 缓存）；③npm 脚本拦截（`allowScripts`）或 postinstall 失败导致二进制缺失时，直接执行包内 `scripts/install.js`，不依赖 npm 生命周期钩子；④Node `fetch` 下载官方归档 + 校验 sha256 + 解压到同一私有 prefix；系统级 `npm install -g` 仅在用户显式授权后作为回退 | `cli_path` / `version` / `source` |
| `build-server` | 在插件 `server/` 下执行 `npm ci`（缓存指向系统临时目录）+ `npm run build`，随后以 stdio 握手自检（`initialize` + `tools/list` 非空）。失败必须分类：网络/权限 → `NEEDS_ESCALATION`；npm 源 → `NPM_SOURCE_FAILED`；构建器安装脚本被宿主策略拦截（`esbuild` 二进制缺失）→ `BUILD_TOOL_BLOCKED`（不静默绕过，交用户决定是否允许该安装脚本）；插件目录只读 → `PLUGIN_DIR_READONLY` | `dist_path` / `tools_count` / `failure_class` |
| `ensure-app` | 应用守卫：解析 `config show` 的 **stdout JSON**，有 `appId` 即复用（只取 `appId`，丢弃其余字段；stderr 只作诊断，不参与解析）；没有时按 §5.1 引导一次浏览器内的应用创建；`lark-cli` 在 agent 上下文拒绝时，先取得用户明确同意再用其文档化的 `--force-init`，绝不静默重试 | `status`（`reused` / `created` / `pending_human`）、`app_id` |
| `auth-login` | 设备码编排：默认 `--domain wiki,base,docs,drive` 发起 `auth login --no-wait --json`，输出授权链接与用户码；`--device-code <code>` 续跑，并以 `identities.user.status == "ready"`（且 `available == true`）复核身份。**退出码与顶层字段都不作为判据**：用户跳过部分域导致非零退出时，仍以身份复核结果为准 | `status`（`pending_human` / `ready`）、`verification_url`、`user_code` |
| `profile` | 只读 `profile list`，返回唯一 `active: true` 的 `name` | `profile` |
| `call-tool <name>` | 以子进程方式启动已构建的 MCP Server，走 stdio JSON-RPC 调用指定工具。入参默认从 **stdin** 读取；stdin 不可用时才退回私有临时文件（`~/.codex-script2shot/tmp/`、最低权限、子进程启动后立即删除、删除失败记结构化 warning），不得使用系统临时目录，脚本不得把入参内容写进日志 | 工具原始 JSON 结果（由脚本保证不落盘、不回显敏感字段） |

退出码：`0` 成功；`1` 失败（AI 读 `error.code` 处置）；`2` 需要人类动作或提权
（对应 `APP_REGISTRATION_PENDING` / `AUTH_LOGIN_PENDING` / `NEEDS_ESCALATION`）。

错误码（SCREAMING_SNAKE，供技能失败处理表引用）：`NODE_UNAVAILABLE`、
`NODE_DOWNLOAD_FAILED`、`NODE_CHECKSUM_MISMATCH`、`NPM_UNAVAILABLE`、
`NEEDS_ESCALATION`、`NETWORK_BLOCKED`、`PLUGIN_DIR_READONLY`、
`NPM_INSTALL_FAILED`、`NPM_SOURCE_FAILED`、`BUILD_TOOL_BLOCKED`、
`CLI_DOWNLOAD_FAILED`、`CLI_CHECKSUM_MISMATCH`、
`CLI_VERSION_TOO_OLD`、`APP_NOT_CONFIGURED`、`APP_REGISTRATION_PENDING`、
`APP_REGISTRATION_FAILED`、`AUTH_LOGIN_PENDING`、`AUTH_LOGIN_FAILED`、`PROFILE_AMBIGUOUS`、
`SERVER_BUILD_FAILED`、`SERVER_HANDSHAKE_FAILED`、`TOOL_CALL_FAILED`、`USAGE_ERROR`。

**lark-cli 安装策略（本设计裁决）。** 复用门槛是版本 `>= 1.0.98`（本设计全部
命令与解析逻辑的实测基线，见 §11）；低于该版本或修复失败时按"安装"处理，失败
返回 `CLI_VERSION_TOO_OLD`。**安装版本固定为 `1.0.98`**（不取 `latest`，避免
不同机器拿到不同版本导致解析逻辑漂移），可通过配置项显式覆盖并在输出里记录。
安装优先走**用户私有 prefix**：`npm install
--prefix ~/.codex-script2shot/cli @larksuite/cli@1.0.98`，缓存目录指向系统
临时目录；`~/.codex-script2shot/cli/node_modules/@larksuite/cli/bin/lark-cli.exe`
即为 `cli_path`。系统级 `npm install -g` 只作为显式授权后的回退，不与私有
prefix 并存选择。该目录同时加入 `resolve_lark_cli()` 的"常见目录"候选，使
`doctor` / `health` 在不写配置时也能发现它（§7.3 需同步）。

**下载与代理（本设计裁决）。** 所有下载只允许 `https` 且限定官方域
（`nodejs.org` / `registry.npmjs.org` / `github.com` 的 larksuite cli 发布页，
允许配置企业镜像替换域名）；校验文件必须与归档来自**同一版本目录**。脚本不
自带代理栈：企业代理由宿主网络层处理，失败返回 `NETWORK_BLOCKED`，并在
`next_actions` 里写清"需要放行的域名"，不把命令交给用户。

### 5.3 技能：`skills/setup/SKILL.md` 改写为"AI 执行契约"

- 新增「环境前置与执行责任」小节：脚本位置（相对本 Skill 文件定位插件根目录）、
  必须由 AI 执行的步骤、提权与网络受限时的处置（向用户申请提权，而不是转交
  命令）。
- 流程改为：`doctor` → `ensure-runtime` → `build-server` → `install-cli` →
  `ensure-app` → `auth-login`（人类只做浏览器操作）→ `profile` → 组装配置 →
  只读预览 → 一次确认 → 执行 → `health` 复查。
- 明确禁止项：不把命令、路径、参数交给用户代跑；不复述 token；`profile use`
  永不调用。`health` 报 `LARK_PROFILE_MISMATCH` 时，AI 重新解析活动 profile 并
  用 `write_config` 更新配置值（预览 + 确认），把差异消掉。
- 技能消费 `health` 的 `detail.code`，不得把工具返回里的命令式文案转述给用户。
  因此 `health` 的 `LARK_PROFILE_MISMATCH` 文案必须改成结构化差异 + "运行
  $setup 对齐配置"，不再出现 `lark-cli profile use <name>`（§10 需同步
  architecture §7.3）。
- 组装配置前先按 §5.5 走"读既有配置 → 默认 / 保留 / 替换"决策，预览里同时给出
  被保留的既有值（掩码）。
- 技能必须写出工具入参形状示例：`write_config` 是
  `{ config: { lark, retrieval }, dry_run }`（不是平铺字段），`init_knowledge_b`
  的 `pending_config` 与 `config` 同形状；示例与工具 schema 不一致时以工具为准。
- `build-server` 需要写插件目录，exec 沙箱内被拒时按 `NEEDS_ESCALATION` 处理
  （申请提权后重跑），不得改成让用户在终端里构建。
- 失败处理表按脚本错误码补齐，并保留既有 `CONFIG_INVALID` / `KB_*` 行。

### 5.4 MCP 工具面扩展（`pending_config` 与 `read_config`）

现状：`init_knowledge_b` 先读磁盘配置，因此"预览建表计划"必须发生在写入
`config.toml` 之后，天然带来第二次确认。

**（1）`pending_config` 契约（写死，不留实现空间）**。读工具统一接受这个可选
入参：`init_knowledge_b`（仅 dry-run）与 `health`（本来就是只读，无 dry-run
限制）语义一致——提供即替代磁盘配置。

- 形状与校验：与 `write_config` 的 `config` 同形状，并**复用同一个 normalizer**
  （同一份默认值、trim、必填与 `project_roots` 校验），不出现第二套规则。
- 替代语义：提供且校验通过时，本次调用**完全不读磁盘配置**；`base_b`、
  `cli_path`（含 `resolve_lark_cli()` 的路径解析）、`project_roots`、`retrieval`
  一律取自 `pending_config`。磁盘配置缺失、损坏或无效都不影响本次调用。
- 模式限制：`init_knowledge_b` 仅 `dry_run: true` 允许，`dry_run: false` 携带
  `pending_config` 直接返回 `CONFIG_INVALID`（fail-closed，防止"配置没写就
  建表"）；`health` 本来就是只读工具，不受 dry-run 限制。
- profile：`pending_config` 必须显式含 `lark.profile`（默认值已删除，见下）；
  缺失时按 `CONFIG_INVALID` + `details.missing_keys` 返回。
- schema：`server/src/index.ts` 的 `init_knowledge_b.inputSchema` 增加
  `pending_config`，并保持 `additionalProperties: false`。
- 回执：成功结果新增 `config_source: "pending" | "disk"`，供调用方与测试断言。
- `health` 侧：入参 schema 同样新增 `pending_config`（保持
  `additionalProperties: false`），返回体加 `config_source`；未提供时行为与
  现在完全一致。

**（2）新增只读工具 `read_config`**：返回 `exists` / `path` 与掩码后的配置
快照（`cli_path`、`profile`、`space_a`、`base_b` 前 6 位、两个 `table_id`、
`project_roots`、`retrieval`），不写任何文件；供 §5.5 的"保留既有配置"决策使用。

**（3）取消 `lark.profile` 默认值**：`SETUP_DEFAULTS` 删除 `profile`，
`write_config` 不再回填（`applied_defaults` 不再列出 `lark.profile`），
`setup` 必须显式传入由 `profile` 子命令解析出的活动 profile。`health` 的
profile 比对逻辑不变（仍是 warn、不自动切换），但文案按 §5.3 改。

**（4）`write_config` 的"显式 > 既有 > 默认"语义（补齐 §5.5 的可实现性）**。
`read_config` 只回掩码值，AI 拿不到 `base_b` 原值，因此"保留既有配置"必须由
工具完成，不能指望调用方原样回传。契约：

- 新增可选入参 `preserve_existing`（缺省 `true`）与回执字段
  `preserved_existing: string[]`；`applied_defaults` 只列出真正套用默认值的键；
- 逐字段判定：显式传入的值（含显式空数组）优先 → 否则当
  `preserve_existing === true` 且磁盘上该字段非空时保留 → 否则套
  `SETUP_DEFAULTS`；
- `lark.profile` 不参与默认回填：undefined 时先尝试保留磁盘值；磁盘也没有时
  返回 `CONFIG_INVALID` + `details.missing_keys: ["lark.profile"]`；
- `preserve_existing: false` 时忽略磁盘值（保持"纯默认"的旧语义，供测试与
  显式重写使用）；
- 磁盘配置损坏时不得静默丢弃：返回 `CONFIG_INVALID`，要求先人工处理或显式传
  `preserve_existing: false`。

### 5.5 配置来源与重跑策略

**既有配置优先，且由工具落地。** 决策规则 **用户显式替换 > 既有非空值（保留）
> `SETUP_DEFAULTS`（默认）** 由 `write_config` 的 `preserve_existing`（§5.4）
在服务端执行：AI 只需传显式替换项与解析出的 `profile` / `cli_path`，`base_b`
这类只回掩码的字段由工具保留，不经过对话。setup 每次仍先 `read_config`，用途是
把"哪些字段会被保留（掩码）"讲给用户听：

1. 配置不存在：所有字段按"默认"处理（`profile` 除外，它必须由本次解析提供）；
2. 配置存在：`read_config` 的掩码快照用于预览与人工核对；
3. 两个 `table_id` 与 `cli_path` 在未显式替换时由 `preserve_existing` 保留；
4. `project_roots` 同理保留，只有配置不存在时才套默认映射。

**失败边界。** `write_config` 写入的内容已包含保留值与本次解析出的字段（含
`table_id`），回执用 `preserved_existing[]` 与 `applied_defaults[]` 分别列出保留项
与默认项；因此即使随后的 `init_knowledge_b` 失败，配置也不会比执行前更差。
`init_knowledge_b` 只覆盖它负责的两个 `table_id`。

**默认知识库与其不可达路径。** `space_a` / `base_b` 默认沿用插件默认知识库，
由工具侧套用默认值，AI 不把 token 带进对话或命令行。写入前的只读预检
（`health(pending_config)`）就先检查可达性；报 `KB_A_UNREACHABLE` /
`KB_B_UNREACHABLE` 时**不进入写入确认**，直接走下面两条路径之一：

- 权限类（应用未被加入该空间 / Base）：停止，用一句话说明"需要管理员把本机
  自建应用加入该资源"以及所需 scope，等用户处理后重跑；不重试、不降级；
- 用户主动要求替换：允许用户粘贴 Wiki / Base 链接，AI 用 lark-cli 解析成 id
  并回显确认（token 只显示前 6 位加 `…`），然后重新走预览 + 确认。

### 5.6 分发与自举

- `setup` 的第一步改为 `doctor`（脚本，不依赖 MCP）。发现 `dist` 缺失即调用
  `ensure-runtime` + `build-server` 自愈。
- 本机实测（2026-10-23）：插件清单没有安装 / 构建钩子可用字段，市场安装是纯
  git checkout；Codex 自带运行时目录只有 `node`，不带 `npm`。因此"缺 `dist`
  时能否自愈"取决于目标机器有没有 `npm`：`doctor` 必须把 `can_build` 作为独立
  能力项上报，无 `npm` 时由 `ensure-runtime` 自动补装 Node（2026-10-23 裁决：
  不提交构建产物，保持源码-only），只有在补装也无法完成（平台/架构不支持或
  下载被阻断）时才返回 `NPM_UNAVAILABLE` 并说明原因，而不是把命令交给人。
- 私有运行时只服务于构建与脚本自身；MCP 启动顺序与 `server/dist` 路径不变，
  不把私有运行时加进启动器候选。
- 配置写入与建表通过 `call-tool` 完成，因此**即使本会话的 MCP 连接未建立**，
  setup 也能走完；构建完成后新开会话即可正常使用其余技能。
- `scripts/launch_script2shot_mcp*` 的解析顺序、`server/dist` 路径与提示文案
  保持不变，只补一句"可由 `scripts/setup_bootstrap build-server` 自动完成"。

## 6. 首次初始化时序

```text
[AI] doctor                -> 需要提权/联网就先申请，不转交命令
[AI] ensure-runtime        -> 复用系统 node+npm；缺失或过旧则补装私有 Node
[AI] build-server          -> dist 缺失时构建，并做 stdio 握手自检
[AI] install-cli           -> 复用 / 私有 prefix / 包内安装器 / fetch+校验 四级回退
[AI] ensure-app            -> 有 appId 即复用
[人] 浏览器完成应用创建     <- 仅本机还没有自建应用时出现（1 次）
[人] 浏览器完成设备授权     <- 每台机器一次
[AI] auth-login --device-code -> 复核 identities.user.status == ready
[AI] profile               -> 解析活动 profile
[AI] call-tool read_config -> 既有配置掩码快照（不存在则全默认）
[AI] 组装 config：用户替换 > 既有保留 > 默认；默认知识库由工具侧套用
[AI] call-tool health(pending_config)             -> 默认知识库可达性预检（不写盘）
[AI] call-tool write_config(dry_run=true)         -> 配置 diff + 目录清单
[AI] call-tool init_knowledge_b(dry_run=true, pending_config) -> 表计划
[AI] 人话摘要 + 请确认
[人] 一次确认
[AI] call-tool write_config(dry_run=false)
[AI] call-tool init_knowledge_b(dry_run=false)
[AI] health                -> 逐项复查并汇报
```

## 7. 幂等与失败处置

- 所有子命令可重复执行：已存在即复用，已构建即跳过，已登录即跳过。
- 网络/提权受阻时返回结构化错误码，AI 的动作是"向用户说明并申请提权"，不是
  "把命令给用户"。
- 缺 `npm` 不是终态：`ensure-runtime` 会补装私有 Node（含 npm）；只有平台 /
  架构不受支持或下载被阻断时，才返回 `NPM_UNAVAILABLE` / `NODE_DOWNLOAD_FAILED`
  并在 `next_actions` 里给出唯一的下一步（重新申请提权或等网络恢复）。
- `APP_REGISTRATION_PENDING` / `AUTH_LOGIN_PENDING` 是正常中间态：AI 应等待用户
  完成浏览器操作后再续跑，不重复发起新的授权，也不重复创建应用（`ensure-app`
  以 `config show` 的 `appId` 为唯一守卫）。
- 宿主策略完全不允许提权（例如审批策略直接拒绝提权请求、或宿主未注册提权
  工具）时是**终态**：输出 `NEEDS_ESCALATION` 与"需要用户改什么"（放开审批或
  提供可写目录），然后停止并等用户处理；不得降级为把命令交给用户执行。
- `BUILD_TOOL_BLOCKED`（宿主脚本策略拦住 `esbuild` 等构建器安装）同样是终态：
  说明是宿主策略拦住了构建依赖，只有用户决定允许该安装脚本（或换到允许脚本的
  环境）才能继续。不得用 `--ignore-scripts` 之类的做法静默绕过后再宣称成功。
- 默认知识库不可达在**写入前**的只读预检里就会被发现，因此不会留下半成品配置；
  处置按 §5.5 的两条路径，不进入写入确认。
- 同一次 setup 里，每类授权决策最多向用户请求一次；用户拒绝即停，重复弹窗不算
  "自动化"。
- 建表路径出现 `drift` 时停止执行，按既有 `drift` 规则人工处理（这是真实的
  决策点，允许第二次确认）。

## 8. 安全

- 脚本与技能都不得回显 `config show` 的 JSON：该输出含 `appSecret`（2026-10-23
  实测）。只用 `appId`，其余字段一律丢弃。
- 默认知识库的值由工具侧套用，AI 不接触 `base_b` 明文，也不把它写进命令行；
  用户主动替换时粘贴的 token 只经 stdin / 私有临时文件传入，`read_config`
  与所有回显一律掩码（前 6 位加 `…`）。
- `call-tool` 入参默认走 stdin，不落盘；退化到私有临时文件时，文件放在
  `~/.codex-script2shot/tmp/`、权限最小化、子进程启动后立即删除，删除失败写
  结构化 warning（含路径，不含内容），且脚本与工具都不得把入参内容写进日志或
  错误详情。
- 日志、对话与错误详情沿用现有掩码规则：`base_b` 只保留前 6 位加 `…`。
- 所有下载（lark-cli 归档、Node 归档）都必须校验官方校验文件（`checksums.txt` /
  `SHASUMS256.txt`）里的 sha256，不匹配即中止并保留现场。
- 不写原始库；不调用 `profile use` / `profile remove`；不直接写 `~/.lark-cli/`。

## 9. 验证策略

- 脚本纯函数（命令构造、解析、掩码、回退决策）在新增 `server/tests/setup_bootstrap.test.ts`
  内用 vitest 直接导入 `.mjs` 测试；外部命令用 fake 可执行文件（沿用
  `server/tests/fixtures/fake-lark-cli*` 模式）。
- `pending_config` 契约测试（`init_knowledge_b` 与 `health` 两侧）：磁盘配置
  缺失 / 损坏 / 无效时提供 `pending_config` 仍可预览；`cli_path` 取自
  `pending_config`；`pending_config` 非法时按 `CONFIG_INVALID` 返回；执行路径
  （`dry_run: false`）带 `pending_config` 必须 `CONFIG_INVALID`。
- 重跑保护测试：先写入一份含自定义 `space_a` / `base_b` / 两个 `table_id` /
  `project_roots` / `default_top_k` 的配置，再只传显式替换项调用 `write_config`，
  断言上述字段一个都没被默认值覆盖，`preserved_existing[]` 列出保留项、
  `applied_defaults[]` 不含被保留的键；另补 `preserve_existing: false` 的
  "纯默认覆盖"反例与"磁盘配置损坏 → `CONFIG_INVALID`"用例。
- 默认知识库不可达测试：`health(pending_config)` 报 `KB_A_UNREACHABLE` /
  `KB_B_UNREACHABLE` 时返回结构化错误与管理员授权 / 替换资源两条下一步；
  技能契约侧断言"预检先于写入、遇错停止"的文本要求存在，端到端"确实没写盘"
  由 Task 14 的 live smoke 覆盖。
- `build-server` 失败分类测试：`esbuild` 安装脚本被拦时返回
  `BUILD_TOOL_BLOCKED`，且不产生"看似成功"的 `dist`（不静默绕过宿主策略）。
- `call-tool` 入参生命周期测试：stdin 路径不产生文件；私有临时文件路径在子进程
  启动后删除，删除失败返回结构化 warning，且入参内容不出现在日志或错误详情。
- `skills_contract` 测试补断言：setup 技能必须引用脚本子命令与三类人类动作
  （浏览器操作 / 写入确认 / 授权决策），不得出现"请用户运行命令"式指令，也不得
  透出 `health` 里 `lark-cli profile use` 这类命令式文案。
- `ensure-runtime` 的下载 / 校验 / 解压决策用 fake 网络与 fake 归档测试，
  断点：校验失败必须中止且不落地半成品；系统 `node`+`npm` 满足 `>= 24` 时
  不得发起下载。
- `ensure-app` 补守卫测试：`config show` 返回含 `appId` 的输出时不得触发
  任何创建动作（对应复盘 P0）。
- 包装脚本 smoke test：Windows 跑 `scripts/setup_bootstrap.cmd`、POSIX 跑
  `sh scripts/setup_bootstrap`（CI 在对应平台各跑一次最轻子命令，如 `doctor --help`）。
- 端到端演练（**手动 live smoke，不作为 CI 验收**）：在插件缓存目录删除
  `server/dist` 后，按技能从 `doctor` 跑到 `health`，全程不出现需要人类执行的
  命令。CI 只用 fake CLI、fake 网络与本地 MCP 合同测试，不访问真实飞书资源。

## 10. 需要同步更新的设计文档

- `docs/architecture.md` §7.1：分发与自举（脚本入口、Node 解析、构建自检、
  私有 Node 运行时的下载与校验策略；`server/dist` 仍不入库）。
- `docs/architecture.md` §7.3：`lark.profile` 默认值删除与来源改为活动 profile；
  `resolve_lark_cli()` 常见目录新增 `~/.codex-script2shot/cli`。
- `docs/architecture.md` §8：新增 `read_config`；`health` 与 `init_knowledge_b`
  的 `pending_config` 契约（含入参 schema）；`LARK_PROFILE_MISMATCH` 文案改为
  结构化差异 + "运行 $setup 对齐"，不再出现 `profile use` 命令。
- `docs/architecture.md` §9.1：setup 技能的职责、三类人类动作与重跑保留策略。
- `docs/architecture.md` §13：新增脚本错误码与处置。
- `skills/setup/SKILL.md`：按 §5.3 重写。

## 11. 外部事实与来源

| 事实 | 来源 | 检索日期 |
| --- | --- | --- |
| `auth login` 支持 `--no-wait` / `--json` / `--device-code` / `--domain` / `--exclude` / `--recommend` | `D:\lark-cli\lark-cli.exe auth login --help`（v1.0.98） | 2026-10-23 |
| `config show` 的 JSON 走 stdout 且含 `appSecret`；stderr 只有配置路径 | 本机实测（v1.0.98） | 2026-10-23 |
| `profile list` 输出 JSON 数组，含 `name` 与 `active` | 本机实测（v1.0.98） | 2026-10-23 |
| `auth status --json` 在用户身份缺失时仍以退出码 0 返回 | 本机实测（v1.0.98） | 2026-10-23 |
| 官方包 postinstall 在 Windows 走系统 `curl`，并随包提供 `checksums.txt` | `D:\lark-cli\package\scripts\install.js`、`checksums.txt`（v1.0.98） | 2026-10-23 |
| 市场安装为 git checkout，插件目录内不含 `dist` 与 `node_modules` | 本机插件缓存 + `.codex-marketplace-install.json` | 2026-10-23 |
| Codex 自带运行时目录只有 `node`，没有 `npm` | 本机实测 `%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\` | 2026-10-23 |
| 插件清单无安装 / 构建钩子字段（仅 session hooks、skills、mcpServers、apps） | 本机插件缓存内 12 份 `.codex-plugin/plugin.json` | 2026-10-23 |
| `server/dist/server.mjs` 单文件体积约 0.95 MB | 本仓库构建产物 | 2026-10-23 |
| Node.js 官方分发目录、`index.json` 与 `SHASUMS256.txt`（用于解析版本与校验） | `https://nodejs.org/dist/`，具体版本号与校验值在实现时按 §5.2 的解析规则取回并记录（本轮网络受限，未取回） | 待复核 |
| npm 新版会拦截未允许的安装脚本（复盘记录同时影响 `@larksuite/cli` 与 `esbuild`） | `docs/script2shot-初始化复盘报告.md` §4.6；本机 npm 11.19.1，未复现 | 待复核 |

## 12. 留给构建者

- Node 运行时解析在脚本包装层复用既有顺序，不在技能里重复。
- 归档解压（Node / lark-cli）用 `tar -xf`（Windows 10+ 自带 bsdtar）还是
  `Expand-Archive`，由构建者按最小可用原则选择并测试；两条路径都必须做到
  校验失败即中止、不落地半成品。
- `call-tool` 的最小 JSON-RPC 握手细节（协议版本、通知顺序、stdin 帧格式）由
  构建者按 `server/tests/mcp_handshake.test.ts` 的现有形状实现。
- npm 源与镜像配置项的命名与默认值（官方源优先）由构建者定，但必须可覆盖，
  并在输出里回显本次实际使用的源。

## 13. 裁决记录（2026-10-23）

评审回收的两个问题已由项目负责人裁决：

1. **应用来源：每台机器各自新建飞书自建应用。** 不把 `config bind` 做成默认
   分支；`ensure-app` 只负责"复用已有 / 引导新建"，且新建必须由用户在浏览器
   完成（`lark-cli` 在 agent 上下文拒绝时，取得用户明确同意后才用其
   `--force-init` 逃生口）。
2. **构建产物不随插件分发，保持源码-only。** `server/dist/` 继续留在
   `.gitignore`；没有 `npm` 的机器由 `ensure-runtime` 自动补装私有 Node
   （含 npm）后再构建，代价是首次初始化需要一次 Node 归档下载。

## 14. 复盘问题覆盖对照

对 `docs/script2shot-初始化复盘报告.md` 中经核实的问题逐条对照本设计，确认
没有遗留：

| 复盘条目 | 核实结论 | 本设计对应 | 覆盖 |
| --- | --- | --- | --- |
| 3.1 分发缺 `server/dist` | 成立（本机复现） | §5.6 自举、§6 时序、§9 演练、§13 裁决 2 | 是 |
| 3.2 需要提权/写 home 未声明 | 部分成立（设计路径走工具，不必然要提权） | §5.3 环境前置与执行责任、§7 | 是 |
| 3.3 提权通道窗口期 | 宿主相关，技能侧确无处置 | §5.2 错误码、§7 终态处置 | 是 |
| 4.1 重复创建飞书应用 | 成立（机制实测，含 `appSecret` 泄漏面） | §5.2 `ensure-app`、§7 守卫、§8 只取 `appId`、§9 测试 | 是 |
| 4.2 登录判据用错字段 | 成立（插件服务端已正确处理，需固化到手写路径） | §5.2 `auth-login` 判据 | 是 |
| 4.3 把退出码当登录失败 | 未复现，机制成立 | §5.2 `auth-login` 判据（退出码不作判据） | 是 |
| 4.4 默认 profile 取作者机器值 | 成立（影响被高估：只产生 warn，不会失败） | §5.3、§5.4 | 是 |
| 4.5 `write_config` 入参契约未写进技能 | 成立 | §5.3 入参形状示例 | 是 |
| 4.6 lark-cli 安装链路受阻 | 三条中两条成立；"包内自带 exe"表述有误 | §5.2 `install-cli` 四级回退 | 是 |
| 4.7 环境辅助问题（esbuild 沙箱等） | 宿主问题，本仓库亦有记录 | §5.3 构建提权路径、§7 终态 | 是 |
| 建议 1 分发/构建与启动器提示 | — | §5.6（不提交 dist，改为自动构建；启动器补一句） | 是 |
| 建议 2 环境前置章节 | — | §5.3 | 是 |
| 建议 3 固化 4.1–4.4 的修正 | — | §5.2 / §5.3 / §9 | 是 |
| 建议 4 确定性脚本 | — | 本设计主体（§5.2） | 是 |
| 建议 5 补 `write_config` 示例 | — | §5.3 | 是 |
| 建议 6 Windows 安装回退 | — | §5.2 `install-cli` | 是 |
| 建议 7 首次同步 dry-run 确认 | 已是现状（`skills/knowledge-sync/SKILL.md`） | 无需改动 | 不适用 |
| 遗留风险：插件更新后构建产物丢失 | — | §5.6 自愈、§9 演练 | 是 |
| 遗留风险：工作区临时副本与命令脚本 | 使用方机器上的临时物 | 不在本设计范围，实现后由使用方清理 | 不适用 |
| 遗留风险：首次同步未执行、索引为空 | — | setup 仍不执行同步（§2 非目标） | 不适用 |

## 15. 复审报告问题覆盖对照

对 `docs/superpowers/specs/2026-10-23-setup-automation-design-review.md` 的问题
逐条核实与收敛（核实动作与结论见本次改动说明）：

| 复审条目 | 核实结论 | 本设计对应 | 覆盖 |
| --- | --- | --- | --- |
| P0-1 人机边界与例外路径矛盾 | 成立（授权类动作未纳入边界） | §2、§5.1 三类动作与验收口径 | 是 |
| P0-2 默认知识库不可达缺合法路径 | 成立（现技能有"默认或替换"，新设计漏掉） | §5.5 写前预检 + 管理员授权 / 替换两条路径 | 是 |
| P0-3 重跑覆盖既有自定义配置 | 成立（`write_config` 从空对象套默认值，`save_config` 不保留未知字段） | §5.4 `read_config`、§5.5 三元决策与失败边界、§9 重跑测试 | 是 |
| P1-1 `pending_config` 契约不完整 | 成立（`additionalProperties: false`、normalizer 复用、CLI 路径来源等） | §5.4 统一契约（含 `health` 侧与 schema） | 是 |
| P1-2 profile 处置与 `health` 文案冲突 | 成立（`health.ts` 建议用户执行 `profile use`） | §5.3 文案规则、§9 断言、§10 同步 architecture §7.3/§8 | 是 |
| P1-3 `call-tool` 入参敏感文件生命周期 | 成立 | §5.2 `call-tool` 行、§8 规则、§9 测试 | 是 |
| P1-4 `build-server` 未覆盖 npm 脚本拦截 | 成立 | §5.2 失败分类 + `BUILD_TOOL_BLOCKED`、§7 终态、§9 测试 | 是 |
| P1-5 下载源 / 版本 / 校验链未收敛 | 成立 | §5.2 版本与下载裁决、§11 事实行、§9 fake 网络测试 | 是（Node 具体版本值与校验值仍标"待复核"，实现时取回并回显） |
| P2-1 验证策略缺高风险用例 | 成立 | §9 新增六类用例，live smoke 与 CI 分离 | 是 |
