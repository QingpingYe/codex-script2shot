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
import {
  BASE_BATCH_SIZE,
  JSON_ARG_ESCAPED_LINE_BUDGET,
  batch_create_records,
  batch_update_records,
  create_table,
  delete_records,
  list_fields,
  list_records,
  list_tables,
  type LarkBaseContext,
} from "../src/lark_base.js";
import { escaped_command_line_length } from "../src/lark_cli.js";

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

function json_argument(args: string[]): string {
  const index = args.indexOf("--json");
  if (index < 0) {
    throw new Error(`调用缺少 --json：${args.join(" ")}`);
  }
  return args[index + 1] as string;
}

const CREATE_ARGS_PREFIX = [
  "base",
  "+record-batch-create",
  "--base-token",
  BASE_B,
  "--table-id",
  "tbl_cards",
];

/** 密集小记录（引号/逗号多，2 层转义后放大明显），用于标定转义长度的预算边界。 */
function dense_records(count: number): Array<{ card_id: string; content: string }> {
  return Array.from({ length: count }, (_value, index) => ({
    card_id: `c${index + 1}`,
    content: `shot-${index + 1}`,
  }));
}

function measure_create_records(count: number): {
  records: Array<{ card_id: string; content: string }>;
  json: string;
  escaped_length: number;
} {
  const records = dense_records(count);
  const json = JSON.stringify({ create_records: records });
  return {
    records,
    json,
    escaped_length: escaped_command_line_length(cliPath, [...CREATE_ARGS_PREFIX, "--json", json]),
  };
}

/** 二分找到「转义后长度不超过 target」的最大记录数（长度随记录数单调递增）。 */
function create_records_fitting_budget(target: number): ReturnType<typeof measure_create_records> {
  let low = 1;
  let high = 400;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measure_create_records(mid).escaped_length <= target) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return measure_create_records(low);
}

/** 递增记录数直到原始 JSON 长度达到 target。 */
function create_records_with_raw_length(
  target: number,
): ReturnType<typeof measure_create_records> {
  let count = 1;
  for (;;) {
    const measured = measure_create_records(count);
    if (measured.json.length >= target || count >= 400) {
      return measured;
    }
    count += 1;
  }
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
    env.FAKE_LOG_JSON = "1";
    const records = Array.from({ length: BASE_BATCH_SIZE + 1 }, (_value, index) => ({
      card_id: `c${index + 1}`,
    }));

    const result = expect_ok(await batch_create_records(context(), "tbl_cards", records));

    expect(result.record_ids).toHaveLength(BASE_BATCH_SIZE + 1);
    const calls = read_calls();
    expect(calls).toHaveLength(2);
    // 200 条密集记录的 inline 候选转义后已超预算 ⇒ 第一批走 @file（子进程读到文件后，
    // 假 CLI 把解析结果记进 payload 日志）；第二批只有 1 条 ⇒ 保持 inline。
    const inline_candidate = JSON.stringify({
      create_records: records.slice(0, BASE_BATCH_SIZE),
    });
    expect(
      escaped_command_line_length(cliPath, [...CREATE_ARGS_PREFIX, "--json", inline_candidate]),
    ).toBeGreaterThan(JSON_ARG_ESCAPED_LINE_BUDGET);
    const first_json = json_argument(calls[0].args);
    expect(first_json.startsWith("@")).toBe(true);
    expect(existsSync(first_json.slice(1)), "临时文件必须用完即删").toBe(false);
    const first_payload = (calls[0] as { json?: unknown }).json as {
      create_records: Array<Record<string, unknown>>;
    };
    const second_payload = JSON.parse(json_argument(calls[1].args)) as {
      create_records: Array<Record<string, unknown>>;
    };
    expect(json_argument(calls[1].args).startsWith("@")).toBe(false);
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
        // 这里验证的是分批数量与 record_id -> 字段映射；payload 的实际传输通道
        // （inline / @file）由下面的转义长度与 argv 断言锁定。
        tbl_cards: Array.from({ length: BASE_BATCH_SIZE + 1 }, (_value, index) => ({
          record_id: `r${index + 1}`,
          fields: { card_id: `old-${index + 1}` },
        })),
      },
    });
    env.FAKE_LOG_JSON = "1";
    const updates = Array.from({ length: BASE_BATCH_SIZE + 1 }, (_value, index) => ({
      record_id: `r${index + 1}`,
      fields: { n: index + 1 },
    }));

    const result = expect_ok(await batch_update_records(context(), "tbl_cards", updates));

    expect(result).toEqual({ ok: true });
    const calls = read_calls();
    expect(calls).toHaveLength(2);
    const inline_candidate = JSON.stringify({
      update_records: Object.fromEntries(
        updates.slice(0, BASE_BATCH_SIZE).map((update) => [update.record_id, update.fields]),
      ),
    });
    expect(
      escaped_command_line_length(cliPath, [
        "base",
        "+record-batch-update",
        "--base-token",
        BASE_B,
        "--table-id",
        "tbl_cards",
        "--json",
        inline_candidate,
      ]),
    ).toBeGreaterThan(JSON_ARG_ESCAPED_LINE_BUDGET);
    expect(json_argument(calls[0].args).startsWith("@")).toBe(true);
    const first_payload = (calls[0] as { json?: unknown }).json as {
      update_records: Record<string, Record<string, unknown>>;
    };
    const second_payload = (calls[1] as { json?: unknown }).json as {
      update_records: Record<string, Record<string, unknown>>;
    };
    expect(json_argument(calls[1].args).startsWith("@")).toBe(false);
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

  // Task 2 结转 Minor：inline `--json` 会顶到 Windows cmd.exe 行长上限（约 8,191
  // 字符，经 2 层转义后放大），超预算的 payload 必须走临时文件 + `--json "@<path>"`，
  // 并且用完立即删除。预算口径见 JSON_ARG_ESCAPED_LINE_BUDGET。
  test("batch create passes large payloads through a temporary json file and removes it", async () => {
    write_state({
      tables: [
        {
          id: "tbl_cards",
          name: "KnowledgeCards",
          fields: with_field_ids([
            { name: "card_id", type: "text" },
            { name: "content", type: "text" },
          ]),
        },
      ],
      records: {},
    });
    env.FAKE_LOG_JSON = "1";
    const records = Array.from({ length: 120 }, (_value, index) => ({
      card_id: `c${index + 1}`,
      content: "x".repeat(300),
    }));

    const result = expect_ok(await batch_create_records(context(), "tbl_cards", records));

    expect(result.record_ids).toHaveLength(records.length);
    const calls = read_calls();
    expect(calls).toHaveLength(1);
    const json_value = json_argument(calls[0].args);
    expect(json_value.startsWith("@")).toBe(true);
    expect(existsSync(json_value.slice(1)), "临时文件必须用完即删").toBe(false);
    const logged = (calls[0] as { json?: unknown }).json as {
      create_records: Array<Record<string, unknown>>;
    };
    expect(logged.create_records).toHaveLength(records.length);
    expect(logged.create_records[0].card_id).toBe("c1");
    expect(read_state().records.tbl_cards).toHaveLength(records.length);
    expect(read_state().records.tbl_cards[0].fields.content).toHaveLength(300);
  });

  test("batch update passes large payloads through a temporary json file and removes it", async () => {
    write_state({
      tables: [
        {
          id: "tbl_cards",
          name: "KnowledgeCards",
          fields: with_field_ids([{ name: "content", type: "text" }]),
        },
      ],
      records: {
        tbl_cards: Array.from({ length: 200 }, (_value, index) => ({
          record_id: `r${index + 1}`,
          fields: { content: "old" },
        })),
      },
    });
    env.FAKE_LOG_JSON = "1";
    const updates = Array.from({ length: 200 }, (_value, index) => ({
      record_id: `r${index + 1}`,
      fields: { content: "y".repeat(200) },
    }));

    const result = expect_ok(await batch_update_records(context(), "tbl_cards", updates));

    expect(result).toEqual({ ok: true });
    const calls = read_calls();
    expect(calls).toHaveLength(1);
    const json_value = json_argument(calls[0].args);
    expect(json_value.startsWith("@")).toBe(true);
    expect(existsSync(json_value.slice(1)), "临时文件必须用完即删").toBe(false);
    const logged = (calls[0] as { json?: unknown }).json as {
      update_records: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(logged.update_records)).toHaveLength(200);
    // 真实 API 只接受直接字段映射（嵌套 fields 会被拒绝 800010701）。
    expect(logged.update_records.r1).toEqual({ content: "y".repeat(200) });
    expect(read_state().records.tbl_cards[0].fields.content).toHaveLength(200);
  });

  test("temporary json file is removed when the write fails", async () => {
    write_state({ tables: [], records: {} });
    env.FAKE_LOG_JSON = "1";
    env.FAKE_SCENARIO = "base-unreachable";
    const records = Array.from({ length: 120 }, (_value, index) => ({
      card_id: `c${index + 1}`,
      content: "x".repeat(300),
    }));

    const result = await batch_create_records(context(), "tbl_cards", records);

    expect(result.ok).toBe(false);
    const calls = read_calls();
    expect(calls).toHaveLength(1);
    const json_value = json_argument(calls[0].args);
    expect(json_value.startsWith("@")).toBe(true);
    expect(existsSync(json_value.slice(1)), "失败路径也必须删除临时文件").toBe(false);
  });

  // 复核修复（Task 5 Important）：inline 预算必须按「转义后整条命令行」判定，
  // 不能按原始 JSON 长度——引号/逗号经 2 层转义后放大约 1.4～2 倍。
  test("keeps json args inline while the escaped command line fits the budget", async () => {
    write_state({
      tables: [
        {
          id: "tbl_cards",
          name: "KnowledgeCards",
          fields: with_field_ids([
            { name: "card_id", type: "text" },
            { name: "content", type: "text" },
          ]),
        },
      ],
      records: {},
    });
    env.FAKE_LOG_JSON = "1";
    const calibrated = create_records_fitting_budget(JSON_ARG_ESCAPED_LINE_BUDGET);

    // 刚好贴住预算：再补一条记录就会超限。
    expect(calibrated.escaped_length).toBeLessThanOrEqual(JSON_ARG_ESCAPED_LINE_BUDGET);
    expect(calibrated.escaped_length).toBeGreaterThan(JSON_ARG_ESCAPED_LINE_BUDGET - 200);
    expect(calibrated.records.length).toBeGreaterThan(30);
    expect(calibrated.json.length).toBeGreaterThan(3_000);

    const result = expect_ok(
      await batch_create_records(context(), "tbl_cards", calibrated.records),
    );

    expect(result.record_ids).toHaveLength(calibrated.records.length);
    const calls = read_calls();
    expect(calls).toHaveLength(1);
    const json_value = json_argument(calls[0].args);
    expect(json_value.startsWith("@"), "转义后在预算内必须保持 inline").toBe(false);
    expect(json_value).toBe(calibrated.json);
    const logged = (calls[0] as { json?: unknown }).json as { create_records: unknown[] };
    expect(logged.create_records).toHaveLength(calibrated.records.length);
    expect(read_state().records.tbl_cards).toHaveLength(calibrated.records.length);
  });

  test("sends small raw json to a file once the escaped command line exceeds the budget", async () => {
    write_state({
      tables: [
        {
          id: "tbl_cards",
          name: "KnowledgeCards",
          fields: with_field_ids([
            { name: "card_id", type: "text" },
            { name: "content", type: "text" },
          ]),
        },
      ],
      records: {},
    });
    env.FAKE_LOG_JSON = "1";
    const payload = create_records_with_raw_length(6_500);

    // 原始 JSON 看起来不大（6k 级别，旧口径 24k 会放行），但转义后整条命令行已超预算。
    expect(payload.json.length).toBeGreaterThanOrEqual(6_000);
    expect(payload.json.length).toBeLessThanOrEqual(8_000);
    expect(payload.escaped_length).toBeGreaterThan(JSON_ARG_ESCAPED_LINE_BUDGET);

    const result = expect_ok(
      await batch_create_records(context(), "tbl_cards", payload.records),
    );

    expect(result.record_ids).toHaveLength(payload.records.length);
    const calls = read_calls();
    expect(calls).toHaveLength(1);
    const json_value = json_argument(calls[0].args);
    expect(json_value.startsWith("@")).toBe(true);
    expect(existsSync(json_value.slice(1)), "临时文件必须用完即删").toBe(false);
    // 子进程在调用瞬间真的读到了文件：假 CLI 把解析后的 body 记进了 payload 日志。
    const logged = (calls[0] as { json?: unknown }).json as {
      create_records: Array<{ card_id: string; content: string }>;
    };
    expect(logged.create_records).toHaveLength(payload.records.length);
    expect(logged.create_records.at(-1)).toEqual(payload.records.at(-1));
    expect(read_state().records.tbl_cards).toHaveLength(payload.records.length);
  });

  // Task 2 结转 Minor：create/update 已覆盖 200/201，这里补 delete 的分块边界。
  test("delete chunks at 200 records and passes yes on execution", async () => {
    const ids = Array.from({ length: BASE_BATCH_SIZE + 1 }, (_value, index) => `rec_${index + 1}`);
    write_state({
      tables: [
        {
          id: "tbl_cards",
          name: "KnowledgeCards",
          fields: with_field_ids([{ name: "card_id", type: "text" }]),
        },
      ],
      records: {
        tbl_cards: ids.map((record_id, index) => ({
          record_id,
          fields: { card_id: `c${index + 1}` },
        })),
      },
    });

    const result = expect_ok(
      await delete_records(context(), "tbl_cards", ids, { dry_run: false }),
    );

    expect(result.dry_run).toBe(false);
    expect(result.record_ids).toEqual(ids);
    const delete_calls = read_calls().filter((call) => call.args[1] === "+record-delete");
    expect(delete_calls).toHaveLength(2);
    const first_payload = JSON.parse(json_argument(delete_calls[0].args)) as {
      record_id_list: string[];
    };
    const second_payload = JSON.parse(json_argument(delete_calls[1].args)) as {
      record_id_list: string[];
    };
    expect(first_payload.record_id_list).toEqual(ids.slice(0, BASE_BATCH_SIZE));
    expect(second_payload.record_id_list).toEqual([`rec_${BASE_BATCH_SIZE + 1}`]);
    for (const call of delete_calls) {
      expect(call.args).toContain("--yes");
      expect(call.args).not.toContain("--dry-run");
    }
    expect(read_state().records.tbl_cards).toEqual([]);
  });
});
