# Phase 5：可选增强（检索诊断） 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal：** 为 `search_knowledge` 和 `load_knowledge_pack` 提供 `explain` 诊断输出，并提供一个只读的 `knowledge-inspect` 排查技能，回答「为什么这条知识没被用上」和「某项目的角色圣经是否已同步」。

**Architecture：** `explain` 是调用方参数，默认关闭；开启时仅在返回值里附加诊断信息，不落盘、不新增文件。`knowledge-inspect` 是 Skill，只用现有只读工具，不进入主流程。

**Tech Stack：** Node.js >= 24 + TypeScript；vitest；构建与启动见架构 §7.1。

**Spec：** `docs/architecture.md` §9（Skill 主列表与排查类技能说明）、§10.4（explain 约定）、§14 Phase 5；`references/stage-conventions.md` §5。

**前置：** Phase 3 完成（`search_knowledge`、`load_knowledge_pack` 可用）。本阶段可选，不阻塞 Phase 4。

## Global Constraints

- `explain` 默认关闭；关闭时输出必须与 Phase 3 行为逐字节一致（§10.4）。
- `explain` 只返回给调用方；不写入运行产物、不新增输出文件（§10.4、stage-conventions §5）。
- 降级情况必须同时写进 warnings，不能只体现在 `explain` 里（§10.4）。
- 第一版不返回向量或重排诊断（stage-conventions §5）。
- `knowledge-inspect` 只读知识库 B；不调用任何写工具，也不修改本地缓存和索引（§14 Phase 5）。
- `knowledge-inspect` 不进入架构 §9 的 Skill 主列表，只在排查知识问题时按需加载（§14 Phase 5）。

## Review Focus

1. `explain` 关闭时输出与 Phase 3 完全一致（Task 5-1 用例 `explain.off_matches_phase3_golden`）。
2. `explain` 开启不产生任何磁盘副作用：不写运行产物、不新增文件（Task 5-1 用例 `explain.writes_no_files`）。
3. 过滤淘汰原因必须准确落在四个取值之一：`scope`、`project_id`、`category`、`target_model`（Task 5-1 用例 `explain.reports_filter_elimination_reason`）。
4. 降级路径必须同时出现在 warnings（Task 5-1 用例 `explain.mirrors_fallback_into_warnings`）。
5. `knowledge-inspect` 全程只读（Task 5-2 用例 `skills_contract.knowledge_inspect_declares_no_write_tools` + live 检查清单）。

---

### Task 5-1: `search_knowledge` 与 `load_knowledge_pack` 的 `explain`

**Files:**
- Modify: `server/src/tools/search_knowledge.ts`
- Modify: `server/src/tools/load_knowledge_pack.ts`
- Create: `server/tests/explain.test.ts`
- Create: `tests/fixtures/explain/search.off.golden.json`、`tests/fixtures/explain/pack.off.golden.json`

**Interfaces:**
- Consumes: Phase 3 的检索与知识包工具。
- Produces:
  - `search_knowledge({ ..., explain: true }) -> { ..., explain: { candidates[], filtered_out[], fallback } }`。`candidates[]` 每条 `{ card_id, hit_level: "exact|partial|content", source: { source_doc_token, source_revision, last_synced_at } }`；`filtered_out[]` 每条 `{ card_id, filtered_by: "scope|project_id|category|target_model", detail }`，最多 50 条、按 `card_id` 升序；`fallback` 取值 `null | "priority_order" | "cache_scan"`。
  - `load_knowledge_pack({ ..., explain: true }) -> { ..., explain: { included[], excluded[], fallback } }`。`included[]` 每条 `{ card_id, reason: "general|project|seedance" }`；`excluded[]` 每条 `{ card_id, reason: "other_project|target_model_mismatch|category_not_in_pack" }`，最多 50 条。

- [ ] **Step 1: 写失败的回归与诊断测试**

```text
test("explain off matches phase3 golden")
test("explain reports hit levels")
test("explain reports filter elimination reason")
test("explain reports source version fields")
test("explain reports fallback path and mirrors warning")
test("explain writes no files")
test("pack explain reports inclusion and exclusion reasons")
```

`explain.off_matches_phase3_golden`：`explain` 缺省与 `explain=false` 的输出序列化后与 golden 完全一致；`explain.writes_no_files`：在临时 run 目录快照文件列表，调用 explain 前後文件集合不变。

- [ ] **Step 2: 运行并确认失败**

Run: `npm --prefix server test -- explain`
Expected: FAIL。

- [ ] **Step 3: 实现 explain**

`filtered_out` 在过滤前取候选集（应用 SQL 粗过滤之前的内存视图），逐条记录首个淘汰它的过滤条件；`fallback` 与 warning 在同一代码路径生成，保证两者一致。

- [ ] **Step 4: 运行并确认通过**

Run: `npm --prefix server test -- explain`、`npm --prefix server test -- search_knowledge`、`npm --prefix server test -- load_knowledge_pack`
Expected: PASS（含 Phase 3 回归）。

- [ ] **Step 5: Commit**

```bash
git add server/src/tools/search_knowledge.* server/src/tools/load_knowledge_pack.* server/tests/explain.* tests/fixtures/explain/
git commit -m "feat: add explain diagnostics for retrieval"
```

### Task 5-2: `knowledge-inspect` 排查技能

**Files:**
- Create: `skills/knowledge-inspect/SKILL.md`
- Modify: `server/tests/skills_contract.test.ts`（增加只读静态断言）

**Interfaces:**
- Consumes: `read_sync_state`、`search_knowledge`（含 `explain`）、`load_knowledge_pack`、`health`；运行目录里的 `knowledge_refs.json`（可选输入）。
- Produces: `$knowledge-inspect` 流程说明，回答两个固定问题：

1. **「为什么这条知识没被用上」**：用用户给的卡片关键词或 card_id 检索 → 开 `explain` 看命中级别与过滤淘汰原因 → 对照目标 run 的 `knowledge_refs.json` 判断是「没检索到」「被过滤」「被预算截断」还是「检索到了但没写进产物」；分别给出下一步动作（改知识卡位置/改查询/调预算/重跑阶段）。
2. **「某项目的角色圣经是否已同步」**：`read_sync_state` 过滤 `source_path` 前缀 `项目知识/<project_id>/角色圣经/` → 列出每个文档的 `obj_edit_time`、`source_revision`、`last_synced_at`、`card_count`；与本地索引标记对照（只读）报告「已同步/本地过期/从未同步」。

- [ ] **Step 1: 写 SKILL.md**

frontmatter `name: knowledge-inspect`；正文含 `适用时机`、`两个固定问题与流程`、`只读约定`（明确禁止调用 `init_knowledge_b`、`replace_doc_cards`、`update_doc_sync_state`、`delete_doc_cards`、`refresh_local_index`）、`输出格式`（结论 + 证据 + 建议动作）、`边界`（不进入主流程）。

- [ ] **Step 2: 增加静态只读断言**

```text
test("knowledge inspect declares no write tools")
```

断言 `skills/knowledge-inspect/SKILL.md` 不出现上述五个写工具名（允许出现在「禁止调用」列表里时改为断言：不存在「调用 <工具>」形式的指令；实现按最简可行方案：维护一个禁止清单段落与一条正向断言清单段落，测试校验两段存在）。

- [ ] **Step 3: 运行并确认通过**

Run: `npm --prefix server test -- skills_contract`
Expected: PASS。

- [ ] **Step 4: live 检查清单**

用真实环境验证两个固定问题各一次：一个「未命中」知识卡和一个「已同步/本地过期」文档；把结论与证据写入 `docs/lark-cli-capability-notes.md` 的追加小节。

- [ ] **Step 5: Commit**

```bash
git add skills/knowledge-inspect/ server/tests/skills_contract.* docs/lark-cli-capability-notes.md
git commit -m "feat: add knowledge inspect diagnostic skill"
```

---

## 阶段出口检查

- [ ] `explain` 默认关闭且回归 golden 通过。
- [ ] `explain` 输出包含命中级别、过滤淘汰原因、来源版本、降级路径四类信息。
- [ ] 降级同时出现在 warnings 中。
- [ ] `knowledge-inspect` 通过只读静态断言，并完成两个真实场景检查。
