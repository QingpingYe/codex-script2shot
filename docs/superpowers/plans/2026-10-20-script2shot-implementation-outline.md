# codex-script2shot 实施大纲（Phase 1–5）

状态：Draft
日期：2026-10-20
依据：`docs/architecture.md` 第 14 章「最小落地顺序」，以及第 5–13 章、`references/stage-conventions.md`、`docs/knowledge-base-a.md`、`docs/knowledge-base-b.md`

**目标：** 把架构文档第 14 章列出的五个阶段转成可逐任务执行、带验证门槛的落地顺序，并为每个阶段提供独立详细计划。

**架构：** Codex 本地插件（根目录 `plugin.json` + `mcp.json` + 六个 Skill）加本地 MCP Server。MCP Server 只做确定性操作；知识归纳和创作由 Skill 在会话中完成；阶段之间只通过文件产物交接。

**技术栈：** Node.js >= 24 + TypeScript（esbuild 单文件产物、vitest、内置 `node:sqlite`）；已确认并写入架构 §7.1，详见本文件 §2。

**Spec：** `docs/architecture.md`（权威设计源）。冲突时以该文档为准；实现需要偏离时，先改设计文档再改代码，并在同一次改动内完成（AGENTS.md「文档优先」）。

## Global Constraints

以下约束来自设计文档，所有阶段任务隐含遵守：

- 知识库 A 由用户维护，插件只读取，不写入（architecture §1.1-10、§4）。
- 知识库 B 只保留最新版，无草稿、审核、历史版本；知识卡没有 `status` 字段（§2.3、§5.2）。
- 同步事实来源只能是知识库 B 的 `SyncState`；本地缓存标记只用于性能（§2.4）。
- 同一时间只有一个人执行知识库 B 同步；插件不实现并发锁和并发协议（§1.1-9、§12）。
- 一次 run 只接受一个 `target_model`，只生成一份 `prompts.<model>.md`（§1.1-13、§11.5）。
- 第一版只做关键词检索和规则排序，不引入向量索引、嵌入模型和模型重排（§1.1-14、§10.2）。
- 剧本不进入知识库；剧本只在会话和工作区中传递（§1.1-11）。
- 外部写操作默认先 dry-run；批量同步先生成整批影响清单，用户确认后一次执行整批（§6.2、§8）。
- 硬规则（时长、画幅、必填、禁止项）只放在 `rules/models/*.json`，知识库不保存硬规则（§11.4、knowledge-base-a §3）。
- 提示词正文统一中文；结构化枚举和字段标识用英文（§11.3）。
- 时间统一用带时区的 ISO 8601（stage-conventions §1）。
- 不提交密钥、token 和登录信息；不把它们写入输出文件和日志（AGENTS.md §3）。
- 面向人的文档用中文；代码、标识符和路径用英文（AGENTS.md §3）。
- 行为变化时，代码、schema、规则文件、文档和测试在同一次改动内保持一致（AGENTS.md §3）。

---

## 1. 完成定义

项目级「完成」= 端到端跑通 `docs/architecture.md` §11.2 的默认路径：

```text
剧本文本
  -> script-breakdown -> script_analysis.json（含本阶段 knowledge_refs）
  -> shot-planning    -> shot_plan.json（含本阶段 knowledge_refs）
  -> shot-prompting   -> prompts.ir.json -> prompts.<model>.md
  -> script2shot 入口 -> knowledge_refs.json + warnings.md + run.json
```

并且满足第 14 章「验证基线」四条最低验证（见本文件 §5）。

## 2. 技术栈（已确认：Node.js + TypeScript，2026-10-20）

架构 §7.1 已写入下述决定；各阶段计划中的命令与扩展名均已展开。

| 维度 | 决定 |
| --- | --- |
| 语言与运行时 | TypeScript，Node.js >= 24（Codex 桌面端自带 Node 24.19.0；开发机系统 Node 满足） |
| 构建 | esbuild 打包为单文件 `server/dist/server.mjs`；`npm --prefix server run build` |
| 运行 | `scripts/launch_script2shot_mcp.cmd`（Windows）/ `scripts/launch_script2shot_mcp`（POSIX）定位 Codex Node 运行时后启动；解析顺序与官方插件启动脚本一致（`CODEX_MCP_NODE_PATH` -> Codex 资源目录 -> Codex 缓存 runtime -> 系统 `node`） |
| 依赖 | 打包内联：`@modelcontextprotocol/sdk`、`ajv`、`smol-toml`；关键词索引用内置 `node:sqlite`（无原生模块）；开发依赖：`typescript`、`esbuild`、`vitest`、`@types/node` |
| 测试 | vitest（`test` 脚本为 `vitest run`）；`npm --prefix server test -- <过滤词>` |
| 使用者安装成本 | MCP Server 零额外安装；公共前提只有 lark-cli 与登录 |

决策依据（2026-10-20 实测）：Codex 桌面端自带 Node 24.19.0，官方插件（code-review、codex-app-tools）的启动脚本已按上述顺序解析 Node；自带 Node 的 `node:sqlite` 可用，因此不需要 `better-sqlite3` 一类原生模块。Python 方案要求每台机器安装解释器并维护 venv 与 pip 依赖（Codex 自带的 Python 不是插件侧启动契约），用户成本明显更高。

## 3. 阶段地图与依赖

```text
Phase 1 插件骨架与飞书连接
  -> Phase 2 知识库同步
       -> Phase 3 本地检索
           -> Phase 4 阶段技能与提示词生成
                4a script-breakdown -> 4b shot-planning -> 4c shot-prompting -> 4d 入口编排
  -> Phase 5 可选增强（依赖 Phase 3；knowledge-inspect 只读知识库 B）
```

| 阶段 | 目标 | 主要交付 | 详细计划 |
| --- | --- | --- | --- |
| Phase 1 | 插件能被 Codex 加载，`setup` 和 `health` 完成本地与飞书连接 | `plugin.json`、`mcp.json`、`server/` 骨架、`setup` Skill、`health`、lark-cli 发现与登录检查、能力记录 | `2026-10-20-script2shot-phase1-plugin-bootstrap.md` |
| Phase 2 | 知识库 A 增量归纳到 B，SyncState 正确维护，替换幂等 | 两个 schema、`scan_knowledge_a`、`fetch_knowledge_a_doc`、`read_sync_state`、`init_knowledge_b`、`replace_doc_cards`、`update_doc_sync_state`、`delete_doc_cards`、`knowledge-sync` Skill | `2026-10-20-script2shot-phase2-knowledge-sync.md` |
| Phase 3 | 本地缓存与 SQLite 关键词索引可用，过滤和排序可验证 | `refresh_local_index`、`search_knowledge`、`load_knowledge_pack` | `2026-10-20-script2shot-phase3-local-retrieval.md` |
| Phase 4 | 三个创作阶段和入口编排跑通端到端 | `script_analysis`/`shot_plan`/`prompt_ir`/`run` 四个 schema、三个阶段 Skill、`script2shot` Skill、`validate_stage_artifact`、`validate_prompt`、`render_prompt`、`init_run`/`read_run`/`update_run_state`、聚合产物 | `2026-10-20-script2shot-phase4-stage-skills-and-prompting.md` |
| Phase 5 | 检索诊断与排查技能（可选） | `explain` 输出、`knowledge-inspect` Skill | `2026-10-20-script2shot-phase5-diagnostics.md` |

## 4. 里程碑与阶段出口

| 阶段 | 出口标准（全部满足才进入下一阶段） |
| --- | --- |
| Phase 1 | 插件通过本地加载检查；对真实环境跑通 `$setup`；`health` 全绿或只剩明确列出的 warning；`docs/lark-cli-capability-notes.md` 记录了版本、日期和实测命令 |
| Phase 2 | `init_knowledge_b` 建表/校验幂等；一次真实同步完成「新增 + 修改 + 删除」三类处理；未变化文档零正文读取；重复替换不产生重复卡；失败文档不被写入 SyncState |
| Phase 3 | 索引可从 B 全量构建、可增量刷新；四类过滤各有正例反例；排序规则逐级可验证；索引不可用时有 priority 回退 + warning |
| Phase 4 | 样例剧本端到端产出全部 7 个运行产物；`from`/`only` 续跑可用；两个模型渲染快照通过；人工修改上游产物后必须重新校验才能续跑 |
| Phase 5 | `explain` 默认关闭、行为与 Phase 3 一致；开启时返回命中级别、过滤淘汰原因、来源版本和降级路径；`knowledge-inspect` 只读且能回答两个既定问题 |

## 5. 验证基线映射（architecture §14）

| 最低验证 | 落点 |
| --- | --- |
| schema fixture 能拒绝缺失必填字段和错误枚举 | Phase 2 Task 1（knowledge_card、sync_state）；Phase 4 Task 4a-1、4b-2、4c-1、4d-1（四个产物 schema） |
| 同一文档重复执行 `replace_doc_cards` 不产生重复卡 | Phase 2 Task 5（幂等用例） |
| 分类、项目、目标模型过滤各有正例和反例 | Phase 3 Task 4（四类过滤矩阵）与 Task 5（项目隔离） |
| Seedance 2.0、2.5 渲染结果有快照测试 | Phase 4 Task 4c-3（两个模型的 golden 快照） |

## 6. 跨阶段接口约定

### 6.1 目录补充（相对 architecture §7.1）

以下目录与文件补充已随技术栈决策记录进架构 §7.1（2026-10-20）：

- `server/tests/`：MCP Server 实现测试；`server/tests/fixtures/`：假 lark-cli 与录制响应 fixture。
- `tests/fixtures/`：跨模块共享 fixture（schema 样例、阶段产物样例、渲染 golden）。
- `docs/lark-cli-capability-notes.md`：lark-cli 版本与能力实测记录（Phase 1 创建）。
- `.script2shot/` 加入 `.gitignore`（运行产物不入库）；`server/dist/`、`server/node_modules/` 或 venv 目录同样不入库。

### 6.2 MCP Tool 接口总表

工具名与架构 §8 一致；完整输入/输出 JSON 在所属阶段计划中定稿，此处只冻结跨阶段约定：

| Tool | 输入要点 | 输出要点 | 定稿位置 |
| --- | --- | --- | --- |
| `health` | 无 | `{ ok, checks[], warnings[] }`，`checks[].id` 见 Phase 1 Task 5 | Phase 1 |
| `write_config` | `{ config, create_local_dirs?, dry_run? }`（缺省 dry-run） | `{ dry_run, config_path, diff, created_dirs, written }`；diff 中 `base_b` 掩码为前 6 位 + `…` | Phase 1 |
| `scan_knowledge_a` | 无（读配置） | `{ nodes[], skipped[], warnings[] }`，节点含 `node_token/obj_token/obj_type/parent_node_token/title/obj_edit_time/node_type` | Phase 2 |
| `fetch_knowledge_a_doc` | `{ doc: URL 或 token }` | `{ doc_token, revision_id, title, content, tips, warnings[] }` | Phase 2 |
| `read_sync_state` | 无（只读） | `{ records[] }` | Phase 2 |
| `init_knowledge_b` | `{ dry_run }` | `{ action, tables, drift[], warnings[] }` | Phase 2 |
| `replace_doc_cards` | `{ source_doc_token, cards[] }` 或 `{ source_doc_token, metadata_patch }` | `{ dry_run, planned, created_record_ids[], deleted_record_ids[], warnings[] }` | Phase 2 |
| `update_doc_sync_state` | `{ record }` | `{ record_id, action }` | Phase 2 |
| `delete_doc_cards` | `{ source_doc_token, dry_run }` | `{ deleted_cards, deleted_state }` | Phase 2 |
| `refresh_local_index` | `{ dry_run? }` | `{ refreshed_docs[], removed_docs[], unchanged_docs[], index_status, warnings[] }` | Phase 3 |
| `search_knowledge` | `{ query, scope?, project_id?, categories?, target_model?, max_cards?, char_budget?, explain? }` | `{ candidates[], dropped_by_budget[], degraded, warnings[] }` | Phase 3（`explain` 在 Phase 5） |
| `load_knowledge_pack` | `{ project_id, target_model, explain? }` | `{ cards[], stats, warnings[] }` | Phase 3（`explain` 在 Phase 5） |
| `init_run` | `{ workspace_root, input_mode, project_id, target_model }` | `{ run_id, run_json_path }` | Phase 4d |
| `read_run` | `{ run_id }` | `{ run, artifacts{}, warnings[] }` | Phase 4d |
| `update_run_state` | `{ run_id, stage, status, artifact?, warnings? }` | `{ run }` | Phase 4d |
| `validate_stage_artifact` | `{ stage, path }` | `{ ok, errors[] }` | Phase 4a/4b |
| `validate_prompt` | `{ prompt_ir_path }` | `{ ok, errors[] }` | Phase 4c |
| `render_prompt` | `{ prompt_ir_path, output_path }` | `{ output_path }` | Phase 4c |

所有写工具遵守：`dry_run` 缺省视为 `true`；返回中必须能区分「计划做什么」和「已经做了什么」。

### 6.3 错误与警告约定

- 工具失败返回 `{ ok: false, error: { code, message, details? } }`，不抛裸异常文本。
- `error.code` 首版固定集合：`LARK_CLI_NOT_FOUND`、`AUTH_REQUIRED`、`CONFIG_MISSING`、`CONFIG_INVALID`、`KB_A_UNREACHABLE`、`KB_B_UNREACHABLE`、`DOC_FETCH_FAILED`、`KB_WRITE_FAILED`、`SCHEMA_INVALID`、`STAGE_ARTIFACT_MISSING`、`UPSTREAM_INVALID`、`MODEL_UNKNOWN`、`HARD_RULE_VIOLATION`、`INDEX_UNAVAILABLE`、`INTERNAL`。
- 警告为 `{ code, message, refs? }`；warnings 只增不改，由入口汇总进 `warnings.md`。
- 飞书写操作（建表、建卡、删卡、更新状态）一律先 dry-run，确认后执行；确认粒度是「整批一次」，不逐文档重复确认。

### 6.4 时间、语言与格式

- 所有产物内时间用带时区 ISO 8601（如 `2026-10-20T12:00:00+08:00`）；`run_id` 用 `run-YYYYMMDD-HHMMSS`。
- 写入 Base 的日期时间字段（`updated_at`、`last_synced_at`）必须经适配器转换：lark-cli 接受 `YYYY-MM-DD HH:mm` 形式的 datetime CellValue；读回时统一转换回 ISO 8601。转换函数要有往返测试和一条真人实测 fixture。
- `obj_edit_time` 按原始字符串保存，不解析为时间再做比较（架构 §5.3）。
- 阶段产物中英文字段标识与枚举；提示词正文、warnings、报告文本用中文。

### 6.5 外部事实与记录

以下事实已在 2026-10-20 用本机 `lark-cli 1.0.98` 与官方文档核对，实施时直接使用；如需升级 lark-cli 版本，先重跑 Phase 1 的能力探测并把结果追加到 `docs/lark-cli-capability-notes.md`。

| 事实 | 来源 | 核对日期 |
| --- | --- | --- |
| `wiki +node-list`（`wiki.nodes.list`）返回 `node_token`、`obj_token`、`obj_type`、`parent_node_token`、`title`、`obj_edit_time`、`node_type`（`origin`/`shortcut`）、`has_child`；`--page-all --page-limit` 控制翻页 | 本机 `lark-cli schema wiki.nodes.list` 与 `lark-cli skills read lark-wiki references/lark-wiki-node-list.md` | 2026-10-20 |
| `docs +fetch --doc <URL 或 token> --doc-format markdown --detail with-ids --revision-id -1` 返回 `data.document.{document_id, revision_id, content, reference_map, tips}` | 本机 `lark-cli skills read lark-doc/references/lark-doc-fetch.md` | 2026-10-20 |
| `base +table-create` 用 `--fields` JSON 建表；`base +record-batch-create` 用 `--json {"create_records":[...]}`，单次上限 200 条；datetime CellValue 形如 `2026-03-24 10:00` | 本机 `lark-cli base ... --help` | 2026-10-20 |
| `auth status --json` 可读登录状态；`auth login` 走设备码登录 | 本机 `lark-cli auth --help` | 2026-10-20 |
| 可移植插件布局：根目录 `plugin.json`（agent-plugins schema 1.0.0）+ `mcp.json`（`mcpServers` 每项声明 transport `type`）+ `skills/`；OpenAI 专属元数据放 `extensions.com.openai`（`interface`、`onboardingSkill`）。Codex 兼容布局是 `.codex-plugin/plugin.json` + `.mcp.json`，两者不混用 | https://developers.openai.com/plugins/build/plugins | 2026-10-20 |
| Codex 桌面端自带 Node 24.19.0；官方插件启动脚本按 `CODEX_MCP_NODE_PATH` -> Codex 资源目录 -> Codex 缓存 runtime -> 系统 node 解析；实测自带 Node 的 `node:sqlite`（`DatabaseSync`）可用 | 本机 `codex-app-tools 0.1.6` 启动脚本与本机 runtime 实测 | 2026-10-20 |

## 7. 工作方式

- 每个任务按 TDD 步骤执行：先写失败测试 → 确认失败 → 最小实现 → 确认通过 → 提交。
- 每个任务一个提交，提交信息用 `feat:` / `test:` / `docs:` / `chore:` 前缀。
- 涉及外部事实的改动（模型规则、飞书行为、官方格式）必须带来源与核对日期。
- 需要真实飞书环境的验证一律显式标注为 live 测试，默认测试用假 lark-cli fixture，不依赖网络。
- 任务之间只通过本大纲 §6 的接口约定交接；后续任务不得改变前面冻结的字段名。

## 8. 开放决策与风险

1. **技术栈（R-11）**：已确认 Node.js + TypeScript（2026-10-20），已写入架构 §7.1；计划占位符已展开。
2. **执行方式**：subagent-driven 还是 native，见 §9 建议。
3. **shortcut 节点**：`wiki +node-list` 的 `node_type` 可能是 `shortcut`，同一 `obj_token` 可能重复出现，与 `source_doc_token` 主键冲突。首版计划跳过 shortcut 节点并写 warning；Phase 2 Task 2 落地时把该规则写进架构 §6.1。
4. **知识库 B 不可达**：按 §13 处理——有本地缓存继续 + warning，无缓存停止。Phase 3 落地。
5. **多集输入规模**：不做自动拆分和硬性镜头上限，入口写 warning 建议按集运行（§11.1）。Phase 4d 落地。
6. **Phase 4 体量**：4a–4d 在一个计划文件内用四个小节组织；执行到 4b 结束后可按需要拆分为独立文件，拆分时保持接口约定不变。

## 9. 执行方式建议

执行方式已确认：**subagent-driven**（2026-10-20）。每个任务由独立实现者按计划完成并提交，再经独立复核后进入下一个任务；跨任务接口（schema、工具签名）一旦冻结必须严格一致。整体完成后做一次全分支复核。
