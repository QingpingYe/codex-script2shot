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
import { load_config } from "../src/config.js";
import {
  init_knowledge_b,
  type InitKnowledgeBResult,
  type InitKnowledgeBSuccess,
} from "../src/tools/init_knowledge_b.js";

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));
const IS_WINDOWS = process.platform === "win32";
const SPACE_A = "space-a-1";
const BASE_B = "base-token-b-123456789";

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

interface FakeTable {
  id: string;
  name: string;
  fields: Array<{ id?: string; name: string; type: string }>;
}

let tempRoot = "";
let home = "";
let cliPath = "";
let statePath = "";
let logPath = "";
let env: NodeJS.ProcessEnv;
let previousHome: string | undefined;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "script2shot-init-kb-"));
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
  write_base_state([]);
  write_config_file();
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

function write_base_state(
  tables: Array<{ id: string; name: string; fields: Array<{ name: string; type: string }> }>,
): void {
  const state = {
    tables: tables.map((table) => ({
      id: table.id,
      name: table.name,
      fields: table.fields.map((field, index) => ({
        id: `fld_${table.id}_${index + 1}`,
        name: field.name,
        type: field.type,
      })),
    })),
    records: {},
  };
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function read_base_state(): { tables: FakeTable[]; records: Record<string, unknown> } {
  return JSON.parse(readFileSync(statePath, "utf8")) as {
    tables: FakeTable[];
    records: Record<string, unknown>;
  };
}

function write_config_file(): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    path.join(home, "config.toml"),
    [
      "[lark]",
      'profile = "default"',
      `space_a = "${SPACE_A}"`,
      `base_b = "${BASE_B}"`,
      "",
      "[[lark.project_roots]]",
      'node_token = "node-1"',
      'project_id = "demo"',
      "",
      "[retrieval]",
      "default_top_k = 12",
      "",
    ].join("\n"),
    "utf8",
  );
}

function config_text(): string {
  return readFileSync(path.join(home, "config.toml"), "utf8");
}

function read_calls(): Array<{ scenario: string; args: string[] }> {
  return readFileSync(logPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as { scenario: string; args: string[] });
}

function expect_success(result: InitKnowledgeBResult): InitKnowledgeBSuccess {
  if ("ok" in result) {
    throw new Error(`expected success, got ${JSON.stringify(result)}`);
  }
  return result;
}

function expect_error(result: InitKnowledgeBResult): Extract<InitKnowledgeBResult, { ok: false }> {
  if (!("ok" in result)) {
    throw new Error(`expected error, got ${JSON.stringify(result)}`);
  }
  return result;
}

function run_init(dry_run?: boolean): Promise<InitKnowledgeBResult> {
  return init_knowledge_b({
    ...(dry_run === undefined ? {} : { dry_run }),
    env,
  });
}

function create_calls(): string[][] {
  return read_calls()
    .map((call) => call.args)
    .filter((args) => args[0] === "base" && args[1] === "+table-create");
}

describe("init_knowledge_b", () => {
  test("init creates both tables when missing", async () => {
    const result = expect_success(await run_init(false));

    expect(result.action).toBe("created");
    expect(result.tables).toEqual({
      knowledge_cards: "tbl_fake_1",
      sync_state: "tbl_fake_2",
    });
    expect(create_calls()).toEqual([
      [
        "base",
        "+table-create",
        "--base-token",
        BASE_B,
        "--name",
        "KnowledgeCards",
        "--fields",
        JSON.stringify(KNOWLEDGE_CARDS_FIELDS),
      ],
      [
        "base",
        "+table-create",
        "--base-token",
        BASE_B,
        "--name",
        "SyncState",
        "--fields",
        JSON.stringify(SYNC_STATE_FIELDS),
      ],
    ]);
    expect(result.drift).toEqual([]);
    expect(read_base_state().tables.map((table) => table.name)).toEqual([
      "KnowledgeCards",
      "SyncState",
    ]);
    expect(read_base_state().tables[0].fields[0]).toMatchObject({
      name: "card_id",
      type: "text",
    });
  });

  test("init dry run performs no write calls", async () => {
    const result = expect_success(await run_init());

    expect(result.dry_run).toBe(true);
    expect(result.action).toBe("created");
    expect(result.tables).toEqual({ knowledge_cards: null, sync_state: null });
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "KB_TABLE_MISSING",
      "KB_TABLE_MISSING",
    ]);
    expect(result.warnings.map((warning) => warning.issue)).toEqual([
      "table_missing",
      "table_missing",
    ]);
    expect(read_calls().map((call) => call.args)).toEqual([
      ["base", "+table-list", "--base-token", BASE_B],
    ]);
    expect(create_calls()).toEqual([]);
    expect(read_base_state().tables).toEqual([]);
  });

  test("init validates existing schema and reports missing field drift", async () => {
    write_base_state([
      {
        id: "tbl_cards",
        name: "KnowledgeCards",
        fields: KNOWLEDGE_CARDS_FIELDS.filter((field) => field.name !== "content"),
      },
      { id: "tbl_state", name: "SyncState", fields: SYNC_STATE_FIELDS },
    ]);
    const before = config_text();

    const result = expect_success(await run_init(false));

    expect(result.action).toBe("drift");
    expect(result.tables).toEqual({ knowledge_cards: "tbl_cards", sync_state: "tbl_state" });
    expect(result.drift).toContainEqual(
      expect.objectContaining({
        table: "KnowledgeCards",
        field: "content",
        issue: "missing_field",
        expected_type: "text",
      }),
    );
    expect(create_calls()).toEqual([]);
    expect(config_text(), "drift 时不得写回 table_id").toBe(before);
  });

  test("init reports extra fields as warnings not drift", async () => {
    write_base_state([
      {
        id: "tbl_cards",
        name: "KnowledgeCards",
        fields: [...KNOWLEDGE_CARDS_FIELDS, { name: "legacy_status", type: "text" }],
      },
      { id: "tbl_state", name: "SyncState", fields: SYNC_STATE_FIELDS },
    ]);

    const result = expect_success(await run_init());

    expect(result.action).toBe("validated");
    expect(result.drift).toEqual([]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "KB_EXTRA_FIELD",
        issue: "extra_field",
        table: "KnowledgeCards",
        field: "legacy_status",
      }),
    );
    expect(create_calls()).toEqual([]);
  });

  test("init is idempotent on second run", async () => {
    const first = expect_success(await run_init(false));
    const calls_after_first = read_calls().length;
    const config_after_first = config_text();

    const second = expect_success(await run_init(false));

    expect(second.action).toBe("validated");
    expect(second.tables).toEqual(first.tables);
    expect(create_calls()).toHaveLength(2);
    expect(
      read_calls()
        .slice(calls_after_first)
        .map((call) => call.args[1]),
    ).toEqual(["+table-list", "+field-list", "+field-list"]);
    expect(config_text()).toBe(config_after_first);
    expect(read_base_state().tables.map((table) => table.id)).toEqual([
      "tbl_fake_1",
      "tbl_fake_2",
    ]);
  });

  test("init writes table ids to config only after execution", async () => {
    const before = config_text();

    const preview = expect_success(await run_init());
    expect(preview.tables).toEqual({ knowledge_cards: null, sync_state: null });
    expect(config_text(), "dry-run 不得写配置").toBe(before);

    const executed = expect_success(await run_init(false));
    expect(config_text()).not.toBe(before);

    const loaded = load_config();
    if (!("exists" in loaded) || !loaded.exists) {
      throw new Error(`expected an existing config, got ${JSON.stringify(loaded)}`);
    }
    expect(loaded.config.lark.knowledge_cards_table_id).toBe(
      executed.tables.knowledge_cards,
    );
    expect(loaded.config.lark.sync_state_table_id).toBe(executed.tables.sync_state);
    expect(loaded.config.lark.profile).toBe("default");
    expect(loaded.config.lark.space_a).toBe(SPACE_A);
    expect(loaded.config.lark.base_b).toBe(BASE_B);
    expect(loaded.config.lark.project_roots).toEqual([
      { node_token: "node-1", project_id: "demo" },
    ]);
    expect(loaded.config.retrieval.default_top_k).toBe(12);
  });

  test("init reports field type mismatch as drift", async () => {
    write_base_state([
      { id: "tbl_cards", name: "KnowledgeCards", fields: KNOWLEDGE_CARDS_FIELDS },
      {
        id: "tbl_state",
        name: "SyncState",
        fields: SYNC_STATE_FIELDS.map((field) =>
          field.name === "card_count" ? { name: field.name, type: "text" } : field,
        ),
      },
    ]);

    const result = expect_success(await run_init());

    expect(result.action).toBe("drift");
    expect(result.drift).toContainEqual(
      expect.objectContaining({
        table: "SyncState",
        field: "card_count",
        issue: "type_mismatch",
        expected_type: "number",
        actual_type: "text",
      }),
    );
    expect(create_calls()).toEqual([]);
  });

  test("init reports ambiguous table names as an error", async () => {
    write_base_state([
      { id: "tbl_cards", name: "KnowledgeCards", fields: KNOWLEDGE_CARDS_FIELDS },
      { id: "tbl_state_1", name: "SyncState", fields: SYNC_STATE_FIELDS },
      { id: "tbl_state_2", name: "SyncState", fields: SYNC_STATE_FIELDS },
    ]);

    const result = expect_error(await run_init());

    expect(result.error.code).toBe("KB_TABLE_AMBIGUOUS");
    expect(result.error.details?.table_name).toBe("SyncState");
    expect(result.error.details?.table_ids).toEqual(["tbl_state_1", "tbl_state_2"]);
    expect(create_calls()).toEqual([]);
  });

  test("dry-run previews with a pending config when the disk has none", async () => {
    rmSync(path.join(home, "config.toml"), { force: true });
    const env_without_cli_path = { ...env };
    delete env_without_cli_path.LARK_CLI_PATH;

    const result = expect_success(
      await init_knowledge_b({
        dry_run: true,
        pending_config: {
          lark: {
            cli_path: cliPath,
            profile: "pending-profile",
            space_a: SPACE_A,
            base_b: BASE_B,
          },
        },
        env: env_without_cli_path,
      }),
    );

    expect(result.config_source).toBe("pending");
    expect(result.action).toBe("created");
    expect(result.tables).toEqual({ knowledge_cards: null, sync_state: null });
    expect(read_calls().map((call) => call.args)).toEqual([
      ["base", "+table-list", "--base-token", BASE_B],
    ]);
  });

  test("dry-run previews with a pending config even when the disk config is broken", async () => {
    const broken = "[lark\nspace_a = 1\n";
    writeFileSync(path.join(home, "config.toml"), broken, "utf8");

    const result = expect_success(
      await init_knowledge_b({
        dry_run: true,
        pending_config: {
          lark: { cli_path: cliPath, profile: "pending-profile", space_a: SPACE_A, base_b: BASE_B },
        },
        env,
      }),
    );

    expect(result.config_source).toBe("pending");
    expect(result.action).toBe("created");
    expect(config_text(), "pending 预览不得改写磁盘配置").toBe(broken);
  });

  test("rejects an invalid pending config as CONFIG_INVALID", async () => {
    const result = expect_error(
      await init_knowledge_b({
        dry_run: true,
        pending_config: {
          lark: { cli_path: cliPath, profile: "pending-profile", space_a: SPACE_A, base_b: "" },
        },
        env,
      }),
    );

    expect(result.error.code).toBe("CONFIG_INVALID");
    expect(result.error.details?.missing_keys).toEqual(["lark.base_b"]);
  });

  test("refuses a pending config on the execution path without writing anything", async () => {
    const before = config_text();

    const result = expect_error(
      await init_knowledge_b({
        dry_run: false,
        pending_config: {
          lark: { cli_path: cliPath, profile: "pending-profile", space_a: SPACE_A, base_b: BASE_B },
        },
        env,
      }),
    );

    expect(result.error.code).toBe("CONFIG_INVALID");
    expect(result.error.details?.field).toBe("pending_config");
    expect(config_text(), "执行路径携带 pending_config 时不得写配置").toBe(before);
    expect(existsSync(logPath), "不得启动任何 lark-cli 子进程").toBe(false);
  });
});
