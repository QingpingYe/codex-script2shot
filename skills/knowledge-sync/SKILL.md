---
name: knowledge-sync
description: 把知识库 A 的变化同步到知识库 B：扫描或指定文档、生成知识卡，整批 dry-run 清单确认后替换卡片并更新 SyncState。
---

# knowledge-sync

把知识库 A（飞书 Wiki）中的知识文档归纳成结构化知识卡，写入知识库 B（飞书 Base）
的 `KnowledgeCards` 表，并把每个文档的同步状态写入 `SyncState` 表。知识库 A 全程
只读，写入只发生在知识库 B。

## 适用时机

- 知识库 A 中的文档新增、修改、移动或改名、删除后，需要把这些变化同步到知识库 B。
- 首次同步：知识库 B 的 `KnowledgeCards`、`SyncState` 两张表已由 `setup` 建好，
  并把 `table_id` 写回 `~/.codex-script2shot/config.toml`。
- 只改动了一个文档，或某个文档的 `obj_edit_time` 没有变化但需要强制重新归纳时，
  使用指定文档模式。

## 输入模式

**扫描模式（缺省）**：用户只说 `$knowledge-sync`。扫描知识库 A 的节点元数据，与
知识库 B 的 SyncState 对比，生成整批变化清单，确认一次后逐文档执行。

**指定文档模式**：`$knowledge-sync 只同步这个文档：<飞书文档 URL 或 token>`。
跳过扫描与整批确认，直接对给定文档强制重新归纳；仍要更新 SyncState。

## 流程

### 扫描模式

1. **`health` 预检**：调用 MCP 工具 `health`。存在 `status: "fail"` 的检查项就停在
   预检，把失败明细报告给用户，不要继续同步。
2. **读取状态并生成计划**：调用 `read_sync_state` 和 `scan_knowledge_a`，再把
   `scan_knowledge_a` 返回的 `nodes[]` 作为 `nodes`、`read_sync_state` 返回的
   `records[]` 作为 `sync_records`，调用 `build_sync_plan`，得到
   `to_add` / `to_update` / `to_move` / `to_delete` / `unchanged` / `warnings`。
   `unchanged` 文档不读正文、不写任何东西。
3. **输出整批 dry-run 清单，请用户确认一次**：把 `to_add`、`to_update`、`to_move`、
   `to_delete` 逐条列出 `title` 与 `path`（`unchanged` 只报数量），原样带上
   `warnings`，并注明 `to_delete` 是不可逆的删除操作。得到用户明确确认后才进入执行；
   用户不确认就停在这里。
4. **按文档处理**（对确认清单内的每个文档；单个文档失败不阻塞其他文档）：
   - 新增 / 修改：`fetch_knowledge_a_doc` 读取正文与 `revision_id` → 按
     `references/card-authoring.md` 生成该文档的完整新卡集合 → `replace_doc_cards`
     （`cards` + `dry_run: false`）替换旧卡 → 成功后再调用 `update_doc_sync_state`。
   - 移动 / 改名：不读正文、不重新生成卡片，只调用 `replace_doc_cards` 的
     `metadata_patch` 模式（+ `dry_run: false`）更新来源元数据，成功后再调用
     `update_doc_sync_state`；`source_revision`、`card_count` 沿用现有 SyncState
     记录。
   - `update_doc_sync_state` 的 `record` 来源元数据（`source_node_token`、
     `source_path`、`scope`、`project_id`、`obj_edit_time`）取本次扫描结果中同一
     `source_doc_token` 的节点；`source_revision` 取本次 fetch 的 `revision_id`
     （移动 / 改名除外）；`card_count` 取本次写入的卡片数；`last_synced_at` 用当前
     时间（带时区偏移的 ISO 8601）。
5. **删除类**：对 `to_delete` 逐条调用 `delete_doc_cards`（`dry_run: false`），
   删除该文档的知识卡与 SyncState 记录。
6. **汇总报告**：报告每个文档的处理状态、失败明细与 `warnings`；失败文档明确写
   「未更新 SyncState，可重试」。

### 指定文档模式

跳过扫描模式的第 2–3 步：不调用 `build_sync_plan`，不输出整批清单，也不做整批确认。
直接对给定文档执行第 4 步，强制重新归纳（即使 `obj_edit_time` 没有变化），状态更新
照旧。用户提出指定文档请求即视为对该文档执行替换的确认。

指定文档模式的状态元数据来源：

- 先用 `read_sync_state` 查出该文档的现有记录（只取该文档的既有状态，不生成整批
  计划）：`source_node_token`、`source_path`、`scope`、`project_id`、`obj_edit_time`
  沿用记录中的值。
- `source_title` 按下面的「标题回退」处理；`source_doc_token`、`source_revision`
  取本次 `fetch_knowledge_a_doc` 的 `doc_token`、`revision_id`。
- 该文档在 SyncState 中没有记录时不要猜元数据：返回结构化失败并保持 SyncState
  不变，提示用户核对文档地址或改用扫描模式。

### 标题回退

`fetch_knowledge_a_doc` 的直接读路径可能拿不到文档标题（返回空 `title` +
warning）。此时 `source_title` 按以下顺序回退，并在汇总报告里保留该 warning：

- 扫描模式：回退为计划条目中的 `title`（扫描到的节点标题）；仍取不到时退化为
  `source_doc_token`。
- 指定文档模式：回退为 SyncState 现有记录中的 `source_title`；仍取不到时退化为
  `source_doc_token`。

## 知识卡生成规则

生成知识卡时逐条按 `references/card-authoring.md` 执行，要点：

- 十类分类与知识库 A 目录的映射固定，`card_id` 格式固定为
  `src:<source_doc_token>:<category>:<三位序号>`，同一文档内不重复。
- 一张卡只讲一件事；内容必须可执行、可转译成画面。
- `target_models` 只填 `seedance-2.0`、`seedance-2.5` 两个模型标识；通用知识留空。
- 来源字段必填（`source_doc_token`、`source_node_token`、`source_path`、
  `source_title`、`source_revision`、`updated_at`）。
- 每次生成的是该文档的完整新卡集合：`replace_doc_cards` 的 `cards` 模式会整体替换
  该文档的旧卡，不是增量追加。

## 失败处理

- 预检失败：`health` 有 `fail` 项就停在预检，按失败项引导用户处理（缺配置先运行
  `$setup`；数据表缺失或 `table_id` 未配置时，由 `setup` 的 `init_knowledge_b`
  先建表 / 校验并写回配置）后重跑本 Skill。
- 单文档失败：不更新该文档的 SyncState，明确报告「未更新 SyncState，可重试」，
  并继续处理其他文档，不阻塞整批。
- `replace_doc_cards` 写入新卡失败：旧卡保持不变、未执行删除，卡片与 SyncState 都
  保持旧值；不调用 `update_doc_sync_state`，报告可重试。
- `replace_doc_cards` 删除旧卡失败：新旧卡可能同时存在；不调用
  `update_doc_sync_state`；下一次同步会重新记录旧卡集合并收敛，报告可重试。
- `update_doc_sync_state` 失败：卡片已更新但状态未更新，下一次同步会再次处理该文档；
  报告可重试。
- 指定文档模式：文档不存在、不可读，或 SyncState 中没有它的记录时，返回结构化
  失败并保持 SyncState 不变。
- 任何失败都不静默使用部分写入结果；失败文档的失败明细写入汇总报告。

## 安全约定

- 知识库 A 只读：`scan_knowledge_a`、`fetch_knowledge_a_doc` 都只读；本 Skill 不向
  知识库 A 写入、修改或删除任何内容。
- 删除类操作（`delete_doc_cards`）属于不可逆外部写入，必须在整批 dry-run 清单获得
  用户确认后才执行；执行时才传 `dry_run: false`（实现层也只在执行路径带高风险确认
  `--yes`）。返回值中的 `dry_run` 字段用于区分预览与执行。
- `replace_doc_cards` 传入 `cards: []` 的语义是「清空该 token 当前全部卡片」：不
  静默使用。只有文档确实不再产出任何卡片、且用户已确认时才允许；整批清单里出现
  这类文档时要单独注明。
- 整批确认只做一次，不按文档逐条重复询问。`update_doc_sync_state` 没有 `dry-run`
  参数：只在用户确认整批、且单文档的替换或元数据更新成功之后才调用。
