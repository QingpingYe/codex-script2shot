import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { to_base_fields, type KnowledgeCard, type SyncState } from "../src/base_mapping.js";
import {
  CACHE_VERSION,
  cache_file_path,
  load_cache,
  save_cache,
  set_doc,
  type DocMarker,
  type LocalCardCache,
} from "../src/cache.js";
import {
  index_file_path,
  index_status,
  list_doc_markers,
  open_index,
  replace_doc_rows,
  type DocStateMarker,
} from "../src/index_store.js";
import {
  refresh_local_index,
  type RefreshLocalIndexResult,
  type RefreshLocalIndexSuccess,
} from "../src/tools/refresh_local_index.js";

/**
 * `refresh_local_index`（Task 3）测试。
 *
 * 全部外部调用走 `server/tests/fixtures/fake-lark-cli.*`；测试只用
 * `SCRIPT2SHOT_HOME` 指向的临时目录，绝不触碰真实知识库 B。
 */

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const IS_WINDOWS = process.platform === "win32";
const LAUNCHER = path.join(
  REPO_ROOT,
  "scripts",
  IS_WINDOWS ? "launch_script2shot_mcp.cmd" : "launch_script2shot_mcp",
);

const BASE_B = "base-token-b-123456789";
const CARDS_TABLE = "tbl_cards";
const STATE_TABLE = "tbl_state";
const DOC_A = "doccnRefreshA";
const DOC_B = "doccnRefreshB";
const DOC_GONE = "doccnRefreshGone";
const SYNCED_AT = "2026-10-21T10:00:00+08:00";
const SYNCED_AT_LATER = "2026-10-21T11:00:00+08:00";
const FROZEN_TIME = new Date("2000-01-01T00:00:00Z");

const KNOWLEDGE_CARDS_FIELDS = [
  { name: "card_id", type: "text" },
  { name: "scope", type: "text" },
  { name: "project_id", type: "text" },
  { name: "category", type: "text" },
  { name: "title", type: "text" },
  { name: "content", type: "text" },
  { name: "tags", type: "text" },
  { name: "entities", type: "text" },
  { name: "target_models", type: "text" },
  { name: "priority", type: "number" },
  { name: "source_doc_token", type: "text" },
  { name: "source_node_token", type: "text" },
  { name: "source_path", type: "text" },
  { name: "source_title", type: "text" },
  { name: "source_revision", type: "number" },
  { name: "source_block_id", type: "text" },
  { name: "updated_at", type: "datetime" },
];

const SYNC_STATE_FIELDS = [
  { name: "source_doc_token", type: "text" },
  { name: "source_node_token", type: "text" },
  { name: "source_path", type: "text" },
  { name: "source_title", type: "text" },
  { name: "scope", type: "text" },
  { name: "project_id", type: "text" },
  { name: "obj_edit_time", type: "text" },
  { name: "source_revision", type: "number" },
  { name: "card_count", type: "number" },
  { name: "last_synced_at", type: "datetime" },
  { name: "last_sync_user", type: "text" },
  { name: "last_run_id", type: "text" },
];

interface FakeRecord {
  record_id: string;
  fields: Record<string, unknown>;
}

interface FakeState {
  tables: Array<{ id: string; name: string; fields: Array<{ id?: string; name: string; type: string }> }>;
  records: Record<string, FakeRecord[]>;
}

interface SeededDoc {
  token: string;
  marker: DocMarker;
  cards: KnowledgeCard[];
}

let tempRoot = "";
let home = "";
let cliPath = "";
let statePath = "";
let logPath = "";
let env: NodeJS.ProcessEnv;
let previousHome: string | undefined;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "script2shot-refresh-"));
  home = path.join(tempRoot, "home");
  mkdirSync(home, { recursive: true });
  cliPath = install_fake_cli(path.join(tempRoot, "bin"));
  statePath = path.join(tempRoot, "base-state.json");
  logPath = path.join(tempRoot, "calls.jsonl");
  env = {
    ...process.env,
    LARK_CLI_PATH: cliPath,
    FAKE_SCENARIO: "ok",
    FAKE_BASE_STATE_FILE: statePath,
    FAKE_LOG_FILE: logPath,
  };
  previousHome = process.env.SCRIPT2SHOT_HOME;
  process.env.SCRIPT2SHOT_HOME = home;
  write_config_file();
  write_base_state();
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.SCRIPT2SHOT_HOME;
  } else {
    process.env.SCRIPT2SHOT_HOME = previousHome;
  }
  rmSync(tempRoot, { recursive: true, force: true });
});

/** 把假 CLI 装进指定目录，返回可直接执行的包装脚本路径（Windows 为 .cmd）。 */
function install_fake_cli(dir: string, name = "lark-cli"): string {
  mkdirSync(dir, { recursive: true });
  const wrapper_name = IS_WINDOWS ? `${name}.cmd` : name;
  cpSync(
    path.join(FIXTURES_DIR, IS_WINDOWS ? "fake-lark-cli.cmd" : "fake-lark-cli"),
    path.join(dir, wrapper_name),
  );
  cpSync(path.join(FIXTURES_DIR, "fake-lark-cli.mjs"), path.join(dir, `${name}.mjs`));
  const wrapper_path = path.join(dir, wrapper_name);
  if (!IS_WINDOWS) {
    chmodSync(wrapper_path, 0o755);
  }
  return wrapper_path;
}

function write_config_file(options: { cards_table?: string; sync_state_table?: string } = {}): void {
  writeFileSync(
    path.join(home, "config.toml"),
    [
      "[lark]",
      'profile = "default"',
      'space_a = "space-a-1"',
      `base_b = "${BASE_B}"`,
      `knowledge_cards_table_id = "${options.cards_table ?? CARDS_TABLE}"`,
      `sync_state_table_id = "${options.sync_state_table ?? STATE_TABLE}"`,
      "",
      "[retrieval]",
      "default_top_k = 12",
      "",
    ].join("\n"),
    "utf8",
  );
}

function with_field_ids(
  fields: Array<{ name: string; type: string }>,
): Array<{ id: string; name: string; type: string }> {
  return fields.map((field, index) => ({ id: `fld_${index + 1}`, ...field }));
}

function write_base_state(
  records: { cards?: FakeRecord[]; state?: FakeRecord[] } = {},
): void {
  const state: FakeState = {
    tables: [
      { id: CARDS_TABLE, name: "KnowledgeCards", fields: with_field_ids(KNOWLEDGE_CARDS_FIELDS) },
      { id: STATE_TABLE, name: "SyncState", fields: with_field_ids(SYNC_STATE_FIELDS) },
    ],
    records: {
      [CARDS_TABLE]: records.cards ?? [],
      [STATE_TABLE]: records.state ?? [],
    },
  };
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function make_state(token: string, overrides: Partial<SyncState> = {}): SyncState {
  return {
    source_doc_token: token,
    source_node_token: `node-${token}`,
    source_path: `/通用知识/${token}`,
    source_title: `文档 ${token}`,
    scope: "general",
    project_id: null,
    obj_edit_time: "1760000000",
    source_revision: 1,
    card_count: 1,
    last_synced_at: SYNCED_AT,
    last_sync_user: "tester",
    last_run_id: "run-20261021-100000",
    ...overrides,
  };
}

function make_card(
  card_id: string,
  token: string,
  overrides: Partial<KnowledgeCard> = {},
): KnowledgeCard {
  return {
    card_id,
    scope: "general",
    project_id: null,
    category: "prompt_technique",
    title: `卡片 ${card_id}`,
    content: `内容 ${card_id}`,
    tags: ["夜景"],
    entities: ["角色A"],
    target_models: [],
    priority: 5,
    source_doc_token: token,
    source_node_token: `node-${token}`,
    source_path: `/通用知识/${token}`,
    source_title: `文档 ${token}`,
    source_revision: 1,
    source_block_id: null,
    updated_at: "2026-10-21T10:00:00+08:00",
    ...overrides,
  };
}

function card_row(record_id: string, card: KnowledgeCard): FakeRecord {
  return { record_id, fields: to_base_fields(card) };
}

function state_row(record_id: string, record: SyncState): FakeRecord {
  return { record_id, fields: to_base_fields(record) };
}

function marker_of(record: SyncState): DocMarker {
  return { source_revision: record.source_revision, last_synced_at: record.last_synced_at };
}

function seed_cache(docs: SeededDoc[]): void {
  const cache: LocalCardCache = { version: CACHE_VERSION, docs: {} };
  for (const doc of docs) {
    set_doc(cache, doc.token, doc.marker, doc.cards);
  }
  save_cache(cache);
}

function seed_index(docs: SeededDoc[]): void {
  const db = open_index();
  try {
    for (const doc of docs) {
      replace_doc_rows(db, doc.token, doc.cards, doc.marker);
    }
  } finally {
    db.close();
  }
}

function read_index_rows(): {
  markers: DocStateMarker[];
  cards: Array<{ card_id: string; source_doc_token: string; source_revision: number }>;
} {
  const db = open_index();
  try {
    const cards = db
      .prepare(
        "SELECT card_id, source_doc_token, source_revision FROM cards ORDER BY card_id",
      )
      .all()
      .map((row) => ({
        card_id: String(row.card_id),
        source_doc_token: String(row.source_doc_token),
        source_revision: Number(row.source_revision),
      }));
    return { markers: list_doc_markers(db), cards };
  } finally {
    db.close();
  }
}

function read_calls(): Array<{ scenario: string; args: string[] }> {
  if (!existsSync(logPath)) {
    return [];
  }
  return readFileSync(logPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { scenario: string; args: string[] });
}

function source_doc_filter(token: string): Record<string, unknown> {
  return { logic: "and", conditions: [["source_doc_token", "==", token]] };
}

/** 只收集 KnowledgeCards 表的 `+record-list` 过滤条件，用于断言「只拉取变化文档」。 */
function cards_fetch_filters(): Record<string, unknown>[] {
  const filters: Record<string, unknown>[] = [];
  for (const call of read_calls()) {
    if (!call.args.includes("+record-list")) {
      continue;
    }
    const table_index = call.args.indexOf("--table-id");
    if (table_index < 0 || call.args[table_index + 1] !== CARDS_TABLE) {
      continue;
    }
    const filter_index = call.args.indexOf("--filter-json");
    if (filter_index >= 0) {
      filters.push(JSON.parse(call.args[filter_index + 1] as string) as Record<string, unknown>);
    }
  }
  return filters;
}

/** 把缓存文件时间戳冻结到 2000-01-01，用于断言「没有写盘」。 */
function freeze_cache_mtime(): number {
  utimesSync(cache_file_path(), FROZEN_TIME, FROZEN_TIME);
  return statSync(cache_file_path()).mtimeMs;
}

function run_refresh(input: {
  dry_run?: unknown;
} = {}): Promise<RefreshLocalIndexResult> {
  return refresh_local_index({ ...input, env });
}

function expect_success(result: RefreshLocalIndexResult): RefreshLocalIndexSuccess {
  if ("ok" in result && result.ok === false) {
    throw new Error(`refresh_local_index 失败：${JSON.stringify(result.error)}`);
  }
  return result as RefreshLocalIndexSuccess;
}

describe("refresh_local_index", () => {
  test("refresh pulls only changed docs and leaves others untouched", async () => {
    const state_a = make_state(DOC_A, {
      source_revision: 2,
      last_synced_at: SYNCED_AT_LATER,
      card_count: 2,
    });
    const state_b = make_state(DOC_B);
    write_base_state({
      state: [state_row("rec_state_a", state_a), state_row("rec_state_b", state_b)],
      cards: [
        card_row("rec_card_a1", make_card("card-a1", DOC_A, { source_revision: 2 })),
        card_row("rec_card_a2", make_card("card-a2", DOC_A, { source_revision: 2 })),
        card_row("rec_card_b1", make_card("card-b1", DOC_B)),
      ],
    });

    const docs: SeededDoc[] = [
      {
        token: DOC_A,
        marker: { source_revision: 1, last_synced_at: SYNCED_AT },
        cards: [make_card("card-a-stale", DOC_A)],
      },
      {
        token: DOC_B,
        marker: marker_of(state_b),
        cards: [make_card("card-b1", DOC_B)],
      },
    ];
    seed_cache(docs);
    seed_index(docs);

    const result = expect_success(await run_refresh({ dry_run: false }));

    expect(result).toMatchObject({
      dry_run: false,
      degraded: false,
      refreshed_docs: [{ source_doc_token: DOC_A, card_count: 2, reason: "updated" }],
      removed_docs: [],
      unchanged_docs: [DOC_B],
      index_status: { state: "ready", card_count: 3 },
      warnings: [],
    });

    const cache = load_cache();
    expect(cache.docs[DOC_A]?.source_revision).toBe(2);
    expect(cache.docs[DOC_A]?.last_synced_at).toBe(SYNCED_AT_LATER);
    expect(cache.docs[DOC_A]?.cards.map((card) => card.card_id)).toEqual([
      "card-a1",
      "card-a2",
    ]);
    expect(cache.docs[DOC_B]?.cards.map((card) => card.card_id)).toEqual(["card-b1"]);

    const indexed = read_index_rows();
    expect(indexed.cards.map((row) => row.card_id)).toEqual(["card-a1", "card-a2", "card-b1"]);
    expect(indexed.markers).toEqual([
      { source_doc_token: DOC_A, source_revision: 2, last_synced_at: SYNCED_AT_LATER },
      { source_doc_token: DOC_B, source_revision: 1, last_synced_at: SYNCED_AT },
    ]);

    expect(cards_fetch_filters()).toEqual([source_doc_filter(DOC_A)]);
  });

  test("refresh removes docs missing from sync state", async () => {
    const state_a = make_state(DOC_A);
    write_base_state({
      state: [state_row("rec_state_a", state_a)],
      cards: [card_row("rec_card_a1", make_card("card-a1", DOC_A))],
    });

    const docs: SeededDoc[] = [
      {
        token: DOC_A,
        marker: marker_of(state_a),
        cards: [make_card("card-a1", DOC_A)],
      },
      {
        token: DOC_GONE,
        marker: { source_revision: 1, last_synced_at: SYNCED_AT },
        cards: [make_card("card-gone1", DOC_GONE)],
      },
    ];
    seed_cache(docs);
    seed_index(docs);

    const result = expect_success(await run_refresh({ dry_run: false }));

    expect(result).toMatchObject({
      dry_run: false,
      degraded: false,
      refreshed_docs: [],
      removed_docs: [DOC_GONE],
      unchanged_docs: [DOC_A],
      index_status: { state: "ready", card_count: 1 },
    });
    expect(Object.keys(load_cache().docs)).toEqual([DOC_A]);

    const indexed = read_index_rows();
    expect(indexed.cards.map((row) => row.card_id)).toEqual(["card-a1"]);
    expect(indexed.markers.map((row) => row.source_doc_token)).toEqual([DOC_A]);
    expect(cards_fetch_filters(), "无变化文档时不拉取知识卡").toEqual([]);
  });

  test("refresh is a no-op when everything unchanged", async () => {
    const state_a = make_state(DOC_A);
    const state_b = make_state(DOC_B);
    write_base_state({
      state: [state_row("rec_state_a", state_a), state_row("rec_state_b", state_b)],
      cards: [],
    });

    const docs: SeededDoc[] = [
      { token: DOC_A, marker: marker_of(state_a), cards: [make_card("card-a1", DOC_A)] },
      { token: DOC_B, marker: marker_of(state_b), cards: [make_card("card-b1", DOC_B)] },
    ];
    seed_cache(docs);
    seed_index(docs);
    const frozen = freeze_cache_mtime();

    const result = expect_success(await run_refresh({ dry_run: false }));

    expect(result).toMatchObject({
      dry_run: false,
      degraded: false,
      refreshed_docs: [],
      removed_docs: [],
      unchanged_docs: [DOC_A, DOC_B],
      index_status: { state: "ready", card_count: 2 },
    });
    expect(cards_fetch_filters(), "全部未变化时不拉取任何知识卡").toEqual([]);
    expect(statSync(cache_file_path()).mtimeMs, "无变化时不重写缓存文件").toBe(frozen);
    expect(read_index_rows().markers).toEqual([
      { source_doc_token: DOC_A, source_revision: 1, last_synced_at: SYNCED_AT },
      { source_doc_token: DOC_B, source_revision: 1, last_synced_at: SYNCED_AT },
    ]);
  });

  test("refresh removes index doc_state rows that the cache no longer knows", async () => {
    const state_a = make_state(DOC_A);
    write_base_state({
      state: [state_row("rec_state_a", state_a)],
      cards: [card_row("rec_card_a1", make_card("card-a1", DOC_A))],
    });
    // 索引里有 doc_state 行但缓存没有它（save_cache 失败、崩溃或缓存文件被删除/恢复），
    // 且 B 的 SyncState 已经没有该 token：必须按索引的 doc_state 把它清掉。
    seed_cache([
      { token: DOC_A, marker: marker_of(state_a), cards: [make_card("card-a1", DOC_A)] },
    ]);
    seed_index([
      { token: DOC_A, marker: marker_of(state_a), cards: [make_card("card-a1", DOC_A)] },
      {
        token: DOC_GONE,
        marker: { source_revision: 1, last_synced_at: SYNCED_AT },
        cards: [make_card("card-gone1", DOC_GONE)],
      },
    ]);

    const result = expect_success(await run_refresh({ dry_run: false }));

    expect(result).toMatchObject({
      dry_run: false,
      degraded: false,
      refreshed_docs: [],
      removed_docs: [DOC_GONE],
      unchanged_docs: [DOC_A],
      index_status: { state: "ready", card_count: 1 },
    });
    expect(Object.keys(load_cache().docs)).toEqual([DOC_A]);

    const indexed = read_index_rows();
    expect(indexed.cards.map((row) => row.card_id)).toEqual(["card-a1"]);
    expect(indexed.markers.map((row) => row.source_doc_token)).toEqual([DOC_A]);
  });

  test("refresh dry run writes nothing", async () => {
    const state_a = make_state(DOC_A, {
      source_revision: 2,
      last_synced_at: SYNCED_AT_LATER,
      card_count: 2,
    });
    const state_b = make_state(DOC_B);
    write_base_state({
      state: [state_row("rec_state_a", state_a), state_row("rec_state_b", state_b)],
      cards: [
        card_row("rec_card_a1", make_card("card-a1", DOC_A, { source_revision: 2 })),
        card_row("rec_card_a2", make_card("card-a2", DOC_A, { source_revision: 2 })),
      ],
    });

    const docs: SeededDoc[] = [
      {
        token: DOC_A,
        marker: { source_revision: 1, last_synced_at: SYNCED_AT },
        cards: [make_card("card-a-stale", DOC_A)],
      },
      { token: DOC_B, marker: marker_of(state_b), cards: [make_card("card-b1", DOC_B)] },
      {
        token: DOC_GONE,
        marker: { source_revision: 1, last_synced_at: SYNCED_AT },
        cards: [make_card("card-gone1", DOC_GONE)],
      },
    ];
    seed_cache(docs);
    seed_index(docs);
    const frozen = freeze_cache_mtime();
    const cache_before = load_cache();

    // 不传 dry_run 时默认 true。
    const result = expect_success(await run_refresh());

    expect(result).toMatchObject({
      dry_run: true,
      degraded: false,
      refreshed_docs: [{ source_doc_token: DOC_A, card_count: 2, reason: "updated" }],
      removed_docs: [DOC_GONE],
      unchanged_docs: [DOC_B],
      index_status: { state: "ready", card_count: 3 },
    });
    expect(cards_fetch_filters(), "dry run 仍读取变化文档的卡片以给出准确 card_count").toEqual([
      source_doc_filter(DOC_A),
    ]);
    expect(statSync(cache_file_path()).mtimeMs, "dry run 不写缓存文件").toBe(frozen);
    expect(load_cache()).toEqual(cache_before);
    expect(read_index_rows()).toEqual({
      markers: [
        { source_doc_token: DOC_A, source_revision: 1, last_synced_at: SYNCED_AT },
        { source_doc_token: DOC_B, source_revision: 1, last_synced_at: SYNCED_AT },
        { source_doc_token: DOC_GONE, source_revision: 1, last_synced_at: SYNCED_AT },
      ],
      cards: [
        { card_id: "card-a-stale", source_doc_token: DOC_A, source_revision: 1 },
        { card_id: "card-b1", source_doc_token: DOC_B, source_revision: 1 },
        { card_id: "card-gone1", source_doc_token: DOC_GONE, source_revision: 1 },
      ],
    });
  });

  test("refresh dry run creates neither cache file nor index directory", async () => {
    const state_a = make_state(DOC_A);
    write_base_state({
      state: [state_row("rec_state_a", state_a)],
      cards: [card_row("rec_card_a1", make_card("card-a1", DOC_A))],
    });

    const result = expect_success(await run_refresh({ dry_run: true }));

    expect(result).toMatchObject({
      dry_run: true,
      degraded: false,
      refreshed_docs: [{ source_doc_token: DOC_A, card_count: 1, reason: "added" }],
      removed_docs: [],
      unchanged_docs: [],
      index_status: { state: "missing", card_count: 0 },
    });
    expect(existsSync(path.join(home, "cache"))).toBe(false);
    expect(existsSync(cache_file_path())).toBe(false);
    expect(existsSync(path.join(home, "index"))).toBe(false);
  });

  test("refresh dry run leaves a 0-byte index file untouched and not ready", async () => {
    const state_a = make_state(DOC_A);
    write_base_state({
      state: [state_row("rec_state_a", state_a)],
      cards: [card_row("rec_card_a1", make_card("card-a1", DOC_A))],
    });
    const index_path = index_file_path();
    mkdirSync(path.dirname(index_path), { recursive: true });
    writeFileSync(index_path, "");

    const dry = expect_success(await run_refresh({ dry_run: true }));

    expect(dry.index_status, "0 字节索引不得被探测成 ready").toEqual({
      state: "corrupt",
      card_count: 0,
    });
    expect(statSync(index_path).size, "dry run 不得给 0 字节索引补建 schema").toBe(0);
    expect(readFileSync(index_path).length).toBe(0);

    // 执行路径仍能重建这个不可用的索引文件。
    const applied = expect_success(await run_refresh({ dry_run: false }));
    expect(applied.index_status).toEqual({ state: "ready", card_count: 1 });
    expect(readFileSync(index_path).length).toBeGreaterThan(0);
  });

  test("refresh reports a structured error when the stale index cannot be removed", async () => {
    const state_a = make_state(DOC_A);
    write_base_state({
      state: [state_row("rec_state_a", state_a)],
      cards: [],
    });
    seed_cache([
      { token: DOC_A, marker: marker_of(state_a), cards: [make_card("card-a1", DOC_A)] },
    ]);
    // 索引路径是「非空目录」：探测报 corrupt，重建前的删除会失败。
    const index_path = index_file_path();
    mkdirSync(index_path, { recursive: true });
    writeFileSync(path.join(index_path, "occupied.txt"), "occupied", "utf8");

    const result = await run_refresh({ dry_run: false });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "INDEX_UNAVAILABLE", details: { path: index_path } },
    });
    expect(existsSync(path.join(index_path, "occupied.txt")), "删除失败时保留原路径").toBe(true);
  });

  test("refresh deletes a half-built index and reports a structured error", async () => {
    const state_a = make_state(DOC_A, {
      source_revision: 2,
      last_synced_at: SYNCED_AT_LATER,
    });
    write_base_state({
      state: [state_row("rec_state_a", state_a)],
      cards: [
        card_row("rec_card_shared", make_card("card-shared", DOC_A, { source_revision: 2 })),
      ],
    });
    seed_cache([
      {
        token: DOC_A,
        marker: { source_revision: 1, last_synced_at: SYNCED_AT },
        cards: [make_card("card-a-stale", DOC_A)],
      },
      {
        token: DOC_GONE,
        marker: { source_revision: 1, last_synced_at: SYNCED_AT },
        cards: [make_card("card-shared", DOC_GONE)],
      },
    ]);
    // DOC_GONE 占用了 card-shared 这个主键：写入 DOC_A 的新卡时主键冲突。
    seed_index([
      {
        token: DOC_GONE,
        marker: { source_revision: 1, last_synced_at: SYNCED_AT },
        cards: [make_card("card-shared", DOC_GONE)],
      },
    ]);

    const result = await run_refresh({ dry_run: false });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "INDEX_UNAVAILABLE",
        details: { path: index_file_path(), cleanup_failed: false },
      },
    });
    expect(existsSync(index_file_path()), "不完整索引已删除").toBe(false);
  });

  test.skipIf(!IS_WINDOWS)(
    "refresh reports a structured error when the index file is locked",
    async () => {
      const state_a = make_state(DOC_A, {
        source_revision: 2,
        last_synced_at: SYNCED_AT_LATER,
      });
      write_base_state({
        state: [state_row("rec_state_a", state_a)],
        cards: [
          card_row("rec_card_shared", make_card("card-shared", DOC_A, { source_revision: 2 })),
        ],
      });
      seed_cache([
        {
          token: DOC_A,
          marker: { source_revision: 1, last_synced_at: SYNCED_AT },
          cards: [make_card("card-a-stale", DOC_A)],
        },
        {
          token: DOC_GONE,
          marker: { source_revision: 1, last_synced_at: SYNCED_AT },
          cards: [make_card("card-shared", DOC_GONE)],
        },
      ]);
      // 持有写句柄：Windows 上删除被占用的 SQLite 文件会 EBUSY/EPERM，
      // 用来覆盖「索引写失败 + 清理也失败」的分支。
      const lock = open_index();
      try {
        replace_doc_rows(lock, DOC_GONE, [make_card("card-shared", DOC_GONE)], {
          source_revision: 1,
          last_synced_at: SYNCED_AT,
        });

        const result = await run_refresh({ dry_run: false });

        expect(result).toMatchObject({
          ok: false,
          error: {
            code: "INDEX_UNAVAILABLE",
            details: { path: index_file_path(), cleanup_failed: true },
          },
        });
        expect(existsSync(index_file_path()), "清理失败时保留原索引文件").toBe(true);
      } finally {
        lock.close();
      }
    },
  );

  test("refresh continues with cache when b unreachable", async () => {
    env = { ...env, FAKE_SCENARIO: "base-unreachable" };
    const docs: SeededDoc[] = [
      {
        token: DOC_A,
        marker: { source_revision: 1, last_synced_at: SYNCED_AT },
        cards: [make_card("card-a1", DOC_A)],
      },
      {
        token: DOC_B,
        marker: { source_revision: 1, last_synced_at: SYNCED_AT },
        cards: [make_card("card-b1", DOC_B)],
      },
    ];
    seed_cache(docs);
    seed_index(docs);
    const frozen = freeze_cache_mtime();

    const result = expect_success(await run_refresh({ dry_run: false }));

    expect(result).toMatchObject({
      dry_run: false,
      degraded: true,
      refreshed_docs: [],
      removed_docs: [],
      unchanged_docs: [DOC_A, DOC_B],
      index_status: { state: "ready", card_count: 2 },
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.code).toBe("KB_B_UNREACHABLE");
    expect(result.warnings[0]?.message).toContain("知识库 B 不可达");
    expect(statSync(cache_file_path()).mtimeMs, "降级路径不写任何文件").toBe(frozen);
  });

  test("refresh degraded warning names the unreadable SyncState for KB_READ_FAILED", async () => {
    // SyncState 表配置指向不存在的表：read_sync_state 归一化为 KB_READ_FAILED，
    // 降级 warning 必须说「SyncState 读不到」，不能笼统声称知识库 B 不可达。
    write_config_file({ sync_state_table: "tbl_missing_state" });
    seed_cache([
      {
        token: DOC_A,
        marker: { source_revision: 1, last_synced_at: SYNCED_AT },
        cards: [make_card("card-a1", DOC_A)],
      },
    ]);

    const result = expect_success(await run_refresh({ dry_run: false }));

    expect(result).toMatchObject({
      dry_run: false,
      degraded: true,
      refreshed_docs: [],
      removed_docs: [],
      unchanged_docs: [DOC_A],
    });
    expect(result.warnings.map((warning) => warning.code)).toEqual(["KB_B_UNREACHABLE"]);
    const message = result.warnings[0]?.message ?? "";
    expect(message, "降级 warning 应指认 SyncState 读取失败").toContain("SyncState 读取失败");
    expect(
      message,
      "KB_READ_FAILED 不能笼统声称知识库 B 不可达",
    ).not.toContain("知识库 B 不可达，已按本地缓存继续");
  });

  test("refresh stops without cache when b unreachable", async () => {
    env = { ...env, FAKE_SCENARIO: "base-unreachable" };

    const result = await run_refresh({ dry_run: false });

    expect(result).toMatchObject({ ok: false, error: { code: "KB_B_UNREACHABLE" } });
    expect(existsSync(path.join(home, "cache"))).toBe(false);
    expect(existsSync(path.join(home, "index"))).toBe(false);

    // 损坏的缓存同样视为「没有可用缓存」。
    mkdirSync(path.dirname(cache_file_path()), { recursive: true });
    writeFileSync(cache_file_path(), "{ not json", "utf8");
    const again = await run_refresh({ dry_run: false });
    expect(again).toMatchObject({ ok: false, error: { code: "KB_B_UNREACHABLE" } });
    expect(existsSync(path.join(home, "index"))).toBe(false);
  });

  test("refresh rebuilds when cache file was corrupt", async () => {
    const state_a = make_state(DOC_A, {
      source_revision: 3,
      last_synced_at: SYNCED_AT_LATER,
      card_count: 2,
    });
    write_base_state({
      state: [state_row("rec_state_a", state_a)],
      cards: [
        card_row("rec_card_a1", make_card("card-a1", DOC_A, { source_revision: 3 })),
        card_row("rec_card_a2", make_card("card-a2", DOC_A, { source_revision: 3 })),
      ],
    });
    // 旧索引里还留着 B 中已删除的文档行，缓存损坏后必须整体重建。
    seed_index([
      {
        token: DOC_GONE,
        marker: { source_revision: 1, last_synced_at: SYNCED_AT },
        cards: [make_card("card-gone1", DOC_GONE)],
      },
    ]);
    mkdirSync(path.dirname(cache_file_path()), { recursive: true });
    writeFileSync(cache_file_path(), "{ this is not json", "utf8");

    const result = expect_success(await run_refresh({ dry_run: false }));

    expect(result).toMatchObject({
      dry_run: false,
      degraded: false,
      refreshed_docs: [{ source_doc_token: DOC_A, card_count: 2, reason: "added" }],
      // 旧索引里的 doc_state（DOC_GONE）也参与删除集，重建后不再出现。
      removed_docs: [DOC_GONE],
      unchanged_docs: [],
      index_status: { state: "ready", card_count: 2 },
    });
    expect(result.warnings.map((warning) => warning.code)).toContain("CACHE_CORRUPT");

    const cache = load_cache();
    expect(cache.rebuild_needed).toBeUndefined();
    expect(cache.docs[DOC_A]?.source_revision).toBe(3);
    expect(cache.docs[DOC_A]?.cards.map((card) => card.card_id)).toEqual(["card-a1", "card-a2"]);

    const indexed = read_index_rows();
    expect(indexed.markers).toEqual([
      { source_doc_token: DOC_A, source_revision: 3, last_synced_at: SYNCED_AT_LATER },
    ]);
    expect(indexed.cards.map((row) => row.card_id)).toEqual(["card-a1", "card-a2"]);
  });

  test("refresh rebuilds a corrupt index from the cache without refetching b cards", async () => {
    const state_a = make_state(DOC_A);
    const state_b = make_state(DOC_B);
    write_base_state({
      state: [state_row("rec_state_a", state_a), state_row("rec_state_b", state_b)],
      cards: [],
    });
    const docs: SeededDoc[] = [
      { token: DOC_A, marker: marker_of(state_a), cards: [make_card("card-a1", DOC_A)] },
      { token: DOC_B, marker: marker_of(state_b), cards: [make_card("card-b1", DOC_B)] },
    ];
    seed_cache(docs);
    mkdirSync(path.dirname(index_file_path()), { recursive: true });
    writeFileSync(index_file_path(), "definitely not sqlite", "utf8");
    expect(index_status(index_file_path()).state).toBe("corrupt");

    const result = expect_success(await run_refresh({ dry_run: false }));

    expect(result).toMatchObject({
      dry_run: false,
      degraded: false,
      refreshed_docs: [],
      removed_docs: [],
      unchanged_docs: [DOC_A, DOC_B],
      index_status: { state: "ready", card_count: 2 },
    });
    expect(cards_fetch_filters(), "未变化文档直接从缓存重建索引").toEqual([]);
    expect(read_index_rows().cards.map((row) => row.card_id)).toEqual(["card-a1", "card-b1"]);
  });

  test("refresh propagates a card fetch failure without writing", async () => {
    write_config_file({ cards_table: "tbl_missing_cards" });
    const state_a = make_state(DOC_A, {
      source_revision: 2,
      last_synced_at: SYNCED_AT_LATER,
    });
    write_base_state({ state: [state_row("rec_state_a", state_a)], cards: [] });
    const docs: SeededDoc[] = [
      {
        token: DOC_A,
        marker: { source_revision: 1, last_synced_at: SYNCED_AT },
        cards: [make_card("card-a-stale", DOC_A)],
      },
    ];
    seed_cache(docs);
    seed_index(docs);
    const frozen = freeze_cache_mtime();

    const result = await run_refresh({ dry_run: false });

    expect(result).toMatchObject({ ok: false, error: { code: "KB_READ_FAILED" } });
    expect(statSync(cache_file_path()).mtimeMs, "取卡失败时不写缓存").toBe(frozen);
    expect(load_cache().docs[DOC_A]?.source_revision).toBe(1);
    expect(read_index_rows().markers).toEqual([
      { source_doc_token: DOC_A, source_revision: 1, last_synced_at: SYNCED_AT },
    ]);
  });
});

/**
 * 分发回归（Task 3 简报新增要求）：工具必须通过 MCP 真的可达，
 * 且入参校验 fail-closed。这里启动真实 stdio Server（读取 server/dist/server.mjs），
 * 与 mcp_handshake / skills_contract 一样要求先构建。
 */
describe("refresh_local_index mcp dispatch", () => {
  test("tools/list exposes refresh_local_index with a closed input schema", async () => {
    const { client, errors } = await connect_mcp({ SCRIPT2SHOT_HOME: home });
    try {
      const result = await client.listTools();
      const tool = result.tools.find((entry) => entry.name === "refresh_local_index");
      expect(tool, "tools/list 应包含 refresh_local_index").toBeDefined();
      expect(tool?.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
        properties: { dry_run: { type: "boolean" } },
      });
      expect(errors.join(""), "server stderr should stay empty").toBe("");
    } finally {
      await client.close();
    }
  }, 30000);

  test("dispatching refresh_local_index rejects invalid arguments fail-closed", async () => {
    // 指向不存在的 CLI 与空的 home：若分发层没在参数校验阶段 fail-closed，
    // 返回的会是 CONFIG_MISSING / LARK_CLI_NOT_FOUND，而不是 CONFIG_INVALID。
    const { client, errors } = await connect_mcp({
      SCRIPT2SHOT_HOME: path.join(tempRoot, "empty-home"),
      LARK_CLI_PATH: path.join(tempRoot, "no-such-lark-cli"),
    });
    try {
      const unknown = parse_tool_json(
        await client.callTool({
          name: "refresh_local_index",
          arguments: { unexpected: true },
        }),
      );
      expect(unknown).toMatchObject({
        ok: false,
        error: { code: "CONFIG_INVALID", details: { field: "unexpected" } },
      });

      const bad_type = parse_tool_json(
        await client.callTool({
          name: "refresh_local_index",
          arguments: { dry_run: "yes" },
        }),
      );
      expect(bad_type).toMatchObject({
        ok: false,
        error: { code: "CONFIG_INVALID", details: { field: "dry_run" } },
      });
      expect(errors.join(""), "server stderr should stay empty").toBe("");
    } finally {
      await client.close();
    }
  }, 30000);
});

async function connect_mcp(
  overrides: Record<string, string>,
): Promise<{ client: Client; errors: string[] }> {
  const inherited_env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const command = IS_WINDOWS ? "cmd.exe" : "sh";
  const args = IS_WINDOWS ? ["/d", "/c", LAUNCHER] : [LAUNCHER];
  const transport = new StdioClientTransport({
    command,
    args,
    cwd: REPO_ROOT,
    env: { ...inherited_env, ...overrides },
    stderr: "pipe",
  });
  const errors: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => errors.push(chunk.toString("utf8")));
  const client = new Client({ name: "script2shot-refresh-dispatch-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, errors };
}

function parse_tool_json(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  const text = content?.find(
    (entry) => entry.type === "text" && typeof entry.text === "string",
  )?.text;
  if (text === undefined) {
    throw new Error(`tool result is missing text content: ${JSON.stringify(result)}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}
