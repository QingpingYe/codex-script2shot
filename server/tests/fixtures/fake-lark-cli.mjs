#!/usr/bin/env node
// 假 lark-cli：封闭测试替身，实现插件当前用到的命令
// （--help / --version / auth status / profile list / wiki +node-list /
//  base +table-list / +table-create / +field-list / +record-list /
//  +record-batch-create / +record-batch-update / +record-delete）。
// 行为开关：
//   FAKE_SCENARIO        ok | no-auth | auth-expired | legacy-no-auth | legacy-auth |
//                        old-version | missing-capability | bad-json | space-unreachable |
//                        base-unreachable | table-missing | legacy-table-list |
//                        table-create-no-id（默认 ok）
//   FAKE_AUTH_EXIT_CODE  覆盖 auth status 的退出码，用于覆盖 ok:false 且退出码为 0 的分支
//   FAKE_ACTIVE_PROFILE  覆盖 profile list 返回的活动 profile（默认 default）
//   FAKE_LOG_FILE        把每次调用的 argv 以 JSON Lines 追加记录
//   FAKE_WIKI_NODES_FILE wiki nodes list 录制索引（父级/分页令牌 → 原始响应页文件）；
//                        未设置时 wiki nodes list 返回空页
//   FAKE_WIKI_NODE_GET_FILE wiki +node-get 录制索引（node token → 原始响应 payload）；
//                        未录制的 token 直接失败
//   FAKE_DOCS_FETCH_FILE docs +fetch 录制索引（document token → 原始响应 payload）；
//                        未录制的 token 直接失败
//   FAKE_RECORD_LIST_FIRST_NEXT_OFFSET  仅用于覆盖显式 next_offset 分支：
//                        设置时第一页返回该值作为 data.next_offset（默认真实形状不带该字段）
//   FAKE_BASE_STATE_FILE Base 状态文件：存在时替代内置默认表/字段/记录，写命令后回写；
//                        文件不存在视为空 Base
//   FAKE_TABLE_CREATE_ID_KEY  覆盖 +table-create 返回的 id 位置：table（默认）| id | table_id
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const scenario = process.env.FAKE_SCENARIO ?? "ok";
const args = process.argv.slice(2);
const log_file = process.env.FAKE_LOG_FILE;
if (log_file) {
  appendFileSync(log_file, `${JSON.stringify({ scenario, args })}\n`, "utf8");
}

const HELP_COMMANDS = {
  wiki: ["+node-list", "+node-get", "+space-list"],
  docs: ["+fetch", "+create", "+update"],
  base: [
    "+table-create",
    "+table-list",
    "+field-list",
    "+record-batch-create",
    "+record-batch-update",
    "+record-list",
    "+record-delete",
  ],
  auth: ["status", "login", "logout", "list"],
  profile: ["list", "use", "add", "remove", "rename"],
};

const FULL_CARDS_FIELDS = [
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

const FULL_STATE_FIELDS = [
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

function help_text(group) {
  let commands = HELP_COMMANDS[group];
  if (!commands) {
    return undefined;
  }
  if (scenario === "missing-capability" && group === "base") {
    commands = commands.filter((name) => name !== "+record-batch-create" && name !== "+record-delete");
  }
  return [
    `fake ${group} commands`,
    "",
    "Usage:",
    `  lark-cli ${group} [flags]`,
    `  lark-cli ${group} [command]`,
    "",
    "Available Commands:",
    ...commands.map((name) => `  ${name.padEnd(24)} fake help entry`),
    "",
  ].join("\n");
}

function exit_with(code) {
  process.exit(code);
}

if (args.length === 1 && args[0] === "--version") {
  const version = scenario === "old-version" ? "0.9.0" : "1.0.98";
  process.stdout.write(`lark-cli version ${version}\n`);
  exit_with(0);
}

const [group, sub] = args;
if (sub === "--help" && help_text(group) !== undefined) {
  process.stdout.write(help_text(group));
  exit_with(0);
}

if (group === "auth" && sub === "status") {
  if (scenario === "bad-json") {
    process.stdout.write("not-json{\n");
    process.stderr.write(`fake-lark-cli: invalid json payload ${"x".repeat(600)}\n`);
    exit_with(0);
  }

  if (scenario === "legacy-no-auth") {
    const override = process.env.FAKE_AUTH_EXIT_CODE;
    const exit_code = override === undefined ? 1 : Number.parseInt(override, 10);
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { code: "NOT_LOGGED_IN", message: "not logged in" } })}\n`,
    );
    process.stderr.write("fake-lark-cli: not logged in, run `lark-cli auth login`\n");
    exit_with(Number.isNaN(exit_code) ? 1 : exit_code);
  }

  if (scenario === "legacy-auth") {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        data: {
          identity: "fake-identity-1",
          user: { name: "测试用户", open_id: "ou_fake_1" },
          verified: args.includes("--verify"),
        },
      })}\n`,
    );
    exit_with(0);
  }

  if (scenario === "no-auth" || scenario === "auth-expired") {
    const override = process.env.FAKE_AUTH_EXIT_CODE;
    const default_exit_code = 0;
    const exit_code =
      override === undefined ? default_exit_code : Number.parseInt(override, 10);
    const user =
      scenario === "auth-expired"
        ? {
            status: "ready",
            available: true,
            message: "User identity: ready",
            openId: "ou_fake_1",
            userName: "测试用户",
            tokenStatus: "expired",
          }
        : {
            status: "missing",
            available: false,
            message: "User identity: missing",
            tokenStatus: "missing",
          };
    process.stdout.write(
      `${JSON.stringify({
        appId: "cli_fake",
        brand: "feishu",
        identities: {
          bot: { status: "ready", available: true, message: "Bot identity: ready" },
          user,
        },
        identity: "user",
      })}\n`,
    );
    process.stderr.write("fake-lark-cli: user identity unavailable\n");
    exit_with(Number.isNaN(exit_code) ? default_exit_code : exit_code);
  }

  process.stdout.write(
    `${JSON.stringify({
      appId: "cli_fake",
      brand: "feishu",
      identities: {
        bot: { status: "ready", available: true, message: "Bot identity: ready" },
        user: {
          status: "ready",
          available: true,
          message: "User identity: ready",
          openId: "ou_fake_1",
          userName: "测试用户",
          tokenStatus: "valid",
        },
      },
      identity: "user",
    })}\n`,
  );
  exit_with(0);
}

if (group === "profile" && sub === "list") {
  const active_profile = process.env.FAKE_ACTIVE_PROFILE ?? "default";
  process.stdout.write(
    `${JSON.stringify([
      {
        name: active_profile,
        appId: "cli_fake",
        brand: "feishu",
        active: true,
        effective: true,
        effectiveSource: "config",
        user: "测试用户",
        tokenStatus: "valid",
      },
    ])}\n`,
  );
  exit_with(0);
}

if (group === "wiki" && sub === "+node-list") {
  if (scenario === "space-unreachable") {
    process.stderr.write("fake-lark-cli: wiki space unreachable\n");
    exit_with(1);
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, data: { nodes: [], has_more: false, page_token: "" } })}\n`,
  );
  exit_with(0);
}

if (group === "wiki" && sub === "+node-get") {
  const node_token = arg_value(args, "--node-token") ?? arg_value(args, "--token");
  if (typeof node_token !== "string" || node_token === "") {
    process.stderr.write("fake-lark-cli: wiki +node-get requires --node-token\n");
    exit_with(1);
  }
  const nodes = load_recorded_map(process.env.FAKE_WIKI_NODE_GET_FILE);
  const payload = nodes?.[node_token];
  if (payload === undefined) {
    process.stderr.write(
      `fake-lark-cli: no recorded wiki +node-get payload for "${node_token}"\n`,
    );
    exit_with(1);
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  exit_with(0);
}

if (group === "wiki" && sub === "nodes" && args[2] === "list") {
  if (scenario === "space-unreachable") {
    process.stderr.write("fake-lark-cli: wiki space unreachable\n");
    exit_with(1);
  }
  const manifest_file = process.env.FAKE_WIKI_NODES_FILE;
  if (!manifest_file) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, data: { has_more: false, items: [], page_token: "" } })}\n`,
    );
    exit_with(0);
  }
  const manifest = JSON.parse(readFileSync(manifest_file, "utf8"));
  const space_id = arg_value(args, "--space-id");
  if (manifest.space_id !== undefined && space_id !== manifest.space_id) {
    process.stderr.write(`fake-lark-cli: unexpected --space-id "${space_id}"\n`);
    exit_with(1);
  }
  const page_size = Number.parseInt(arg_value(args, "--page-size") ?? "", 10);
  if (manifest.page_size !== undefined && page_size !== manifest.page_size) {
    process.stderr.write(
      `fake-lark-cli: wiki nodes list must use --page-size ${manifest.page_size} for this recording\n`,
    );
    exit_with(1);
  }
  if (arg_value(args, "--as") !== "user" || arg_value(args, "--format") !== "json") {
    process.stderr.write("fake-lark-cli: wiki nodes list requires --as user --format json\n");
    exit_with(1);
  }
  const parent_node_token = arg_value(args, "--parent-node-token") ?? "";
  const page_token = arg_value(args, "--page-token") ?? "";
  const entry = manifest.pages.find(
    (page) => page.parent_node_token === parent_node_token && page.page_token === page_token,
  );
  if (!entry) {
    process.stderr.write(
      "fake-lark-cli: no recorded wiki nodes list page for " +
        `parent="${parent_node_token}" page_token="${page_token}"\n`,
    );
    exit_with(1);
  }
  const page_payload = JSON.parse(
    readFileSync(path.join(path.dirname(manifest_file), entry.file), "utf8"),
  );
  process.stdout.write(`${JSON.stringify(page_payload)}\n`);
  exit_with(0);
}

if (group === "docs" && sub === "+fetch") {
  if (scenario === "docs-unreachable") {
    process.stderr.write("fake-lark-cli: docs unreachable\n");
    exit_with(1);
  }
  const doc = arg_value(args, "--doc");
  if (typeof doc !== "string" || doc === "") {
    process.stderr.write("fake-lark-cli: docs +fetch requires --doc\n");
    exit_with(1);
  }
  if (
    arg_value(args, "--doc-format") !== "markdown" ||
    arg_value(args, "--revision-id") !== "-1" ||
    arg_value(args, "--format") !== "json"
  ) {
    process.stderr.write(
      "fake-lark-cli: docs +fetch requires --doc-format markdown --revision-id -1 --format json\n",
    );
    exit_with(1);
  }
  if (args.includes("--detail")) {
    process.stderr.write("fake-lark-cli: markdown 模式不支持 --detail\n");
    exit_with(1);
  }
  const documents = load_recorded_map(process.env.FAKE_DOCS_FETCH_FILE);
  const payload = documents?.[doc];
  if (payload === undefined) {
    process.stderr.write(`fake-lark-cli: no recorded docs +fetch payload for "${doc}"\n`);
    exit_with(1);
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  exit_with(0);
}

if (group === "base") {
  if (scenario === "base-unreachable") {
    process.stderr.write("fake-lark-cli: base unreachable\n");
    exit_with(1);
  }

  if (sub === "+table-list") {
    const state = load_base_state();
    const legacy_shape = scenario === "legacy-table-list";
    const tables = state.tables.map((table) =>
      legacy_shape
        ? { table_id: table.id, name: table.name }
        : {
            id: table.id,
            name: table.name,
            records_count: (state.records?.[table.id] ?? []).length,
          },
    );
    process.stdout.write(`${JSON.stringify({ ok: true, data: { tables, total: tables.length } })}\n`);
    exit_with(0);
  }

  if (sub === "+table-create") {
    if (scenario === "table-create-no-id") {
      process.stdout.write(`${JSON.stringify({ ok: true, data: {} })}\n`);
      exit_with(0);
    }
    const name = arg_value(args, "--name");
    const requested_fields = parse_json_argument(args, "--fields");
    if (
      typeof name !== "string" ||
      !Array.isArray(requested_fields) ||
      requested_fields.length === 0
    ) {
      process.stderr.write(
        "fake-lark-cli: +table-create requires --name and a non-empty --fields JSON array\n",
      );
      exit_with(1);
    }
    const state = load_base_state();
    const table_id = `tbl_fake_${state.tables.length + 1}`;
    state.tables.push({
      id: table_id,
      name,
      fields: requested_fields.map((field, index) => ({
        id: `fld_${table_id}_${index + 1}`,
        name: field.name,
        type: field.type,
      })),
    });
    save_base_state(state);
    const id_key = process.env.FAKE_TABLE_CREATE_ID_KEY ?? "table";
    const data = id_key === "table" ? { table: { id: table_id, name } } : { [id_key]: table_id };
    process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
    exit_with(0);
  }

  if (sub === "+field-list") {
    const state = load_base_state();
    const table = find_base_table(state, arg_value(args, "--table-id"));
    if (!table) {
      process.stderr.write("fake-lark-cli: unknown table for +field-list\n");
      exit_with(1);
    }
    process.stdout.write(`${JSON.stringify({ ok: true, data: { fields: table.fields } })}\n`);
    exit_with(0);
  }

  if (sub === "+record-list") {
    const state = load_base_state();
    const table = find_base_table(state, arg_value(args, "--table-id"));
    if (!table) {
      process.stderr.write("fake-lark-cli: unknown table for +record-list\n");
      exit_with(1);
    }
    const limit_value = Number.parseInt(arg_value(args, "--limit") ?? "100", 10);
    const limit = Number.isNaN(limit_value) ? 100 : limit_value;
    const offset_value = Number.parseInt(arg_value(args, "--offset") ?? "0", 10);
    const offset = Number.isNaN(offset_value) ? 0 : offset_value;
    const projection = arg_values(args, "--field-id");
    const columns = table.fields.filter(
      (field) =>
        projection.length === 0 ||
        projection.includes(field.id) ||
        projection.includes(field.name),
    );
    const filter_json = arg_value(args, "--filter-json");
    const all = records_of(state, table.id).filter((record) =>
      filter_matches(record, filter_json),
    );
    const page = all.slice(offset, offset + limit);
    const next_offset = offset + page.length;
    const has_more = next_offset < all.length;
    const data = {
      data: page.map((record) => columns.map((column) => record.fields?.[column.name] ?? null)),
      field_id_list: columns.map((column) => column.id),
      field_type_list: columns.map((column) => column.type),
      fields: columns.map((column) => column.name),
      has_more,
      query_context: {
        field_scope: projection.length === 0 ? "all_fields" : "selected_fields",
        record_scope: filter_json ? "filtered_records" : "all_records",
      },
      record_id_list: page.map((record) => record.record_id),
      rev: 1,
      timezone: "Asia/Shanghai",
    };
    // 真实 payload 的 data 里没有 next_offset（2026-10-21 实测）：默认省略，
    // 让适配层走 offset + 本页行数的兜底分支；显式分支用环境变量单独覆盖。
    const first_next_offset = process.env.FAKE_RECORD_LIST_FIRST_NEXT_OFFSET;
    if (has_more && offset === 0 && first_next_offset !== undefined) {
      data.next_offset = Number.parseInt(first_next_offset, 10);
    }
    process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
    exit_with(0);
  }

  if (sub === "+record-batch-create") {
    const payload = parse_json_argument(args, "--json");
    const entries = payload?.create_records;
    if (!Array.isArray(entries)) {
      process.stderr.write("fake-lark-cli: +record-batch-create requires create_records array\n");
      exit_with(1);
    }
    const state = load_base_state();
    const table = find_base_table(state, arg_value(args, "--table-id"));
    if (!table) {
      process.stderr.write("fake-lark-cli: unknown table for +record-batch-create\n");
      exit_with(1);
    }
    const table_records = records_of(state, table.id);
    const record_id_list = [];
    for (const entry of entries) {
      const record_id = `rec_fake_${table_records.length + 1}`;
      table_records.push({ record_id, fields: { ...entry } });
      record_id_list.push(record_id);
    }
    save_base_state(state);
    process.stdout.write(`${JSON.stringify({ ok: true, data: { record_id_list, rev: 1 } })}\n`);
    exit_with(0);
  }

  if (sub === "+record-batch-update") {
    const payload = parse_json_argument(args, "--json");
    const updates = payload?.update_records;
    if (typeof updates !== "object" || updates === null || Array.isArray(updates)) {
      process.stderr.write("fake-lark-cli: +record-batch-update requires update_records object\n");
      exit_with(1);
    }
    const state = load_base_state();
    const table = find_base_table(state, arg_value(args, "--table-id"));
    if (!table) {
      process.stderr.write("fake-lark-cli: unknown table for +record-batch-update\n");
      exit_with(1);
    }
    const table_records = records_of(state, table.id);
    for (const [record_id, fields] of Object.entries(updates)) {
      const record = table_records.find((item) => item.record_id === record_id);
      // 真实 API 不校验 record id 是否存在：未知 id 静默忽略。
      if (record && typeof fields === "object" && fields !== null) {
        Object.assign(record.fields, fields);
      }
    }
    save_base_state(state);
    process.stdout.write(`${JSON.stringify({ ok: true, data: { ignored_fields: [] } })}\n`);
    exit_with(0);
  }

  if (sub === "+record-delete") {
    const payload = parse_json_argument(args, "--json");
    const record_id_list = payload?.record_id_list;
    if (!Array.isArray(record_id_list) || record_id_list.some((id) => typeof id !== "string")) {
      process.stderr.write("fake-lark-cli: +record-delete requires record_id_list array\n");
      exit_with(1);
    }
    const confirm = args.includes("--yes") && !args.includes("--dry-run");
    const state = load_base_state();
    const table = find_base_table(state, arg_value(args, "--table-id"));
    if (!table) {
      process.stderr.write("fake-lark-cli: unknown table for +record-delete\n");
      exit_with(1);
    }
    if (confirm) {
      state.records[table.id] = records_of(state, table.id).filter(
        (record) => !record_id_list.includes(record.record_id),
      );
      save_base_state(state);
    }
    process.stdout.write(
      `${JSON.stringify({ ok: true, data: { dry_run: !confirm, record_id_list, rev: 1 } })}\n`,
    );
    exit_with(0);
  }
}

process.stderr.write(`fake-lark-cli: unsupported command: ${args.join(" ")}\n`);
exit_with(1);

function fake_table(id, name, fields) {
  return {
    id,
    name,
    fields: fields.map((field, index) => ({
      id: `fld_${id}_${index + 1}`,
      name: field.name,
      type: field.type,
    })),
  };
}

function default_base_state() {
  const cards = fake_table("tbl_cards", "KnowledgeCards", FULL_CARDS_FIELDS);
  if (scenario === "table-missing") {
    return { tables: [cards], records: {} };
  }
  const sync_state = fake_table("tbl_state", "SyncState", FULL_STATE_FIELDS);
  return { tables: [cards, sync_state], records: {} };
}

function load_base_state() {
  const state_file = process.env.FAKE_BASE_STATE_FILE;
  if (!state_file) {
    return default_base_state();
  }
  if (!existsSync(state_file)) {
    return { tables: [], records: {} };
  }
  return JSON.parse(readFileSync(state_file, "utf8"));
}

function save_base_state(state) {
  const state_file = process.env.FAKE_BASE_STATE_FILE;
  if (state_file) {
    writeFileSync(state_file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}

function find_base_table(state, table_id_or_name) {
  return state.tables.find(
    (table) => table.id === table_id_or_name || table.name === table_id_or_name,
  );
}

function records_of(state, table_id) {
  state.records ??= {};
  state.records[table_id] ??= [];
  return state.records[table_id];
}

function arg_value(args, flag) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === flag) {
      return args[index + 1];
    }
    if (typeof value === "string" && value.startsWith(`${flag}=`)) {
      return value.slice(flag.length + 1);
    }
  }
  return undefined;
}

function arg_values(args, flag) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === flag) {
      values.push(args[index + 1]);
    } else if (typeof value === "string" && value.startsWith(`${flag}=`)) {
      values.push(value.slice(flag.length + 1));
    }
  }
  return values;
}

function parse_json_argument(args, flag) {
  const raw = arg_value(args, flag);
  if (typeof raw !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function load_recorded_map(file) {
  if (!file) {
    return undefined;
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

function cell_matches(cell, operator, expected) {
  if (operator === "==") {
    return cell === expected || JSON.stringify(cell ?? null) === JSON.stringify(expected ?? null);
  }
  if (operator === "intersects") {
    if (Array.isArray(cell)) {
      return Array.isArray(expected)
        ? expected.some((value) => cell.includes(value))
        : cell.includes(expected);
    }
    if (Array.isArray(expected)) {
      return expected.includes(cell);
    }
    if (typeof cell === "string" && typeof expected === "string") {
      return cell.includes(expected);
    }
  }
  return false;
}

function filter_matches(record, filter_json) {
  if (!filter_json) {
    return true;
  }
  let filter;
  try {
    filter = JSON.parse(filter_json);
  } catch {
    return true;
  }
  const conditions = Array.isArray(filter?.conditions) ? filter.conditions : [];
  return conditions.every((condition) => {
    if (!Array.isArray(condition) || condition.length < 3) {
      return false;
    }
    const [field, operator, expected] = condition;
    return cell_matches(record.fields?.[field], operator, expected);
  });
}
