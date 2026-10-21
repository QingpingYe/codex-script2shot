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
import {
  delete_doc_cards,
  type DeleteDocCardsResult,
  type DeleteDocCardsSuccess,
} from "../src/tools/delete_doc_cards.js";

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
}

let tempRoot = "";
let home = "";
let cliPath = "";
let statePath = "";
let logPath = "";
let env: NodeJS.ProcessEnv;
let previousHome: string | undefined;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "script2shot-delete-cards-"));
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

function make_state(source_doc_token: string): SyncState {
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
  };
}

function expect_success(result: DeleteDocCardsResult): DeleteDocCardsSuccess {
  if ("ok" in result) {
    throw new Error(`expected success, got ${JSON.stringify(result)}`);
  }
  return result;
}

/** 写入该文档的 3 张知识卡、1 条 SyncState，以及另一个文档的 1 张卡、1 条状态。 */
function seed_doc_and_other(): void {
  write_base_state({
    cards: [
      card_row("rec_a1", make_card("src:doccnA:example:001", DOC_TOKEN)),
      card_row("rec_a2", make_card("src:doccnA:example:002", DOC_TOKEN)),
      card_row("rec_a3", make_card("src:doccnA:example:003", DOC_TOKEN)),
      card_row("rec_b1", make_card("src:doccnOther:example:001", OTHER_TOKEN)),
    ],
    state: [
      state_row("rec_s1", make_state(DOC_TOKEN)),
      state_row("rec_s2", make_state(OTHER_TOKEN)),
    ],
  });
}

describe("delete_doc_cards", () => {
  test("delete removes cards and state", async () => {
    seed_doc_and_other();

    const result = expect_success(
      await delete_doc_cards({ source_doc_token: DOC_TOKEN, dry_run: false, env }),
    );

    expect(result).toEqual({ dry_run: false, deleted_cards: 3, deleted_state: 1 });
    const calls = read_calls().map((call) => call.args);
    expect(
      calls.map((args) => [
        args[1],
        args.includes("--yes") ? "--yes" : args.includes("--dry-run") ? "--dry-run" : "",
        args.includes(CARDS_TABLE) ? "cards" : "state",
      ]),
    ).toEqual([
      // 先读齐两张表的现有记录（确认要删什么），再按「卡片 → 状态」的顺序执行删除。
      ["+record-list", "", "cards"],
      ["+record-list", "", "state"],
      ["+record-delete", "--yes", "cards"],
      ["+record-delete", "--yes", "state"],
    ]);
    expect(JSON.parse(json_argument(calls[2]))).toEqual({
      record_id_list: ["rec_a1", "rec_a2", "rec_a3"],
    });
    expect(JSON.parse(json_argument(calls[3]))).toEqual({ record_id_list: ["rec_s1"] });
    expect(card_records().map((row) => row.record_id)).toEqual(["rec_b1"]);
    expect(state_records().map((row) => row.record_id)).toEqual(["rec_s2"]);
  });

  test("delete is idempotent when records missing", async () => {
    seed_doc_and_other();

    const first = expect_success(
      await delete_doc_cards({ source_doc_token: DOC_TOKEN, dry_run: false, env }),
    );
    expect(first).toEqual({ dry_run: false, deleted_cards: 3, deleted_state: 1 });

    const calls_after_first = read_calls().length;
    const second = expect_success(
      await delete_doc_cards({ source_doc_token: DOC_TOKEN, dry_run: false, env }),
    );

    expect(second).toEqual({ dry_run: false, deleted_cards: 0, deleted_state: 0 });
    const repeat_calls = read_calls().slice(calls_after_first).map((call) => call.args[1]);
    expect(repeat_calls).toEqual(["+record-list", "+record-list"]);
    expect(card_records().map((row) => row.record_id)).toEqual(["rec_b1"]);
    expect(state_records().map((row) => row.record_id)).toEqual(["rec_s2"]);
  });

  test("delete dry run previews without applying changes", async () => {
    seed_doc_and_other();

    const preview = expect_success(await delete_doc_cards({ source_doc_token: DOC_TOKEN, env }));

    expect(preview).toEqual({ dry_run: true, deleted_cards: 3, deleted_state: 1 });
    const calls = read_calls().map((call) => call.args);
    expect(calls).toHaveLength(4);
    for (const args of calls.filter((args) => args[1] === "+record-delete")) {
      expect(args).toContain("--dry-run");
      expect(args).not.toContain("--yes");
    }
    expect(card_records()).toHaveLength(4);
    expect(state_records()).toHaveLength(2);
  });
});
