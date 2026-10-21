import {
  chmodSync,
  cpSync,
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
import {
  BASE_BATCH_SIZE,
  batch_create_records,
  batch_update_records,
  create_table,
  delete_records,
  list_fields,
  list_records,
  list_tables,
  type LarkBaseContext,
} from "../src/lark_base.js";

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));
const IS_WINDOWS = process.platform === "win32";
const BASE_B = "base-token-b-123456789";

interface FakeField {
  id?: string;
  name: string;
  type: string;
}

interface FakeRecord {
  record_id: string;
  fields: Record<string, unknown>;
}

interface FakeState {
  tables: Array<{ id: string; name: string; fields: FakeField[] }>;
  records: Record<string, FakeRecord[]>;
}

let tempRoot = "";
let cliPath = "";
let statePath = "";
let logPath = "";
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "script2shot-lark-base-"));
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
});

afterEach(() => {
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

function context(overrides: Partial<LarkBaseContext> = {}): LarkBaseContext {
  return { cli_path: cliPath, base_token: BASE_B, env, ...overrides };
}

function with_field_ids(fields: Array<{ name: string; type: string }>): FakeField[] {
  return fields.map((field, index) => ({ id: `fld_${index + 1}`, ...field }));
}

function write_state(state: FakeState): void {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function read_state(): FakeState {
  return JSON.parse(readFileSync(statePath, "utf8")) as FakeState;
}

function read_calls(): Array<{ scenario: string; args: string[] }> {
  return readFileSync(logPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as { scenario: string; args: string[] });
}

function expect_ok<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (result.ok !== true) {
    throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  }
  return result as Extract<T, { ok: true }>;
}

describe("lark_base", () => {
  test("list tables reads names and ids from the table list payload", async () => {
    write_state({
      tables: [{ id: "tbl_cards", name: "KnowledgeCards", fields: [] }],
      records: {},
    });

    const result = expect_ok(await list_tables(context()));

    expect(result.tables).toEqual([{ id: "tbl_cards", name: "KnowledgeCards" }]);
    expect(read_calls().map((call) => call.args)).toEqual([
      ["base", "+table-list", "--base-token", BASE_B],
    ]);
  });

  test("create table sends field schema and parses data table id", async () => {
    write_state({ tables: [], records: {} });
    const fields = [
      { name: "card_id", type: "text" },
      { name: "priority", type: "number" },
    ];

    const result = expect_ok(await create_table(context(), "KnowledgeCards", fields));

    expect(result.table_id).toBe("tbl_fake_1");
    expect(read_calls().map((call) => call.args)).toEqual([
      [
        "base",
        "+table-create",
        "--base-token",
        BASE_B,
        "--name",
        "KnowledgeCards",
        "--fields",
        JSON.stringify(fields),
      ],
    ]);
    const state = read_state();
    expect(state.tables).toHaveLength(1);
    expect(state.tables[0].fields.map((field) => field.name)).toEqual(["card_id", "priority"]);
    expect(state.tables[0].fields.map((field) => field.type)).toEqual(["text", "number"]);
  });

  test("create table falls back to flat id keys", async () => {
    write_state({ tables: [], records: {} });
    const fields = [{ name: "card_id", type: "text" }];

    env.FAKE_TABLE_CREATE_ID_KEY = "table_id";
    const flat_table_id = expect_ok(await create_table(context(), "KnowledgeCards", fields));
    expect(flat_table_id.table_id).toBe("tbl_fake_1");

    env.FAKE_TABLE_CREATE_ID_KEY = "id";
    const flat_id = expect_ok(await create_table(context(), "SyncState", fields));
    expect(flat_id.table_id).toBe("tbl_fake_2");
  });

  test("list fields reads names and types", async () => {
    write_state({
      tables: [
        {
          id: "tbl_cards",
          name: "KnowledgeCards",
          fields: with_field_ids([
            { name: "card_id", type: "text" },
            { name: "priority", type: "number" },
          ]),
        },
      ],
      records: {},
    });

    const result = expect_ok(await list_fields(context(), "tbl_cards"));

    expect(result.fields).toEqual([
      { id: "fld_1", name: "card_id", type: "text" },
      { id: "fld_2", name: "priority", type: "number" },
    ]);
    expect(read_calls().map((call) => call.args)).toEqual([
      ["base", "+field-list", "--base-token", BASE_B, "--table-id", "tbl_cards"],
    ]);
  });

  test("list records flattens the matrix payload into records with record ids", async () => {
    write_state({
      tables: [
        {
          id: "tbl_cards",
          name: "KnowledgeCards",
          fields: with_field_ids([
            { name: "card_id", type: "text" },
            { name: "priority", type: "number" },
            { name: "updated_at", type: "datetime" },
          ]),
        },
      ],
      records: {
        tbl_cards: [
          { record_id: "rec_1", fields: { card_id: "c1", priority: 3 } },
          { record_id: "rec_2", fields: { card_id: "c2", updated_at: "2026-01-02 03:04" } },
        ],
      },
    });

    const result = expect_ok(await list_records(context(), "tbl_cards"));

    expect(result.records).toEqual([
      {
        record_id: "rec_1",
        fields: { card_id: "c1", priority: 3, updated_at: null },
      },
      {
        record_id: "rec_2",
        fields: { card_id: "c2", priority: null, updated_at: "2026-01-02 03:04" },
      },
    ]);
    expect(read_calls().map((call) => call.args)).toEqual([
      [
        "base",
        "+record-list",
        "--base-token",
        BASE_B,
        "--table-id",
        "tbl_cards",
        "--offset",
        "0",
        "--limit",
        "200",
        "--format",
        "json",
      ],
    ]);
  });

  // 假 CLI 默认不再返回 data.next_offset（与真实 payload 一致），因此本用例走的是
  // offset + 本页行数的兜底分支：0 → 2。
  test("list records pages until has_more is false", async () => {
    write_state({
      tables: [
        {
          id: "tbl_cards",
          name: "KnowledgeCards",
          fields: with_field_ids([{ name: "card_id", type: "text" }]),
        },
      ],
      records: {
        tbl_cards: [
          { record_id: "rec_1", fields: { card_id: "c1" } },
          { record_id: "rec_2", fields: { card_id: "c2" } },
          { record_id: "rec_3", fields: { card_id: "c3" } },
        ],
      },
    });

    const result = expect_ok(await list_records(context(), "tbl_cards", { page_size: 2 }));

    expect(result.records.map((record) => record.record_id)).toEqual(["rec_1", "rec_2", "rec_3"]);
    expect(read_calls().map((call) => call.args)).toEqual([
      [
        "base",
        "+record-list",
        "--base-token",
        BASE_B,
        "--table-id",
        "tbl_cards",
        "--offset",
        "0",
        "--limit",
        "2",
        "--format",
        "json",
      ],
      [
        "base",
        "+record-list",
        "--base-token",
        BASE_B,
        "--table-id",
        "tbl_cards",
        "--offset",
        "2",
        "--limit",
        "2",
        "--format",
        "json",
      ],
    ]);
  });

  // 显式 next_offset 分支：假 CLI 故意报告一个只有跟随 data.next_offset 才会出现的
  // 偏移（0 → 3），用它证明适配层优先使用服务端给出的令牌。
  test("list records follows the explicit next offset when the payload provides one", async () => {
    write_state({
      tables: [
        {
          id: "tbl_cards",
          name: "KnowledgeCards",
          fields: with_field_ids([{ name: "card_id", type: "text" }]),
        },
      ],
      records: {
        tbl_cards: [
          { record_id: "rec_1", fields: { card_id: "c1" } },
          { record_id: "rec_2", fields: { card_id: "c2" } },
          { record_id: "rec_3", fields: { card_id: "c3" } },
          { record_id: "rec_4", fields: { card_id: "c4" } },
        ],
      },
    });
    env.FAKE_RECORD_LIST_FIRST_NEXT_OFFSET = "3";

    const result = expect_ok(await list_records(context(), "tbl_cards", { page_size: 2 }));

    expect(result.records.map((record) => record.record_id)).toEqual(["rec_1", "rec_2", "rec_4"]);
    const offsets = read_calls().map((call) => {
      const index = call.args.indexOf("--offset");
      return call.args[index + 1];
    });
    expect(offsets).toEqual(["0", "3"]);
  });

  test("list records passes filter projection and page size", async () => {
    write_state({
      tables: [
        {
          id: "tbl_cards",
          name: "KnowledgeCards",
          fields: with_field_ids([
            { name: "card_id", type: "text" },
            { name: "priority", type: "number" },
          ]),
        },
      ],
      records: {
        tbl_cards: [
          { record_id: "rec_1", fields: { card_id: "c1", priority: 1 } },
          { record_id: "rec_2", fields: { card_id: "c2", priority: 2 } },
        ],
      },
    });
    const filter = { logic: "and", conditions: [["card_id", "==", "c2"]] };

    const result = expect_ok(
      await list_records(context(), "tbl_cards", {
        filter,
        fields: ["card_id"],
        page_size: 1,
      }),
    );

    expect(result.records).toEqual([{ record_id: "rec_2", fields: { card_id: "c2" } }]);
    expect(read_calls().map((call) => call.args)).toEqual([
      [
        "base",
        "+record-list",
        "--base-token",
        BASE_B,
        "--table-id",
        "tbl_cards",
        "--field-id",
        "card_id",
        "--filter-json",
        JSON.stringify(filter),
        "--offset",
        "0",
        "--limit",
        "1",
        "--format",
        "json",
      ],
    ]);
  });

  test("batch create chunks at 200 records and returns record ids", async () => {
    write_state({
      tables: [
        {
          id: "tbl_cards",
          name: "KnowledgeCards",
          fields: with_field_ids([{ name: "card_id", type: "text" }]),
        },
      ],
      records: {},
    });
    const records = Array.from({ length: BASE_BATCH_SIZE + 1 }, (_value, index) => ({
      card_id: `c${index + 1}`,
    }));

    const result = expect_ok(await batch_create_records(context(), "tbl_cards", records));

    expect(result.record_ids).toHaveLength(BASE_BATCH_SIZE + 1);
    const calls = read_calls();
    expect(calls).toHaveLength(2);
    const first_payload = JSON.parse(calls[0].args[7]) as {
      create_records: Array<Record<string, unknown>>;
    };
    const second_payload = JSON.parse(calls[1].args[7]) as {
      create_records: Array<Record<string, unknown>>;
    };
    expect(first_payload.create_records).toHaveLength(BASE_BATCH_SIZE);
    expect(second_payload.create_records).toHaveLength(1);
    expect(first_payload.create_records[0]).toEqual({ card_id: "c1" });
    expect(read_state().records.tbl_cards).toHaveLength(BASE_BATCH_SIZE + 1);
  });

  test("batch update sends record id to field map and chunks at 200", async () => {
    write_state({
      tables: [
        {
          id: "tbl_cards",
          name: "KnowledgeCards",
          fields: with_field_ids([{ name: "card_id", type: "text" }]),
        },
      ],
      records: {
        // 假 CLI 在 Windows 上经 cmd.exe 包装，200 条更新的 argv 必须保持短小；
        // 这里验证的是分批数量与 record_id -> 字段映射，不是真实记录的字段宽度。
        tbl_cards: Array.from({ length: BASE_BATCH_SIZE + 1 }, (_value, index) => ({
          record_id: `r${index + 1}`,
          fields: { card_id: `old-${index + 1}` },
        })),
      },
    });
    const updates = Array.from({ length: BASE_BATCH_SIZE + 1 }, (_value, index) => ({
      record_id: `r${index + 1}`,
      fields: { n: index + 1 },
    }));

    const result = expect_ok(await batch_update_records(context(), "tbl_cards", updates));

    expect(result).toEqual({ ok: true });
    const calls = read_calls();
    expect(calls).toHaveLength(2);
    const first_payload = JSON.parse(calls[0].args[7]) as {
      update_records: Record<string, Record<string, unknown>>;
    };
    const second_payload = JSON.parse(calls[1].args[7]) as {
      update_records: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(first_payload.update_records)).toHaveLength(BASE_BATCH_SIZE);
    expect(first_payload.update_records.r1).toEqual({ n: 1 });
    expect(Object.keys(second_payload.update_records)).toEqual([`r${BASE_BATCH_SIZE + 1}`]);
    expect(read_state().records.tbl_cards[0].fields.n).toBe(1);
    expect(read_state().records.tbl_cards[BASE_BATCH_SIZE].fields.n).toBe(BASE_BATCH_SIZE + 1);
  });

  test("delete preview omits --yes and execution passes it", async () => {
    write_state({
      tables: [
        {
          id: "tbl_cards",
          name: "KnowledgeCards",
          fields: with_field_ids([{ name: "card_id", type: "text" }]),
        },
      ],
      records: {
        tbl_cards: [
          { record_id: "rec_1", fields: { card_id: "c1" } },
          { record_id: "rec_2", fields: { card_id: "c2" } },
        ],
      },
    });

    const preview = expect_ok(await delete_records(context(), "tbl_cards", ["rec_1"]));

    expect(preview.dry_run).toBe(true);
    expect(read_state().records.tbl_cards).toHaveLength(2);
    expect(read_calls().map((call) => call.args)).toEqual([
      [
        "base",
        "+record-delete",
        "--base-token",
        BASE_B,
        "--table-id",
        "tbl_cards",
        "--json",
        JSON.stringify({ record_id_list: ["rec_1"] }),
        "--dry-run",
      ],
    ]);

    const executed = expect_ok(
      await delete_records(context(), "tbl_cards", ["rec_1"], { dry_run: false }),
    );

    expect(executed.dry_run).toBe(false);
    expect(read_state().records.tbl_cards.map((record) => record.record_id)).toEqual(["rec_2"]);
    const calls = read_calls().map((call) => call.args);
    expect(calls[1]).toEqual([
      "base",
      "+record-delete",
      "--base-token",
      BASE_B,
      "--table-id",
      "tbl_cards",
      "--json",
      JSON.stringify({ record_id_list: ["rec_1"] }),
      "--yes",
    ]);
    for (const args of calls) {
      expect(args.includes("--yes") && args.includes("--dry-run")).toBe(false);
    }
  });

  test("write failures map to KB_WRITE_FAILED without leaking the base token", async () => {
    write_state({ tables: [], records: {} });
    env.FAKE_SCENARIO = "base-unreachable";

    const write_result = await batch_create_records(context(), "tbl_cards", [{ card_id: "c1" }]);
    expect(write_result.ok).toBe(false);
    if (!write_result.ok) {
      expect(write_result.error.code).toBe("KB_WRITE_FAILED");
      expect(JSON.stringify(write_result)).not.toContain(BASE_B);
    }

    const read_result = await list_tables(context());
    expect(read_result.ok).toBe(false);
    if (!read_result.ok) {
      expect(read_result.error.code).toBe("KB_READ_FAILED");
      expect(JSON.stringify(read_result)).not.toContain(BASE_B);
    }
  });

  test("create table reports INTERNAL when the response has no table id", async () => {
    write_state({ tables: [], records: {} });
    env.FAKE_SCENARIO = "table-create-no-id";

    const result = await create_table(context(), "KnowledgeCards", [
      { name: "card_id", type: "text" },
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
      expect(result.error.message).toContain("table");
    }
  });
});
