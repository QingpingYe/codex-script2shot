# Phase 2：知识库同步 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal：** 把知识库 A 的增量变化（新增/修改/移动或重命名/删除）归纳成结构化知识卡写入知识库 B，并按文档维护 `SyncState`；同一文档重复同步不产生重复卡，失败可自然重试。

**Architecture：** MCP Server 负责全部确定性操作：节点扫描、正文读取、知识库 B 建表/校验、卡片替换、状态更新、删除清理。AI 归纳只在 `knowledge-sync` Skill 里发生：Skill 逐文档生成新卡，调用工具完成写入。同步事实只存在知识库 B 的 `SyncState`。

**Tech Stack：** Node.js >= 24 + TypeScript；vitest；构建与启动见架构 §7.1。

**Spec：** `docs/architecture.md` §5（B 的表与字段）、§6（增量更新流程与失败处理）、§8（MCP Tool）、§9.2（knowledge-sync）、§13（失败处理）、§14 Phase 2；`docs/knowledge-base-b.md`（内容要求）。

**前置：** Phase 1 完成（插件骨架、config、lark-cli 适配、health、fixture）。

## Global Constraints

- 知识库 A 只读；本阶段所有 `lark-cli` 调用不得出现对 A 的写操作（架构 §1.1-10）。
- 知识库 B 无草稿、审核、历史版本；知识卡没有 `status` 字段（§2.3、§5.2）。
- 增量判定只看节点元数据；未变化文档不读正文（§2.5、§6.2）。
- `source_revision` 在读正文后获得，只用于来源追踪和本地缓存刷新，不参与扫描阶段判定（§2.5）。
- 批量写操作先生成整批 dry-run 清单，用户确认后一次执行整批（§6.2）。
- 单文档失败不更新该文档 SyncState，不阻塞其他文档；不引入事务、补偿队列、并发锁（§6.3、§6.5）。
- `base +record-delete` 是 high-risk-write：只有整批确认后的执行路径才携带 `--yes`；dry-run 路径永远不带。
- 第一版不使用 `content_hash`（设计复盘 §1）。
- 批量 Base 写入单次上限 200 条（lark-cli 帮助，2026-10-20 核对）。

## Review Focus

1. 文档只移动或改名：不得重读正文、不得重跑归纳，只更新卡片来源元数据和 SyncState（Task 3 用例 `classify.treats_move_or_rename_as_metadata_only`、`scan.move_only_doc_triggers_no_fetch`；Task 5 用例 `replace.metadata_patch_updates_all_doc_cards`）。
2. 同一文档重复执行 `replace_doc_cards`：最终卡片集合不重复、数量稳定（Task 5 用例 `replace.is_idempotent_across_two_runs`）。
3. 删除文档：卡片与 SyncState 一并清理，且重复删除幂等（Task 5 用例 `delete.removes_cards_and_state`、`delete.is_idempotent_when_records_missing`）。
4. 写入中途失败：旧卡仍在、SyncState 保持旧值、重试后收敛到正确集合（Task 5 用例 `replace.failure_keeps_old_cards_and_allows_retry`、`update_state.not_called_when_replace_failed`）。
5. 扫描遇到非 docx 节点、shortcut 节点、根节点不在映射配置中：跳过并写 warning，不中断扫描（Task 3 用例 `scan.skips_non_doc_shortcut_and_unclassified_with_warnings`）。

---

### Task 1: 知识卡与 SyncState schema、Base 字段映射

**Files:**
- Create: `schemas/knowledge_card.schema.json`
- Create: `schemas/sync_state.schema.json`
- Create: `server/src/schemas.ts`（加载与校验）
- Create: `server/src/base_mapping.ts`（逻辑模型与 Base record 互转）
- Create: `server/tests/schemas.test.ts`
- Create: `server/tests/base_mapping.test.ts`
- Create: `tests/fixtures/knowledge_card.valid.json`、`knowledge_card.invalid.missing_required.json`、`knowledge_card.invalid.bad_category.json`、`knowledge_card.invalid.bad_target_model.json`
- Create: `tests/fixtures/sync_state.valid.json`、`sync_state.invalid.missing_required.json`

**Interfaces:**
- Consumes: 架构 §5.2、§5.3 的字段表；`docs/knowledge-base-b.md` §3–§5。
- Produces: `validate_knowledge_card(obj) -> { ok, errors[] }`、`validate_sync_state(obj) -> { ok, errors[] }`（draft 2020-12，`errors[].path` 指向具体字段）；`to_base_fields(card|state) -> BaseFieldMap`、`from_base_record(record) -> obj`。

冻结字段（schema 以此为准）：

- KnowledgeCard：`card_id`、`scope`（`general|project`）、`project_id`（可空）、`category`（`shot_breakdown|storyboard|prompt_technique|camera_lexicon|character_bible|scene_description|visual_style|project_rule|seedance_rule|example`）、`title`、`content`、`tags[]`、`entities[]`、`target_models[]`（元素 `seedance-2.0|seedance-2.5`）、`priority`（number）、`source_doc_token`、`source_node_token`、`source_path`、`source_title`、`source_revision`（integer）、`source_block_id`（可空）、`updated_at`（ISO 8601）。
- SyncState：`source_doc_token`、`source_node_token`、`source_path`、`source_title`、`scope`、`project_id`、`obj_edit_time`（原始字符串）、`source_revision`（integer）、`card_count`（integer）、`last_synced_at`（ISO 8601）、`last_sync_user`、`last_run_id`。
- Base 映射：`tags`、`entities`、`target_models` 存 JSON 文本数组；`priority`、`source_revision`、`card_count` 存数字；`updated_at`、`last_synced_at` 存 datetime CellValue `YYYY-MM-DD HH:mm`；其余文本。日期换算首版固定 `+08:00`，换算函数集中放在 `base_mapping`，并把该决定记录进 `server/README.md`。

- [ ] **Step 1: 写失败的校验测试**

```text
test("valid knowledge card fixture passes")
test("knowledge card rejects missing required field with path")
test("knowledge card rejects unknown category enum")
test("knowledge card rejects invalid target model entry")
test("valid sync state fixture passes")
test("sync state rejects non-integer card count")
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm --prefix server test -- schemas`
Expected: FAIL —— schema 文件不存在。

- [ ] **Step 3: 写两个 schema 与校验模块**

JSON Schema 用 draft 2020-12；`additionalProperties: false`；`category`、`scope`、`target_models` 用 enum。

- [ ] **Step 4: 写失败的映射测试**

```text
test("card arrays serialise to json text fields")
test("base record roundtrips card losslessly")
test("datetime converts between iso8601 and base cell format")
test("obj_edit_time stays an opaque string")
```

- [ ] **Step 5: 实现映射并跑通**

Run: `npm --prefix server test -- schemas`、`npm --prefix server test -- base_mapping`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add schemas/ server/src/schemas.* server/src/base_mapping.* server/tests/schemas.* server/tests/base_mapping.* tests/fixtures/
git commit -m "feat: add knowledge card and sync state schemas with base mapping"
```

### Task 2: `init_knowledge_b`（建表与校验）

**Files:**
- Create: `server/src/lark_base.ts`（Base 命令封装：tables/fields/records）
- Create: `server/src/tools/init_knowledge_b.ts`
- Create: `server/tests/lark_base.test.ts`
- Create: `server/tests/init_knowledge_b.test.ts`
- Modify: `server/src/index.ts`（注册工具）

**Interfaces:**
- Consumes: Task 1 的字段定义；Phase 1 的 config 与 lark-cli 封装。
- Produces: `list_tables(base)`、`create_table(base, name, fields)`、`list_fields(base, table_id)`、`list_records(base, table_id, { filter?, fields?, page_size? })`、`batch_create_records(base, table_id, fields[])`、`batch_update_records(base, table_id, updates[])`、`delete_records(base, table_id, record_ids[])`，全部经子进程参数数组调用 lark-cli；`init_knowledge_b({ dry_run }) -> { action: created|validated|drift, tables: { knowledge_cards, sync_state }, drift[], warnings[] }`。
- `list_records` 输出说明：`--format json` 的 inline 输出是矩阵形状（`data.fields` + `data.data` 行数组 + `data.record_id_list`），不是对象数组；适配器按 `fields × data rows` 拼装对象数组，或改用 ndjson 输出。二选一并保持确定性（2026-10-21 实测，见 `docs/lark-cli-capability-notes.md` §4）。

表与字段（表名固定，首字段为主字段）：

- `KnowledgeCards`：`card_id`(text)、`scope`(text)、`project_id`(text)、`category`(text)、`title`(text)、`content`(text)、`tags`(text)、`entities`(text)、`target_models`(text)、`priority`(number)、`source_doc_token`(text)、`source_node_token`(text)、`source_path`(text)、`source_title`(text)、`source_revision`(number)、`source_block_id`(text)、`updated_at`(datetime)。
- `SyncState`：`source_doc_token`(text)、`source_node_token`(text)、`source_path`(text)、`source_title`(text)、`scope`(text)、`project_id`(text)、`obj_edit_time`(text)、`source_revision`(number)、`card_count`(number)、`last_synced_at`(datetime)、`last_sync_user`(text)、`last_run_id`(text)。

drift 语义：缺字段或类型不符 ⇒ `drift[].issue=missing_field|type_mismatch`，`action=drift`，不自动改表；多余字段 ⇒ `issue=extra_field`，只写 warning；表名解析出多个 table_id ⇒ 报错要求人工处理。

- [ ] **Step 1: 写失败的测试**

```text
test("init creates both tables when missing")
test("init dry run performs no write calls")
test("init validates existing schema and reports missing field drift")
test("init reports extra fields as warnings not drift")
test("init is idempotent on second run")
test("init writes table ids to config only after execution")
```

假 lark-cli 记录全部调用 argv，断言 dry-run 路径无 `+table-create` 调用。

- [ ] **Step 2: 运行并确认失败**

Run: `npm --prefix server test -- init_knowledge_b`
Expected: FAIL。

- [ ] **Step 3: 实现 `lark_base` 与 `init_knowledge_b`**

命令按 2026-10-20 核对结果固定：`base +table-list`；`base +table-create --base-token --name --fields '<JSON>'`；`base +field-list --base-token --table-id`；`base +record-list --base-token --table-id --filter-json '<JSON>' --field-id ... --limit 200 --offset N --format json`；`base +record-batch-create --json '{"create_records":[...]}'`（每 200 条一批）；`base +record-batch-update --json '{"update_records":{...}}'`（每 200 条一批）；`base +record-delete --json '{"record_id_list":[...]}' --yes`（仅执行路径）。flag 以 `--help` 复核，偏差记录进 `docs/lark-cli-capability-notes.md`。

- [ ] **Step 4: 运行并确认通过**

Run: `npm --prefix server test -- init_knowledge_b`、`npm --prefix server test -- lark_base`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/src/lark_base.* server/src/tools/init_knowledge_b.* server/src/index.* server/tests/
git commit -m "feat: add knowledge base table init and validation tool"
```

### Task 3: 节点扫描、SyncState 读取与变化分类

**Files:**
- Create: `server/src/tools/scan_knowledge_a.ts`
- Create: `server/src/tools/read_sync_state.ts`
- Create: `server/src/sync_plan.ts`（纯函数：变化分类和 dry-run 清单）
- Create: `server/tests/sync_plan.test.ts`
- Create: `server/tests/scan_knowledge_a.test.ts`
- Modify: `docs/architecture.md` §6.1（补 shortcut、根节点映射与扫描命令规则）

**Interfaces:**
- Consumes: Task 2 的 `list_records`；Phase 1 的 config 与 `run_cli`；前置：Phase 1 Task 8（默认知识库与配置扩展）提供含 `project_roots` 的配置结构。
- Produces: `scan_knowledge_a() -> { nodes[], skipped[], warnings[] }`，`nodes[].{node_token, obj_token, obj_type, parent_node_token, title, obj_edit_time, path, scope, project_id}`；`read_sync_state() -> { records[] }`；`build_sync_plan(nodes, sync_records) -> { to_add[], to_update[], to_move[], to_delete[], unchanged[], warnings[] }`，条目含 `{source_doc_token, source_node_token, title, path, reason}`。

扫描实现：`wiki nodes list --space-id <space_a> --parent-node-token ? --page-size 50 --page-token ? --as user --format json` 手动翻页 + BFS 递归（不依赖 `--page-all` 上限；快捷 `wiki +node-list` 输出被裁剪、实测不含 `obj_edit_time`，不能用于扫描，2026-10-21 实测）。`source_doc_token` 取 `obj_token`。

分类规则（按优先级）：

1. 在 SyncState、节点不存在 ⇒ `to_delete`。
2. 在节点中、不在 SyncState ⇒ `to_add`。
3. `obj_edit_time` 不同 ⇒ `to_update`（即使同时移动/改名）。
4. `obj_edit_time` 相同但 `path` 或 `title` 不同 ⇒ `to_move`（只更新元数据）。
5. 其余 ⇒ `unchanged`。

scope/project 推导（分类前执行）：按架构 §4.4 的实现约定与 §7.3 的 `project_roots` 配置执行；路径推导保留为建议目录，只用于 `source_path` 展示。

跳过规则（写 warning，不中断）：`obj_type != "docx"`（`NON_DOC_NODE_SKIPPED`）；`node_type == "shortcut"`（`SHORTCUT_NODE_SKIPPED`，同步写进架构 §6.1）；根节点不在 `project_roots` 配置中（`UNMAPPED_ROOT_NODE_SKIPPED`）。

- [ ] **Step 1: 写失败的分类测试**

fixture 覆盖矩阵：新增、修改、仅移动、仅改名、修改+移动、删除、未变化、shortcut、非 docx、未映射根节点。

```text
test("classify detects every change kind")
test("classify treats edit plus move as update")
test("classify treats move or rename as metadata only")
test("classify reports deleted docs missing from scan")
test("sync plan lists counts for batch confirmation")
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm --prefix server test -- sync_plan`
Expected: FAIL。

- [ ] **Step 3: 实现分类纯函数**

输入输出全部是普通对象，无 I/O。

- [ ] **Step 4: 写失败的扫描测试（fake lark-cli）**

```text
test("scan pages through nested nodes and builds full paths")
test("scan skips non doc shortcut and unclassified with warnings")
test("scan derives scope and project id from root mapping")
test("move only doc triggers no fetch")
```

最后一条：对只移动的文档跑「plan 到处理」的干跑路径，断言调用日志里没有 `docs +fetch`。

fixture 引用：扫描用例基于 `server/tests/fixtures/lark-wiki-nodes-list.sample.json`（Phase 1 Task 7 录制，原始 API 形状）扩展。

- [ ] **Step 5: 实现 `scan_knowledge_a` 与 `read_sync_state`，更新架构 §6.1**

- [ ] **Step 6: 运行并确认通过**

Run: `npm --prefix server test -- sync_plan`、`npm --prefix server test -- scan_knowledge_a`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add server/src/tools/scan_knowledge_a.* server/src/tools/read_sync_state.* server/src/sync_plan.* server/tests/ docs/architecture.md
git commit -m "feat: add knowledge a scan, sync state read and change classification"
```

### Task 4: 单文档正文读取

**Files:**
- Create: `server/src/tools/fetch_knowledge_a_doc.ts`
- Create: `server/tests/fetch_knowledge_a_doc.test.ts`

**Interfaces:**
- Consumes: Phase 1 的 `run_cli`；Phase 1 Task 7 录制的 `server/tests/fixtures/lark-docs-fetch.sample.json`。
- Produces: `fetch_knowledge_a_doc({ doc }) -> { doc_token, revision_id, title, content, tips, warnings[] }`。

输入解析顺序：`/wiki/<token>` URL ⇒ 先 `wiki +node-get` 解析出 `obj_token` 再读；`/docx/<token>` 或 `doccn*` token ⇒ 直接读；`wikcn*` token ⇒ 先 `node-get`；其他原始 token ⇒ 先按文档读，失败再按节点解析一次。读取命令：`docs +fetch --doc <token> --doc-format markdown --revision-id -1 --format json`（flag 以 `--help` 复核；markdown 模式不提供 block id，`source_block_id` 留空；将来需要 block id 时改用 xml 模式）。`revision_id` 取 `data.document.revision_id`；`title` 取 `content` 首个标题行，取不到时回退节点标题并写 warning。失败返回 `error.code=DOC_FETCH_FAILED`，`details.doc` 带输入原文。

- [ ] **Step 1: 写失败测试**

```text
test("fetch parses document id revision and content")
test("fetch resolves wiki url to obj token")
test("fetch falls back to node resolution for unknown token")
test("fetch returns DOC_FETCH_FAILED with original input")
test("fetch keeps tips for safe replay")
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm --prefix server test -- fetch_knowledge_a_doc`
Expected: FAIL。

- [ ] **Step 3: 实现工具**

- [ ] **Step 4: 运行并确认通过**

Run: `npm --prefix server test -- fetch_knowledge_a_doc`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/src/tools/fetch_knowledge_a_doc.* server/tests/fetch_knowledge_a_doc.*
git commit -m "feat: add single document fetch tool"
```

### Task 5: 卡片替换、状态更新与删除

**Files:**
- Create: `server/src/tools/replace_doc_cards.ts`
- Create: `server/src/tools/update_doc_sync_state.ts`
- Create: `server/src/tools/delete_doc_cards.ts`
- Create: `server/tests/replace_doc_cards.test.ts`
- Create: `server/tests/delete_doc_cards.test.ts`
- Modify: `docs/architecture.md` §8（`replace_doc_cards` 行补 `metadata_patch` 模式）

**Interfaces:**
- Consumes: Task 2 的 `lark_base`；Task 1 的 Base 映射。
- Produces:
  - `replace_doc_cards({ source_doc_token, cards, dry_run }) -> { dry_run, planned, created_record_ids[], deleted_record_ids[], warnings[] }`。执行顺序固定：记录该 token 现有 record_id → 写入新卡（每 200 条一批）→ 删除第 1 步记录的旧 record_id。写入失败不执行删除；删除失败返回 `KB_WRITE_FAILED` 并列明已创建/已删除数量。输入 `cards` 的 `card_id` 必须表内唯一，校验失败直接拒绝。
  - `replace_doc_cards({ source_doc_token, metadata_patch: { source_path?, source_title?, scope?, project_id? }, dry_run })`：只批量更新现有卡片的来源元数据，不写新卡、不删卡。
  - `update_doc_sync_state({ record }) -> { record_id, action: created|updated }`：按 `source_doc_token` upsert。
  - `delete_doc_cards({ source_doc_token, dry_run }) -> { deleted_cards, deleted_state }`：删除该 token 的全部卡片和 SyncState 记录；执行路径的 `record-delete` 带 `--yes`，且只有 `dry_run=false` 时才出现；重复删除幂等。

- [ ] **Step 1: 写失败的替换测试**

```text
test("replace records old ids before writing new cards")
test("replace deletes only the recorded old ids")
test("replace is idempotent across two runs")
test("replace rejects duplicate card ids in input")
test("replace batches writes at 200 records")
test("replace failure keeps old cards and allows retry")
test("metadata patch updates all doc cards without new cards")
test("update state upserts by source doc token")
test("delete removes cards and state")
test("delete is idempotent when records missing")
test("update state not called when replace failed")
```

幂等用例断言：连续两次执行后，按 token 查回记录，`card_id` 集合等于输入集合、无重复、数量等于 `cards.length`。失败注入用例：fake CLI 在删除阶段返回失败，断言旧卡与新卡同时存在、SyncState 未动；再次执行后收敛正确。

- [ ] **Step 2: 运行并确认失败**

Run: `npm --prefix server test -- replace_doc_cards`、`npm --prefix server test -- delete_doc_cards`
Expected: FAIL。

- [ ] **Step 3: 实现三个工具，更新架构 §8**

在架构 §8 的 `replace_doc_cards` 行明确两种模式与执行顺序；§6.3 的失败语义不变。

- [ ] **Step 4: 运行并确认通过**

Run: `npm --prefix server test -- replace_doc_cards`、`npm --prefix server test -- delete_doc_cards`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/src/tools/replace_doc_cards.* server/src/tools/update_doc_sync_state.* server/src/tools/delete_doc_cards.* server/tests/ docs/architecture.md
git commit -m "feat: add card replacement, sync state update and deletion tools"
```

### Task 6: `knowledge-sync` Skill

**Files:**
- Create: `skills/knowledge-sync/SKILL.md`
- Create: `skills/knowledge-sync/references/card-authoring.md`

**Interfaces:**
- Consumes: `scan_knowledge_a`、`read_sync_state`、`fetch_knowledge_a_doc`、`replace_doc_cards`、`update_doc_sync_state`、`delete_doc_cards`、`health`。
- Produces: 用户可通过 `$knowledge-sync`（含 `$knowledge-sync 只同步这个文档：<URL 或 token>`）触发的流程说明。

SKILL.md 必须包含的小节：`适用时机`、`输入模式`（扫描模式/指定文档模式）、`流程`、`知识卡生成规则`（指向 `references/card-authoring.md`）、`失败处理`、`安全约定`。

扫描模式流程：

1. `health` 预检；未通过则停。
2. `read_sync_state` + `scan_knowledge_a` → `build_sync_plan`。
3. 输出整批 dry-run 清单（新增/修改/移动或重命名/删除，逐条列出 title 与 path），请用户确认一次。
4. 按文档处理：`fetch_knowledge_a_doc` → 生成知识卡（按 card-authoring）→ `replace_doc_cards`（执行）→ `update_doc_sync_state`。移动/改名类只调用 `metadata_patch` + 状态更新。
5. 删除类：逐条 `delete_doc_cards`。
6. 汇总报告：每文档状态、失败明细、warnings；失败文档明确「未更新 SyncState，可重试」。

指定文档模式：跳过第 2–3 步扫描，直接对给定文档执行第 4 步（强制重新归纳），状态更新照旧。

`card-authoring.md` 固定内容：十类分类与知识库 A 目录的映射（拆镜方法→`shot_breakdown`；镜头语言词典→`camera_lexicon`；镜头组与组接→`storyboard`；提示词结构→`prompt_technique`；正例反例→`example`；Seedance→`seedance_rule`；角色圣经→`character_bible`；场景说明→`scene_description`；视觉风格→`visual_style`；项目概述/项目术语→`project_rule`）；一张卡只讲一件事；内容必须可执行、可转译成画面；`card_id` 格式 `src:<source_doc_token>:<category>:<三位序号>`，同一文档内不重复；`target_models` 只填两个模型标识，通用留空；来源字段必填（`source_doc_token`、`source_node_token`、`source_path`、`source_title`、`source_revision`、`updated_at`）。

- [ ] **Step 1: 写 SKILL.md 与参考文件**

- [ ] **Step 2: 运行技能契约测试**

Run: `npm --prefix server test -- skills_contract`
Expected: PASS（自动纳入新 Skill）。

- [ ] **Step 3: Commit**

```bash
git add skills/knowledge-sync/
git commit -m "feat: add knowledge sync skill"
```

### Task 7: `setup` 扩展与真实同步演练

**Files:**
- Modify: `skills/setup/SKILL.md`（加入 `init_knowledge_b` 步骤与首次同步指引）
- Modify: `docs/lark-cli-capability-notes.md`（追加 Phase 2 实战记录）

**Interfaces:**
- Consumes: 本阶段全部工具；Phase 1 的 setup 流程。
- Produces: setup 完整流程 = 查 lark-cli → 登录 → 知识库 A/B 配置 → `init_knowledge_b` dry-run 预览 → 用户确认 → 建表 → table_id 写回 config → 本地目录 → 可选首次 `$knowledge-sync` → `health`。

- [ ] **Step 1: 更新 `skills/setup/SKILL.md`**

新增两条流程步骤与对应失败处理（drift 时提示人工修表或重建后重跑；建表是写操作，必须先 dry-run）。

- [ ] **Step 2: live 演练（真实飞书空间）**

准备三个测试文档（新增、修改、删除各一），依次执行：

1. 首次 `$knowledge-sync` → 核对 `KnowledgeCards` 与 `SyncState` 内容。
2. 修改一个文档后再次同步 → 只有该文档被处理，`source_revision` 更新。
3. 删除一个文档后第三次同步 → 卡片与状态被清理。
4. 第四次同步 → 全部 `unchanged`，`docs +fetch` 零调用（用 dry-run 清单核对）。
5. 指定文档模式对不存在 token 同步 → 结构化失败，SyncState 未更新。

- [ ] **Step 3: 把演练结果追加到 `docs/lark-cli-capability-notes.md`**

记录日期、五个场景的结果、遇到的偏差和修复。

- [ ] **Step 4: 回归全部测试**

Run: `npm --prefix server run build`；`npm --prefix server test`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add skills/setup/SKILL.md docs/lark-cli-capability-notes.md
git commit -m "feat: extend setup with knowledge base init and record sync pilot"
```

---

## 阶段出口检查

- [ ] schema fixture 覆盖缺失必填字段与错误枚举（Task 1）。
- [ ] 同一文档重复替换不产生重复卡（Task 5）。
- [ ] 未变化文档零正文读取、零写入（Task 7 演练第 4 步）。
- [ ] 失败文档不写 SyncState 且可单独重试（Task 5 测试 + Task 7 演练第 5 步）。
- [ ] 架构 §6.1（shortcut 规则）与 §8（metadata_patch）已同步更新。
