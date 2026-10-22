# Phase 3：本地检索 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal：** 从 AI 库增量刷新本地缓存和 SQLite 关键词索引，提供可重复验证的过滤、关键词检索和规则排序，以及按项目组装知识包。

**Architecture：** `cache/cards.json` 保存按文档聚合的卡片与本地缓存标记；`index/knowledge.sqlite` 保存检索用行数据和文档标记。`refresh_local_index` 以 AI 库的 `SyncState` 为唯一同步事实来源，只拉取变化文档；`search_knowledge` 与 `load_knowledge_pack` 只读本地索引和缓存，索引不可用时按 `priority` 降序回退并写 warning。

**Tech Stack：** Node.js >= 24 + TypeScript；SQLite 使用 Node 内置 `node:sqlite`（无原生模块，见架构 §7.1）。

**Spec：** `docs/architecture.md` §7.2（本地数据目录）、§7.4（缓存与索引刷新）、§8（MCP Tool）、§10（检索设计）、§13（失败处理）、§14 Phase 3；`references/stage-conventions.md` §3（检索契约）。

**前置：** Phase 2 完成（AI 库的表与同步工具可用）。

## Global Constraints

- 第一版只做关键词检索和规则排序；不引入向量索引、嵌入模型、分词器和模型重排（架构 §1.1-14、§10.2）。
- 排序规则固定为五级，不引入权重参数：标题或实体精确命中 > 标题或标签部分命中 > 正文命中 > priority 降序 > updated_at 降序（§10.2）。
- `target_model` 过滤放行两类卡片：`target_models` 含当前模型，或 `target_models` 为空（stage-conventions §3.1）。
- `script-breakdown` 阶段不做 `target_model` 过滤是调用方约定，本阶段工具只提供参数，不内置阶段逻辑。
- 本地缓存标记不是同步状态；AI 库的 `SyncState` 始终是权威（§2.4、§7.4）。
- 索引不可用时按 `priority` 降序回退并写 warning；AI 库不可达时有缓存则继续运行 + warning，无缓存则停止（§13）。
- 被预算截断的卡片按 `dropped_by_budget` 语义返回（stage-conventions §3.5）。

## Review Focus

1. 索引缺失或被损坏：检索必须回退到缓存按 `priority` 排序并写 warning，不崩溃（Task 2 用例 `index.reports_corrupt_file`；Task 4 用例 `search.falls_back_to_priority_when_index_unavailable`）。
2. 中文全角、大小写、多余空白：归一化后「角色Ａ」「角色a」「角色A 」命中一致（Task 2 用例 `normalize.covers_fullwidth_case_and_whitespace`）。
3. `max_cards` 与 `char_budget` 边界：负数报错；0 返回空并如实记录；超预算按排序从低到高截断（Task 4 用例 `search.rejects_negative_limits`、`search.drops_lowest_ranked_when_over_budget`）。
4. AI 库不可达但本地缓存存在：刷新照常返回、标记 `degraded` 并写 warning；无缓存时返回 `KB_B_UNREACHABLE`（Task 3 用例 `refresh.continues_with_cache_when_b_unreachable`、`refresh.stops_without_cache_when_b_unreachable`）。
5. `target_models` 为空数组或缺失：都视为通用卡放行（Task 4 用例 `search.treats_empty_target_models_as_universal`；Task 5 用例 `pack.filters_seedance_target_model` 覆盖反例）。

---

### Task 1: 本地缓存存储

**Files:**
- Create: `server/src/cache.ts`
- Create: `server/tests/cache.test.ts`

**Interfaces:**
- Consumes: Phase 1 的 `resolve_home()`；Phase 2 Task 1 的知识卡对象。
- Produces: `load_cache() -> { version, docs: { [token]: { source_revision, last_synced_at, cards[] } }, warnings[] }`；`save_cache(cache)`（临时文件 + 原子替换）；`get_doc_marker(token)`、`set_doc(cache, token, marker, cards)`、`remove_doc(cache, token)`。缓存文件固定为 `<home>/cache/cards.json`，`version: 1`。

- [ ] **Step 1: 写失败测试**

```text
test("cache roundtrips docs cards and markers")
test("cache reports missing file as empty cache")
test("cache reports corrupt file as rebuild needed")
test("cache atomic write leaves no partial json")
test("cache ignores stray temp files in cache dir")
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm --prefix server test -- cache`
Expected: FAIL。

- [ ] **Step 3: 实现缓存模块**

损坏文件读取时返回 `{ rebuild_needed: true }` 与 warning，删除动作由 `refresh_local_index` 决定，缓存模块自身不自动覆盖。

- [ ] **Step 4: 运行并确认通过**

Run: `npm --prefix server test -- cache`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/src/cache.* server/tests/cache.*
git commit -m "feat: add local card cache with atomic writes"
```

### Task 2: SQLite 关键词索引

**Files:**
- Create: `server/src/index_store.ts`
- Create: `server/src/normalize.ts`
- Create: `server/tests/index_store.test.ts`
- Create: `server/tests/normalize.test.ts`

**Interfaces:**
- Consumes: Task 1 的缓存对象；Phase 2 Task 1 的知识卡对象。
- Produces:
  - `normalize_text(s) -> s'`：NFKC → 小写 → 压缩空白。检索匹配统一走该函数。
  - `open_index(path = <home>/index/knowledge.sqlite) -> db`；首次打开自动建表：
    - `cards(card_id TEXT PRIMARY KEY, source_doc_token TEXT NOT NULL, scope TEXT, project_id TEXT, category TEXT, title TEXT, title_norm TEXT, content TEXT, content_norm TEXT, tags_json TEXT, entities_json TEXT, target_models_json TEXT, priority INTEGER, updated_at TEXT, source_path TEXT, source_revision INTEGER, last_synced_at TEXT)`；索引 `(scope, project_id, category)`。
    - `doc_state(source_doc_token TEXT PRIMARY KEY, source_revision INTEGER, last_synced_at TEXT)`。
  - `replace_doc_rows(db, token, cards, marker)`：单事务内删除该 token 旧行、插入新行、更新 `doc_state`。
  - `delete_doc_rows(db, token)`；`index_status(db) -> { state: ready|missing|corrupt, card_count }`；`list_doc_markers(db) -> markers[]`。

- [ ] **Step 1: 写失败的归一化测试**

```text
test("normalize covers fullwidth case and whitespace")
test("normalize keeps chinese characters unchanged")
test("normalize is idempotent")
```

- [ ] **Step 2: 写失败的索引测试**

```text
test("index rebuilds schema on empty file")
test("replace doc rows removes stale rows for same token")
test("delete doc rows removes cards and marker")
test("index reports corrupt file instead of throwing")
test("doc state marker roundtrips revision and sync time")
```

`index.reports_corrupt_file`：写入非 SQLite 字节后 `index_status` 返回 `state=corrupt`。

- [ ] **Step 3: 运行并确认失败**

Run: `npm --prefix server test -- normalize`、`npm --prefix server test -- index_store`
Expected: FAIL。

- [ ] **Step 4: 实现归一化与索引模块**

- [ ] **Step 5: 运行并确认通过**

Run: `npm --prefix server test -- normalize`、`npm --prefix server test -- index_store`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add server/src/index_store.* server/src/normalize.* server/tests/index_store.* server/tests/normalize.*
git commit -m "feat: add sqlite keyword index and text normalization"
```

### Task 3: `refresh_local_index`

**Files:**
- Create: `server/src/tools/refresh_local_index.ts`
- Create: `server/tests/refresh_local_index.test.ts`
- Modify: `server/src/index.ts`（注册工具）
- Modify: `server/src/tools/health.ts`（`index` 检查改为读真实索引状态）

**Interfaces:**
- Consumes: Task 1 缓存、Task 2 索引、Phase 2 的 `read_sync_state` 与 `list_records`。
- Produces: `refresh_local_index({ dry_run = true }) -> { dry_run, refreshed_docs[], removed_docs[], unchanged_docs[], index_status, degraded, warnings[] }`。

刷新算法（架构 §7.4）：读 AI 库的 `SyncState` 全表 → 与本地标记比较（`source_revision`、`last_synced_at`）→ 只拉取变化文档的卡片（`list_records` 按 `source_doc_token` 等值过滤）→ 只更新这些文档在缓存和索引中的数据 → 本地存在但 SyncState 不再存在的文档做删除。AI 库不可达：有缓存 ⇒ `degraded=true` + warning `KB_B_UNREACHABLE`；无缓存 ⇒ 返回 `KB_B_UNREACHABLE` 错误。`dry_run=true` 时不写缓存和索引。

- [ ] **Step 1: 写失败测试**

```text
test("refresh pulls only changed docs and leaves others untouched")
test("refresh removes docs missing from sync state")
test("refresh is a no-op when everything unchanged")
test("refresh dry run writes nothing")
test("refresh continues with cache when b unreachable")
test("refresh stops without cache when b unreachable")
test("refresh rebuilds when cache file was corrupt")
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm --prefix server test -- refresh_local_index`
Expected: FAIL。

- [ ] **Step 3: 实现工具**

每次运行结束返回准确的 `refreshed_docs[]`（token、card_count、reason）供 Skill 和 `script2shot` 入口展示。

- [ ] **Step 4: 运行并确认通过**

Run: `npm --prefix server test -- refresh_local_index`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/src/tools/refresh_local_index.* server/tests/refresh_local_index.* server/src/index.* server/src/tools/health.*
git commit -m "feat: add incremental local index refresh"
```

### Task 4: `search_knowledge`

**Files:**
- Create: `server/src/ranking.ts`（纯函数：过滤 + 命中级别）
- Create: `server/src/tools/search_knowledge.ts`
- Create: `server/tests/ranking.test.ts`
- Create: `server/tests/search_knowledge.test.ts`

**Interfaces:**
- Consumes: Task 2 索引与归一化；Task 1 缓存（回退路径）；Phase 1 配置（`retrieval.default_top_k`）。
- Produces: `search_knowledge({ query, scope?, project_id?, categories?, target_model?, max_cards?, char_budget?, explain? = false }) -> { candidates[], dropped_by_budget[], degraded, context, warnings[] }`。`explain` 参数在 Phase 5 生效，本阶段先接受但忽略（传 `true` 时返回 warning `EXPLAIN_NOT_AVAILABLE`）。

过滤顺序固定：`scope` → `project_id` → `category` → `target_model` → 关键词 → 排序。命中级别（1 最好）：

1. 标题或实体精确命中（归一化后相等）。
2. 标题或标签部分命中（子串）。
3. 正文命中（子串）。

排序：命中级别升序 → `priority` 降序 → `updated_at` 降序 → `card_id` 升序（确定性兜底）。`max_cards` 默认取配置 `retrieval.default_top_k`（12）；`char_budget` 可选；组装 `context` 文本（不含来源标注的正文拼接）超过预算时，从最低排序开始截断，被截断 `card_id` 记入 `dropped_by_budget`。`query` 为空 ⇒ 空候选 + warning `EMPTY_QUERY`；`max_cards < 0` 或 `char_budget < 0` ⇒ 错误。索引不可用 ⇒ 从缓存按 `priority` 降序回退（仍应用过滤），`degraded=true`、warning `INDEX_UNAVAILABLE`；无缓存 ⇒ `INDEX_UNAVAILABLE` 错误。

- [ ] **Step 1: 写失败的过滤与排序测试**

```text
test("search filters by scope with positive and negative cases")
test("search filters by project with positive and negative cases")
test("search filters by category with positive and negative cases")
test("search filters by target model with positive and negative cases")
test("search treats empty target models as universal")
test("search matches exact title and entity first")
test("search matches partial title and tags second")
test("search matches content last")
test("search sorts by priority then updated at then card id")
test("search drops lowest ranked when over budget")
test("search rejects negative limits")
test("search returns empty with warning for empty query")
test("search falls back to priority when index unavailable")
```

过滤正反例使用同一份 fixture：同一分类两张卡（一张命中、一张不命中），逐条件断言候选集合。

- [ ] **Step 2: 运行并确认失败**

Run: `npm --prefix server test -- ranking`、`npm --prefix server test -- search_knowledge`
Expected: FAIL。

- [ ] **Step 3: 实现 ranking 纯函数与检索工具**

检索用 SQL 做粗过滤（scope/project/category 与 `LIKE` 预筛），命中级别在内存中精算，保证与纯函数测试一致。

- [ ] **Step 4: 运行并确认通过**

Run: `npm --prefix server test -- ranking`、`npm --prefix server test -- search_knowledge`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/src/ranking.* server/src/tools/search_knowledge.* server/tests/ranking.* server/tests/search_knowledge.*
git commit -m "feat: add keyword search with filters and rule ranking"
```

### Task 5: `load_knowledge_pack`

**Files:**
- Create: `server/src/tools/load_knowledge_pack.ts`
- Create: `server/tests/load_knowledge_pack.test.ts`
- Modify: `server/src/index.ts`（注册工具）

**Interfaces:**
- Consumes: Task 2 索引。
- Produces: `load_knowledge_pack({ project_id, target_model, explain? = false }) -> { cards[], stats: { general, project, seedance }, warnings[] }`。包含：全部 `scope=general` 卡片；`scope=project` 且 `project_id` 匹配的卡片；`category=seedance_rule` 且 `target_model` 兼容的卡片。顺序固定：general（category 升序、card_id 升序）→ project（同上）→ seedance（同上）。项目无卡片 ⇒ warning `PROJECT_KNOWLEDGE_EMPTY`；general 无卡片 ⇒ warning `GENERAL_KNOWLEDGE_EMPTY`。

- [ ] **Step 1: 写失败测试**

```text
test("pack includes general project and compatible seedance cards")
test("pack excludes other projects")
test("pack filters seedance target model")
test("pack warns when project knowledge empty")
test("pack ordering is stable across runs")
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm --prefix server test -- load_knowledge_pack`
Expected: FAIL。

- [ ] **Step 3: 实现工具**

卡片输出统一字段：`card_id`、`category`、`title`、`content`、`tags`、`entities`、`priority`、来源五元组（`source_doc_token`、`source_path`、`source_revision`、`last_synced_at`），供阶段产物直接拼 `knowledge_refs`。

- [ ] **Step 4: 运行并确认通过**

Run: `npm --prefix server test -- load_knowledge_pack`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/src/tools/load_knowledge_pack.* server/tests/load_knowledge_pack.* server/src/index.*
git commit -m "feat: add knowledge pack loader"
```

---

## 阶段出口检查

- [ ] 四类过滤（scope/project/category/target_model）各有正例和反例测试。
- [ ] 排序五级规则有独立用例，重复运行结果稳定。
- [ ] 索引不可用与 AI 库不可达两个降级路径都有测试并写 warning。
- [ ] `health` 的 `index` 检查反映真实索引状态。
