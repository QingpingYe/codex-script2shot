import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { to_base_fields, type KnowledgeCard, type SyncState } from "../src/base_mapping.js";
import { BASE_BATCH_SIZE } from "../src/lark_base.js";
import {
  replace_doc_cards,
  type ReplaceDocCardsResult,
  type ReplaceDocCardsSuccess,
} from "../src/tools/replace_doc_cards.js";
import {
  update_doc_sync_state,
  type UpdateDocSyncStateResult,
} from "../src/tools/update_doc_sync_state.js";

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));
const IS_WINDOWS = process.platform === "win32";
const BASE_B = "base-token-b-123456789";
const CARDS_TABLE = "tbl_cards";
const STATE_TABLE = "tbl_state";
const DOC_TOKEN = "doccnFakeDoc1";
const OTHER_TOKEN = "doccnFakeOther";

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

interface FakeCall {
  scenario: string;
  args: string[];
  json?: unknown;
}

let tempRoot = "";
let home = "";
let cliPath = "";
let statePath = "";
let logPath = "";
let env: NodeJS.ProcessEnv;
let previousHome: string | undefined;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "script2shot-replace-"));
  home = path.join(tempRoot, "home");
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

function write_config_file(): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    path.join(home, "config.toml"),
    [
      "[lark]",
      'profile = "default"',
      'space_a = "space-a-1"',
      `base_b = "${BASE_B}"`,
      `knowledge_cards_table_id = "${CARDS_TABLE}"`,
      `sync_state_table_id = "${STATE_TABLE}"`,
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

function read_state(): FakeState {
  return JSON.parse(readFileSync(statePath, "utf8")) as FakeState;
}

function card_records(): FakeRecord[] {
  return read_state().records[CARDS_TABLE] ?? [];
}

function state_records(): FakeRecord[] {
  return read_state().records[STATE_TABLE] ?? [];
}

function read_calls(): FakeCall[] {
  if (!existsSync(logPath)) {
    return [];
  }
  return readFileSync(logPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as FakeCall);
}

function json_argument(args: string[]): string {
  const index = args.indexOf("--json");
  if (index < 0) {
    throw new Error(`调用缺少 --json：${args.join(" ")}`);
  }
  return args[index + 1] as string;
}

function card_row(record_id: string, card: KnowledgeCard): FakeRecord {
  return { record_id, fields: to_base_fields(card) };
}

function state_row(record_id: string, record: SyncState): FakeRecord {
  return { record_id, fields: to_base_fields(record) };
}

function make_card(
  card_id: string,
  source_doc_token: string,
  overrides: Partial<KnowledgeCard> = {},
): KnowledgeCard {
  return {
    card_id,
    scope: "general",
    project_id: null,
    category: "example",
    title: `标题 ${card_id}`,
    content: `${card_id} 的正文。`,
    tags: ["标签"],
    entities: [],
    target_models: ["seedance-2.0"],
    priority: 1,
    source_doc_token,
    source_node_token: "wikcnFakeNode1",
    source_path: "通用知识/示例文档",
    source_title: "示例文档",
    source_revision: 7,
    source_block_id: null,
    updated_at: "2026-10-21T10:00:00+08:00",
    ...overrides,
  };
}

function make_state(source_doc_token: string, overrides: Partial<SyncState> = {}): SyncState {
  return {
    source_doc_token,
    source_node_token: "wikcnFakeNode1",
    source_path: "通用知识/示例文档",
    source_title: "示例文档",
    scope: "general",
    project_id: null,
    obj_edit_time: "2026-10-21T10:00:00+08:00",
    source_revision: 7,
    card_count: 2,
    last_synced_at: "2026-10-21T10:00:00+08:00",
    last_sync_user: "测试用户",
    last_run_id: "run-20261021-100000",
    ...overrides,
  };
}

function expect_success(result: ReplaceDocCardsResult): ReplaceDocCardsSuccess {
  if ("ok" in result) {
    throw new Error(`expected success, got ${JSON.stringify(result)}`);
  }
  return result;
}

function expect_error(
  result: ReplaceDocCardsResult | UpdateDocSyncStateResult,
): Extract<ReplaceDocCardsResult | UpdateDocSyncStateResult, { ok: false }> {
  if (!("ok" in result)) {
    throw new Error(`expected error, got ${JSON.stringify(result)}`);
  }
  return result;
}

describe("replace_doc_cards", () => {
  test("replace records old ids before writing new cards", async () => {
    write_base_state({
      cards: [
        card_row("rec_old_1", make_card("src:doccnA:example:001", DOC_TOKEN)),
        card_row("rec_old_2", make_card("src:doccnA:example:002", DOC_TOKEN)),
      ],
    });
    const cards = [
      make_card("src:doccnA:example:101", DOC_TOKEN),
      make_card("src:doccnA:example:102", DOC_TOKEN),
    ];

    const result = expect_success(
      await replace_doc_cards({ source_doc_token: DOC_TOKEN, cards, dry_run: false, env }),
    );

    expect(result.dry_run).toBe(false);
    expect(result.created_record_ids).toEqual(["rec_fake_3", "rec_fake_4"]);
    expect(result.deleted_record_ids).toEqual(["rec_old_1", "rec_old_2"]);
    expect(result.planned).toEqual({
      mode: "replace",
      cards_to_create: 2,
      records_to_delete: ["rec_old_1", "rec_old_2"],
      records_to_update: [],
    });
    expect(result.warnings).toEqual([]);

    const calls = read_calls();
    expect(calls.map((call) => call.args[1])).toEqual([
      "+record-list",
      "+record-batch-create",
      "+record-delete",
    ]);
    const create_json = json_argument(calls[1].args);
    expect(create_json.startsWith("@"), "小 payload 保持 inline 以便断言 argv").toBe(false);
    expect(
      (JSON.parse(create_json) as { create_records: Array<{ card_id: string }> }).create_records.map(
        (fields) => fields.card_id,
      ),
    ).toEqual(["src:doccnA:example:101", "src:doccnA:example:102"]);
    expect(calls[2].args).toContain("--yes");
    expect(calls[2].args).not.toContain("--dry-run");
    expect(JSON.parse(json_argument(calls[2].args))).toEqual({
      record_id_list: ["rec_old_1", "rec_old_2"],
    });
  });

  test("replace deletes only the recorded old ids", async () => {
    write_base_state({
      cards: [
        card_row("rec_a1", make_card("src:doccnA:example:001", DOC_TOKEN)),
        card_row("rec_a2", make_card("src:doccnA:example:002", DOC_TOKEN)),
        card_row("rec_b1", make_card("src:doccnOther:example:001", OTHER_TOKEN)),
      ],
    });
    const cards = [make_card("src:doccnA:example:101", DOC_TOKEN)];

    const result = expect_success(
      await replace_doc_cards({ source_doc_token: DOC_TOKEN, cards, dry_run: false, env }),
    );

    expect(result.deleted_record_ids).toEqual(["rec_a1", "rec_a2"]);
    const delete_call = read_calls().find((call) => call.args[1] === "+record-delete");
    expect(JSON.parse(json_argument(delete_call?.args ?? []))).toEqual({
      record_id_list: ["rec_a1", "rec_a2"],
    });

    const doc_rows = card_records().filter((row) => row.fields.source_doc_token === DOC_TOKEN);
    expect(doc_rows.map((row) => row.fields.card_id)).toEqual(["src:doccnA:example:101"]);
    const other_rows = card_records().filter(
      (row) => row.fields.source_doc_token === OTHER_TOKEN,
    );
    expect(other_rows.map((row) => row.record_id)).toEqual(["rec_b1"]);
  });

  test("replace is idempotent across two runs", async () => {
    const cards = [
      make_card("src:doccnA:example:001", DOC_TOKEN),
      make_card("src:doccnA:example:002", DOC_TOKEN),
      make_card("src:doccnA:example:003", DOC_TOKEN),
    ];

    const first = expect_success(
      await replace_doc_cards({ source_doc_token: DOC_TOKEN, cards, dry_run: false, env }),
    );
    const second = expect_success(
      await replace_doc_cards({ source_doc_token: DOC_TOKEN, cards, dry_run: false, env }),
    );

    expect(second.deleted_record_ids).toEqual(first.created_record_ids);
    expect(card_records()).toHaveLength(cards.length);
    const card_ids = card_records().map((row) => row.fields.card_id);
    expect(card_ids).toHaveLength(cards.length);
    expect(new Set(card_ids).size).toBe(cards.length);
    expect(new Set(card_ids)).toEqual(new Set(cards.map((card) => card.card_id)));
  });

  test("replace rejects duplicate card ids in input", async () => {
    const cards = [
      make_card("src:doccnA:example:001", DOC_TOKEN),
      make_card("src:doccnA:example:001", DOC_TOKEN, { title: "重复的卡片" }),
    ];

    const result = expect_error(
      await replace_doc_cards({ source_doc_token: DOC_TOKEN, cards, dry_run: false, env }),
    );

    expect(result.error.code).toBe("SCHEMA_INVALID");
    expect(result.error.details).toMatchObject({
      card_id: "src:doccnA:example:001",
      first_index: 0,
      duplicate_index: 1,
    });
    expect(read_calls()).toEqual([]);
    expect(card_records()).toEqual([]);
  });

  test("replace batches writes at 200 records", async () => {
    env.FAKE_LOG_JSON = "1";
    const cards = Array.from({ length: BASE_BATCH_SIZE + 1 }, (_value, index) =>
      make_card(`src:doccnA:example:${String(index + 1).padStart(3, "0")}`, DOC_TOKEN),
    );

    const result = expect_success(
      await replace_doc_cards({ source_doc_token: DOC_TOKEN, cards, dry_run: false, env }),
    );

    expect(result.created_record_ids).toHaveLength(BASE_BATCH_SIZE + 1);
    const create_calls = read_calls().filter(
      (call) => call.args[1] === "+record-batch-create",
    );
    expect(create_calls).toHaveLength(2);
    // 阈值按每批序列化后的 JSON 判定：200 条的大批走 @file，1 条的小批保持 inline。
    const first_json = json_argument(create_calls[0].args);
    expect(first_json.startsWith("@")).toBe(true);
    expect(existsSync(first_json.slice(1)), "临时文件必须用完即删").toBe(false);
    expect(json_argument(create_calls[1].args).startsWith("@")).toBe(false);
    const first_payload = create_calls[0].json as { create_records: unknown[] };
    const second_payload = create_calls[1].json as { create_records: unknown[] };
    expect(first_payload.create_records).toHaveLength(BASE_BATCH_SIZE);
    expect(second_payload.create_records).toHaveLength(1);
    expect(read_calls().some((call) => call.args[1] === "+record-delete")).toBe(false);
    expect(card_records()).toHaveLength(BASE_BATCH_SIZE + 1);
  });

  test("replace failure keeps old cards and allows retry", async () => {
    const state = make_state(DOC_TOKEN);
    write_base_state({
      cards: [
        card_row("rec_old_1", make_card("src:doccnA:example:001", DOC_TOKEN)),
        card_row("rec_old_2", make_card("src:doccnA:example:002", DOC_TOKEN)),
      ],
      state: [state_row("rec_state_1", state)],
    });
    const cards = [
      make_card("src:doccnA:example:101", DOC_TOKEN),
      make_card("src:doccnA:example:102", DOC_TOKEN),
    ];

    env.FAKE_SCENARIO = "delete-failed";
    const failed = expect_error(
      await replace_doc_cards({ source_doc_token: DOC_TOKEN, cards, dry_run: false, env }),
    );

    expect(failed.error.code).toBe("KB_WRITE_FAILED");
    expect(failed.error.details).toMatchObject({
      stage: "delete",
      created_count: 2,
      deleted_count: 0,
    });
    expect(failed.error.message).toContain("删除");
    expect(card_records().map((row) => row.record_id)).toEqual([
      "rec_old_1",
      "rec_old_2",
      "rec_fake_3",
      "rec_fake_4",
    ]);
    expect(state_records()[0].fields).toEqual(to_base_fields(state));

    env.FAKE_SCENARIO = "ok";
    const retried = expect_success(
      await replace_doc_cards({ source_doc_token: DOC_TOKEN, cards, dry_run: false, env }),
    );

    expect(retried.deleted_record_ids).toEqual([
      "rec_old_1",
      "rec_old_2",
      "rec_fake_3",
      "rec_fake_4",
    ]);
    const converged = card_records().filter(
      (row) => row.fields.source_doc_token === DOC_TOKEN,
    );
    expect(converged).toHaveLength(cards.length);
    expect(new Set(converged.map((row) => row.fields.card_id))).toEqual(
      new Set(cards.map((card) => card.card_id)),
    );
  });

  test("metadata patch updates all doc cards without new cards", async () => {
    const other = make_card("src:doccnOther:example:001", OTHER_TOKEN);
    write_base_state({
      cards: [
        card_row("rec_a1", make_card("src:doccnA:example:001", DOC_TOKEN)),
        card_row("rec_a2", make_card("src:doccnA:example:002", DOC_TOKEN)),
        card_row("rec_a3", make_card("src:doccnA:example:003", DOC_TOKEN)),
        card_row("rec_b1", other),
      ],
    });

    const result = expect_success(
      await replace_doc_cards({
        source_doc_token: DOC_TOKEN,
        metadata_patch: {
          source_path: "《五夫临门》/新路径",
          source_title: "新标题",
          scope: "project",
          project_id: "wufu",
        },
        dry_run: false,
        env,
      }),
    );

    expect(result.created_record_ids).toEqual([]);
    expect(result.deleted_record_ids).toEqual([]);
    expect(result.planned).toEqual({
      mode: "metadata_patch",
      cards_to_create: 0,
      records_to_delete: [],
      records_to_update: ["rec_a1", "rec_a2", "rec_a3"],
    });

    const calls = read_calls();
    expect(calls.map((call) => call.args[1])).toEqual(["+record-list", "+record-batch-update"]);
    const payload = JSON.parse(json_argument(calls[1].args)) as {
      update_records: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(payload.update_records)).toEqual(["rec_a1", "rec_a2", "rec_a3"]);
    expect(payload.update_records.rec_a1).toEqual({
      source_path: "《五夫临门》/新路径",
      source_title: "新标题",
      scope: "project",
      project_id: "wufu",
    });

    const patched_rows = card_records().filter(
      (row) => row.fields.source_doc_token === DOC_TOKEN,
    );
    expect(patched_rows).toHaveLength(3);
    for (const row of patched_rows) {
      expect(row.fields).toMatchObject({
        source_path: "《五夫临门》/新路径",
        source_title: "新标题",
        scope: "project",
        project_id: "wufu",
      });
    }
    expect(card_records()).toHaveLength(4);
    expect(card_records().find((row) => row.record_id === "rec_b1")?.fields).toEqual(
      to_base_fields(other),
    );
  });

  test("replace dry run previews old ids without writing", async () => {
    write_base_state({
      cards: [
        card_row("rec_old_1", make_card("src:doccnA:example:001", DOC_TOKEN)),
        card_row("rec_old_2", make_card("src:doccnA:example:002", DOC_TOKEN)),
      ],
    });
    const cards = [
      make_card("src:doccnA:example:101", DOC_TOKEN),
      make_card("src:doccnA:example:102", DOC_TOKEN),
    ];

    const result = expect_success(
      await replace_doc_cards({ source_doc_token: DOC_TOKEN, cards, env }),
    );

    expect(result).toEqual({
      dry_run: true,
      planned: {
        mode: "replace",
        cards_to_create: 2,
        records_to_delete: ["rec_old_1", "rec_old_2"],
        records_to_update: [],
      },
      created_record_ids: [],
      deleted_record_ids: [],
      warnings: [],
    });
    expect(read_calls().map((call) => call.args[1])).toEqual(["+record-list"]);
    expect(card_records().map((row) => row.record_id)).toEqual(["rec_old_1", "rec_old_2"]);
  });

  test("replace write failure skips deletion and keeps old cards", async () => {
    write_base_state({
      cards: [
        card_row("rec_old_1", make_card("src:doccnA:example:001", DOC_TOKEN)),
        card_row("rec_old_2", make_card("src:doccnA:example:002", DOC_TOKEN)),
      ],
    });
    env.FAKE_SCENARIO = "create-failed";

    const failed = expect_error(
      await replace_doc_cards({
        source_doc_token: DOC_TOKEN,
        cards: [make_card("src:doccnA:example:101", DOC_TOKEN)],
        dry_run: false,
        env,
      }),
    );

    expect(failed.error.code).toBe("KB_WRITE_FAILED");
    expect(failed.error.details).toMatchObject({
      stage: "create",
      created_count: 0,
      deleted_count: 0,
    });
    expect(read_calls().some((call) => call.args[1] === "+record-delete")).toBe(false);
    expect(card_records().map((row) => row.record_id)).toEqual(["rec_old_1", "rec_old_2"]);
  });
});

describe("update_doc_sync_state", () => {
  test("update state upserts by source doc token", async () => {
    const record = make_state(DOC_TOKEN);

    const created = await update_doc_sync_state({ record, env });
    expect(created).toEqual({ record_id: "rec_fake_1", action: "created" });
    expect(state_records()).toHaveLength(1);
    expect(state_records()[0].fields).toEqual(to_base_fields(record));

    const changed = make_state(DOC_TOKEN, {
      card_count: 5,
      source_title: "改名后的标题",
      last_synced_at: "2026-10-21T11:00:00+08:00",
      last_run_id: "run-20261021-110000",
    });
    const updated = await update_doc_sync_state({ record: changed, env });

    expect(updated).toEqual({ record_id: "rec_fake_1", action: "updated" });
    expect(state_records()).toHaveLength(1);
    expect(state_records()[0].fields).toEqual(to_base_fields(changed));
    expect(read_calls().map((call) => call.args[1])).toEqual([
      "+record-list",
      "+record-batch-create",
      "+record-list",
      "+record-batch-update",
    ]);
  });

  test("update state not called when replace failed", async () => {
    const state = make_state(DOC_TOKEN);
    write_base_state({
      cards: [card_row("rec_old_1", make_card("src:doccnA:example:001", DOC_TOKEN))],
      state: [state_row("rec_state_1", state)],
    });
    env.FAKE_SCENARIO = "delete-failed";

    const failed = expect_error(
      await replace_doc_cards({
        source_doc_token: DOC_TOKEN,
        cards: [make_card("src:doccnA:example:101", DOC_TOKEN)],
        dry_run: false,
        env,
      }),
    );
    expect(failed.error.code).toBe("KB_WRITE_FAILED");

    // Skill 编排：replace 失败后不得调用 update_doc_sync_state。
    const state_calls_after_failure = read_calls().filter((call) =>
      call.args.includes(STATE_TABLE),
    );
    expect(state_calls_after_failure).toEqual([]);
    expect(state_records()[0].fields).toEqual(to_base_fields(state));

    // 反证：成功路径调用 update_doc_sync_state 时确实会出现 SyncState 写入调用。
    env.FAKE_SCENARIO = "ok";
    const updated = await update_doc_sync_state({
      record: make_state(DOC_TOKEN, { source_revision: 8 }),
      env,
    });
    expect(updated).toEqual({ record_id: "rec_state_1", action: "updated" });
    const state_calls_after_update = read_calls().filter((call) =>
      call.args.includes(STATE_TABLE),
    );
    expect(state_calls_after_update.map((call) => call.args[1])).toEqual([
      "+record-list",
      "+record-batch-update",
    ]);
  });

  test("update state ignores a readback record id", async () => {
    // read_sync_state 的回读记录带 record_id；upsert 只认 source_doc_token。
    const record = { ...make_state(DOC_TOKEN), record_id: "rec_from_readback" };

    const result = await update_doc_sync_state({ record, env });

    expect(result).toEqual({ record_id: "rec_fake_1", action: "created" });
    expect(state_records()).toHaveLength(1);
    expect(state_records()[0].record_id).toBe("rec_fake_1");
  });
});
