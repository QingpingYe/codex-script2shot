---
name: setup
description: 安装后的一次性引导：确认 lark-cli 与登录状态，收集知识库 A、知识库 B 配置，dry-run 预览后写入 config.toml、初始化本地目录并建好知识库 B 数据表。
---

# setup

插件安装后的初始化引导。本 Skill 处理配置、本地目录，以及知识库 B 数据表的创建或
校验：不写知识库 A；知识库 B 的建表由 `init_knowledge_b` 负责；本 Skill 不执行知识
同步，只在最后提示用户可选地运行一次 `$knowledge-sync`。

## 适用时机

- 插件安装后首次使用，`health` 提示 `CONFIG_MISSING`、配置缺少必填项或本地目录缺失。
- 需要更换 lark-cli 路径、登录身份，或重新配置知识库 A / 知识库 B。
- 知识库 B 缺少 `KnowledgeCards` / `SyncState` 数据表、`table_id` 未回填，或
  `init_knowledge_b` 报 drift 后需人工处理再重跑。

## 流程

1. **运行 `health` 预检**：调用 MCP 工具 `health`，按 `checks[].id` 记录每个检查的
   status 与 detail，先看清缺什么再动手。
2. **确认 lark-cli**：
   - `lark_cli` 为 pass 时记录 `detail.path`，作为 `lark.cli_path` 的值；
   - `lark_cli` 为 fail 且 `detail.code` 是 `LARK_CLI_NOT_FOUND` 时，先给用户安装指引
     （安装 lark-cli，或提供已有的可执行文件路径），再让用户设置 `LARK_CLI_PATH`
     环境变量，或把该路径写入 `lark.cli_path`。不要猜路径。
3. **登录检查**：
   - `auth` 为 pass 时进入下一步；
   - `auth` 为 fail（`AUTH_REQUIRED`）时，指引用户在自己的终端运行
     `lark-cli auth login`，按输出里的设备码 / 授权链接完成登录，然后重新运行
     `health`，确认 `auth` 已通过。
4. **收集知识库 A（Wiki）**：先说明插件自带默认知识库 A（见「默认知识库」），
   请用户选择直接采用默认或替换。
   - 采用默认时记录默认 `space_id`，进入下一步；
   - 替换时请用户提供知识库 A 的飞书 Wiki URL 或 `space_id`；
   - 用户给 URL 时，先用 `lark-cli wiki +node-get` / `wiki +space-list` 把 URL
     解析成数字 `space_id`，并把解析结果显示给用户确认；
   - 用户直接给数字 `space_id` 时，原样确认；
   - 访问个人知识库（`my_library`）时必须加 `--as user`。
5. **收集知识库 B（Base）**：先说明插件自带默认知识库 B，请用户选择直接采用默认
   或替换。
   - 采用默认时记录默认 base token（回显只显示掩码），进入下一步；
   - 替换时请用户提供知识库 B 的 Base URL 或 base token；不要复述用户粘贴的完整 token。
   - 本步只记录 token；数据表在本流程后面的 `init_knowledge_b` 步骤里创建或校验。
6. **组装 config 并预览**：按「配置项」拼出完整 config 对象，调用 MCP 工具
   `write_config`（缺省 `dry_run: true`），把返回的 `diff` 与 `created_dirs` 展示给
   用户，一并说明返回的 `applied_defaults` 套用了哪些插件默认值，提示 diff 中的
   `base_b` 已掩码。**等用户明确确认后**，再调用
   `write_config` 并传 `dry_run: false` 执行写入与本地目录创建（这一步必须先做：
   `init_knowledge_b` 需要先读到 config.toml）。
7. **`init_knowledge_b` dry-run 预览**：调用 MCP 工具 `init_knowledge_b`（缺省
   `dry_run: true`，只读表列表与字段，不建表、不写配置），把返回的 `action`、
   `drift`、`warnings`、`tables` 完整展示给用户：
   - `tables.knowledge_cards` / `tables.sync_state` 为 `null` 且带 `KB_TABLE_MISSING`
     warning：该表还不存在，执行路径会按固定字段清单创建；
   - `action: "validated"`：两张表都已存在且字段清单一致，执行路径只回填 table_id；
   - `action: "drift"`：已有表的字段缺失或类型不符，按「失败处理」处理，不会自动
     改表；
   - `warnings` 里的 `KB_EXTRA_FIELD`：表里有多余字段，保留不动，不影响同步。
8. **用户整批确认后建表并回填 table_id**：把预览结果展示完、得到用户明确确认后，
   调用 `init_knowledge_b({ dry_run: false })`。只有执行路径且 `action != "drift"` 时，
   工具才会把 `lark.knowledge_cards_table_id` 与 `lark.sync_state_table_id` 写回
   `~/.codex-script2shot/config.toml`；dry-run 与 drift 都不写配置。
9. **可选首次同步**：提示用户可以在需要时运行 `$knowledge-sync` 做首次整批同步；
   不在 setup 内自动执行，也不代用户确认该 Skill 的整批清单。
10. **复查**：重新调用 `health`，逐项报告结果。`index` 为 `not_built` 属预期状态
    （首次 `$knowledge-sync` 或后续索引刷新后才构建）。

## 默认知识库

插件自带一组默认知识库配置（架构 §7.3），默认值唯一来源是
`server/src/setup_defaults.ts` 的 `SETUP_DEFAULTS`：

- 知识库 A（Wiki）：`space_id` 默认 `7695983197091302359`；
- 知识库 B（Base）：默认 base token 前 6 位为 `WRrVbl…`（完整默认值见
  `SETUP_DEFAULTS`，任何日志、回显与摘要都按掩码规则处理）；
- `lark.project_roots` 默认把《五夫临门》影游项目知识根节点
  `Ou9Vw0emviJajPklYjQc4fqjnie` 映射为 `project_id` = `wufu-linmen`；
- `lark.profile` 缺省取插件默认 profile（见 `SETUP_DEFAULTS`，本机为
  `cli_aa20f40faa785d11`，可替换），`retrieval.default_top_k` 默认 `12`。

setup 时可直接采用这些默认值，也可以替换：改
`~/.codex-script2shot/config.toml` 里对应字段，或在 setup 流程中收集新值后传给
`write_config`。显式提供的值优先；`project_roots` 显式传空数组表示不做项目映射。
`write_config` 会在 `applied_defaults[]` 中列出本次实际套用的默认键路径。

## 配置项

与架构 §7.3 字段一一对应，写入 `~/.codex-script2shot/config.toml`：

| 字段 | 含义 | 取值来源 |
| --- | --- | --- |
| `lark.cli_path` | lark-cli 可执行文件路径 | `health` 的 `lark_cli.detail.path`、`LARK_CLI_PATH`，或用户提供的路径 |
| `lark.profile` | lark-cli 使用的 profile | 用户确认；缺省取插件默认 profile（见 `SETUP_DEFAULTS`，本机为 `cli_aa20f40faa785d11`，可替换） |
| `lark.space_a` | 知识库 A 的 Wiki 数字 `space_id` | 用户提供或从 Wiki URL 解析；未提供时采用插件默认知识库 A |
| `lark.base_b` | 知识库 B 的 Base token | 用户提供的 Base URL 或 token；未提供时采用插件默认知识库 B（回显只显示 `WRrVbl…`） |
| `lark.project_roots` | 知识库 A 根节点到项目 ID 的映射表 | 缺省为《五夫临门》影游项目映射，可在 config.toml 里替换 |
| `lark.knowledge_cards_table_id` | 知识库 B `KnowledgeCards` 表的 `table_id` | `init_knowledge_b` 执行路径自动回填；执行前允许留空 |
| `lark.sync_state_table_id` | 知识库 B `SyncState` 表的 `table_id` | 同上一行 |
| `retrieval.default_top_k` | 默认检索条数 | 用户确认，缺省 `12` |

write_config 的缺省语义：`lark.profile`、`lark.space_a`、`lark.base_b`、
`lark.project_roots` 为 `undefined` 时用 `SETUP_DEFAULTS` 填充，显式提供（含显式
空数组）的值优先，并在返回值 `applied_defaults[]` 里列出实际套用的键路径；填充后
仍强制 `lark.space_a` 与 `lark.base_b` 非空。`retrieval.default_top_k` 缺省 `12`；
其余字段（两个 table_id）缺失时由 `init_knowledge_b` 的执行路径回填。

## 失败处理

按 `health` 的 `checks[].detail.code`（或 `write_config` 的 `error.code`）处理：

| 错误码 | 用户动作 |
| --- | --- |
| `LARK_CLI_NOT_FOUND` | 安装 lark-cli，或提供可执行文件路径并写入 `LARK_CLI_PATH` / `lark.cli_path`，然后重跑 `health` |
| `AUTH_REQUIRED` | 运行 `lark-cli auth login`，按设备码完成登录，然后重跑 `health` |
| `CONFIG_MISSING` | 走本 Skill 流程生成 config.toml；先用 `write_config` dry-run 预览再写入 |
| `CONFIG_INVALID` | 配置文件 TOML 损坏或字段类型不符：先把现状展示给用户并确认处理方式，不静默覆盖；若来自 `write_config`，按 `details.missing_keys` 补齐缺失的必填项后重试 |
| `KB_A_UNREACHABLE` | 核对 `lark.space_a` 是否为数字 `space_id`、是否使用 `--as user`、飞书访问权限是否足够 |
| `KB_B_UNREACHABLE` | 核对 `lark.base_b` 是否为知识库 B 的 Base token，以及当前登录身份的访问权限 |
| `KB_TABLE_AMBIGUOUS` | 知识库 B 里存在多张同名 `KnowledgeCards` / `SyncState` 表：请人工删除或重命名多余的表，然后重跑 `init_knowledge_b` |
| `KB_READ_FAILED` | `init_knowledge_b` 读取表列表 / 字段失败：核对 `lark.base_b` 与当前登录身份的访问权限后重跑 dry-run |
| `KB_WRITE_FAILED` | `init_knowledge_b` 建表失败（外部写操作）：按 `message` 与 `details` 处理；`details.config_updated=false` 表示配置未被改动，处理后可重跑 |
| `INTERNAL` | `init_knowledge_b` 建表后仍解析不到 table_id，或写回本地配置失败：不会写入配置；按 `details.tables` / `details.hint` 人工核对，或手动回填 table_id 后重跑 |

`drift` 不是错误对象：`init_knowledge_b` 返回 `action: "drift"` 时不会自动改表、也
不写回 table_id。把 `drift[]` 逐条展示给用户，提示按固定字段清单人工补齐 / 修正
字段，或删除该表重建，然后重跑本步骤的 dry-run 与执行。建表是外部写操作：必须先
跑缺省 `dry_run: true` 的预览，展示 `action` / `drift` / `warnings` / `tables` 并
得到用户整批确认后，才允许调用 `dry_run: false`。

`CONFIG_FIELD_MISSING`、`TABLE_ID_NOT_CONFIGURED`、`LOCAL_DIRS_MISSING`、
`INDEX_NOT_BUILT` 等 warning：`LOCAL_DIRS_MISSING` 由 write_config 的写入步骤
顺带创建；`TABLE_ID_NOT_CONFIGURED` 由 `init_knowledge_b` 的执行路径回填解决；
`INDEX_NOT_BUILT` 在首次 `$knowledge-sync` 或索引刷新前属预期状态。

## 安全约定

- 不打印 token 全文：任何日志、回显和给用户的摘要里，`base_b` 只保留前 6 位加 `…`；
  不要复述用户粘贴的完整 token。
- 写配置与建表前必须 dry-run 预览：`write_config` 与 `init_knowledge_b` 都缺省
  `dry_run: true`；先展示 diff / 目录清单（或 `action` / `drift` / `warnings` /
  `tables`），得到用户明确确认后才执行 `dry_run: false`。建表属外部写操作，必须先
  dry-run。
- 不写知识库 A：本 Skill 只读取知识库 A 的配置信息，任何情况下都不向知识库 A
  写入、修改或删除内容。
- 写操作范围：本地只有 `~/.codex-script2shot/config.toml` 与 `cache/index/logs`
  目录；网络写操作只有知识库 B 的建表（`init_knowledge_b` 的执行路径）。本 Skill
  不创建或修改知识库 B 的数据行（数据行由 `$knowledge-sync` 负责）。
