import path from "node:path";
import {
  CONFIG_FILE_NAME,
  load_config,
  resolve_home,
  save_config,
  type Script2ShotConfig,
} from "../config.js";
import {
  create_table,
  list_fields,
  list_tables,
  type LarkBaseContext,
  type LarkBaseField,
  type LarkBaseFieldDefinition,
  type LarkBaseFailure,
} from "../lark_base.js";
import { resolve_lark_cli, type LarkCliErrorCode } from "../lark_cli.js";
import { normalize_config } from "./write_config.js";

/**
 * `init_knowledge_b` MCP Tool（架构 §5.1、§8、§9.1）。
 *
 * - 按固定表名在 AI 库中解析 `KnowledgeCards` 与 `SyncState`；缺表时按固定字段
 *   清单创建，已存在时校验字段清单（缺字段 / 类型不符 -> drift，不自动改表；
 *   多余字段 -> warning）。
 * - 表名解析出多个 table_id 时报 `KB_TABLE_AMBIGUOUS` 并要求人工处理。
 * - `dry_run` 缺省 true：只做读操作（表列表），不建表、不写配置；dry_run=false 且
 *   建表/校验成功后，才把解析出的两个 table_id 合并写回本地 config.toml。
 * - `pending_config`（架构 §8）可选：与 `write_config` 的 `config` 同形状，提供且
 *   校验通过时本次调用完全不读磁盘配置（`config_source: "pending"`）；只允许
 *   dry-run，执行路径携带时直接返回 `CONFIG_INVALID`。
 * - 返回值是结果对象，不抛异常；错误码为 SCREAMING_SNAKE。
 */

export type InitKnowledgeBErrorCode =
  | LarkCliErrorCode
  | "CONFIG_INVALID"
  | "CONFIG_MISSING"
  | "KB_TABLE_AMBIGUOUS"
  | "KB_READ_FAILED"
  | "KB_WRITE_FAILED";

export type InitKnowledgeBAction = "created" | "validated" | "drift";

export interface InitKnowledgeBInput {
  /** 缺省 true：只校验不落盘。 */
  dry_run?: unknown;
  /** 可选：与 `write_config` 的 `config` 同形状；提供即替代磁盘配置（仅 dry-run）。 */
  pending_config?: unknown;
  /** 默认 process.env；测试可注入受控环境。 */
  env?: NodeJS.ProcessEnv;
  /** 默认 os.homedir()；用于 lark-cli 常见安装目录探测。 */
  home_dir?: string;
}

export interface InitKnowledgeBDrift {
  table: string;
  field: string;
  issue: "missing_field" | "type_mismatch";
  expected_type: string;
  actual_type?: string;
}

export interface InitKnowledgeBWarning {
  code: string;
  /** 与 drift[].issue 平行的语义标记；多余字段固定为 extra_field。 */
  issue: "extra_field" | "table_missing";
  message: string;
  table?: string;
  field?: string;
}

export interface InitKnowledgeBSuccess {
  dry_run: boolean;
  action: InitKnowledgeBAction;
  /** 本次配置来源：`pending`（入参提供）或 `disk`（读取 config.toml）。 */
  config_source: "pending" | "disk";
  tables: {
    knowledge_cards: string | null;
    sync_state: string | null;
  };
  drift: InitKnowledgeBDrift[];
  warnings: InitKnowledgeBWarning[];
}

export interface InitKnowledgeBFailure {
  ok: false;
  error: {
    code: InitKnowledgeBErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type InitKnowledgeBResult = InitKnowledgeBSuccess | InitKnowledgeBFailure;

interface TableSpec {
  key: "knowledge_cards" | "sync_state";
  name: string;
  fields: LarkBaseFieldDefinition[];
}

/** 固定表与字段清单（brief 冻结；首字段即主字段）。 */
const TABLE_SPECS: TableSpec[] = [
  {
    key: "knowledge_cards",
    name: "KnowledgeCards",
    fields: [
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
    ],
  },
  {
    key: "sync_state",
    name: "SyncState",
    fields: [
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
    ],
  },
];

export async function init_knowledge_b(
  input: InitKnowledgeBInput = {},
): Promise<InitKnowledgeBResult> {
  const dry_run_parsed = parse_dry_run(input.dry_run);
  if ("error" in dry_run_parsed) {
    return dry_run_parsed;
  }
  const dry_run = dry_run_parsed.value;

  let config: Script2ShotConfig;
  let config_source: InitKnowledgeBSuccess["config_source"];
  if (input.pending_config !== undefined) {
    if (!dry_run) {
      return failure(
        "CONFIG_INVALID",
        '入参字段 "pending_config" 只允许用于 dry_run 预览；执行路径必须先写入配置。',
        { field: "pending_config" },
      );
    }
    const normalized = normalize_config(input.pending_config, { preserve_existing: false });
    if ("error" in normalized) {
      return normalized;
    }
    config = normalized.config;
    config_source = "pending";
  } else {
    const loaded = load_config();
    if ("error" in loaded) {
      return failure("CONFIG_INVALID", loaded.error.message, loaded.error.details);
    }
    if (!loaded.exists) {
      return failure(
        "CONFIG_MISSING",
        `未找到配置文件：${loaded.path}。请先运行 $setup 或 write_config 初始化配置。`,
        { path: loaded.path },
      );
    }
    config = loaded.config;
    config_source = "disk";
  }

  const base_b = config.lark.base_b;
  if (!has_text(base_b)) {
    return failure("CONFIG_INVALID", "配置缺少 lark.base_b，无法访问 AI 库。", {
      field: "lark.base_b",
      path: path.join(resolve_home(), CONFIG_FILE_NAME),
    });
  }

  const cli = resolve_lark_cli(config, { env: input.env, home_dir: input.home_dir });
  if (!cli.ok) {
    return { ok: false, error: cli.error };
  }
  const base: LarkBaseContext = {
    cli_path: cli.path,
    base_token: base_b,
    env: input.env,
  };

  const listed = await list_tables(base);
  if (!listed.ok) {
    return listed;
  }

  const ids_by_name = new Map<string, string[]>();
  for (const table of listed.tables) {
    const ids = ids_by_name.get(table.name) ?? [];
    ids.push(table.id);
    ids_by_name.set(table.name, ids);
  }
  for (const spec of TABLE_SPECS) {
    const ids = ids_by_name.get(spec.name) ?? [];
    if (ids.length > 1) {
      return failure(
        "KB_TABLE_AMBIGUOUS",
        `AI 库中存在 ${ids.length} 张名为 "${spec.name}" 的数据表，无法确定使用哪一张；` +
          `请人工删除或重命名多余的表后重试。`,
        { table_name: spec.name, table_ids: ids },
      );
    }
  }

  const tables: InitKnowledgeBSuccess["tables"] = {
    knowledge_cards: null,
    sync_state: null,
  };
  const warnings: InitKnowledgeBWarning[] = [];
  const missing_tables: string[] = [];

  for (const spec of TABLE_SPECS) {
    const ids = ids_by_name.get(spec.name) ?? [];
    if (ids.length > 0) {
      tables[spec.key] = ids[0];
      continue;
    }

    missing_tables.push(spec.name);
    if (dry_run) {
      warnings.push({
        code: "KB_TABLE_MISSING",
        issue: "table_missing",
        table: spec.name,
        message:
          `数据表 "${spec.name}" 不存在；dry_run 不会创建它，` +
          `dry_run=false 时会按固定字段清单创建。`,
      });
      continue;
    }

    const created = await create_table(base, spec.name, spec.fields);
    if (!created.ok) {
      return partial_write_failure(created, spec.name, tables);
    }
    tables[spec.key] = created.table_id;
  }

  const drift: InitKnowledgeBDrift[] = [];
  for (const spec of TABLE_SPECS) {
    const table_id = tables[spec.key];
    // 本次新建的表按固定字段清单创建，无需再校验；只校验调用前已存在的表。
    if (table_id === null || missing_tables.includes(spec.name)) {
      continue;
    }
    const listed_fields = await list_fields(base, table_id);
    if (!listed_fields.ok) {
      return listed_fields;
    }
    inspect_table_schema(spec, listed_fields.fields, drift, warnings);
  }

  const action: InitKnowledgeBAction =
    drift.length > 0 ? "drift" : missing_tables.length > 0 ? "created" : "validated";

  // 只有执行路径且校验通过（非 drift）才写回 table_id；drift 留给人工处理后重跑。
  if (!dry_run && action !== "drift") {
    const write_result = write_table_ids(config, tables);
    if (!write_result.ok) {
      return write_result;
    }
  }

  return { dry_run, action, config_source, tables: { ...tables }, drift, warnings };
}

function inspect_table_schema(
  spec: TableSpec,
  actual_fields: LarkBaseField[],
  drift: InitKnowledgeBDrift[],
  warnings: InitKnowledgeBWarning[],
): void {
  const actual_types = new Map<string, string>();
  for (const field of actual_fields) {
    actual_types.set(field.name, field.type);
  }
  const expected_names = new Set(spec.fields.map((field) => field.name));

  for (const expected of spec.fields) {
    const actual_type = actual_types.get(expected.name);
    if (actual_type === undefined) {
      drift.push({
        table: spec.name,
        field: expected.name,
        issue: "missing_field",
        expected_type: expected.type,
      });
      continue;
    }
    if (normalize_type(actual_type) !== normalize_type(expected.type)) {
      drift.push({
        table: spec.name,
        field: expected.name,
        issue: "type_mismatch",
        expected_type: expected.type,
        actual_type,
      });
    }
  }

  for (const actual of actual_fields) {
    if (expected_names.has(actual.name)) {
      continue;
    }
    warnings.push({
      code: "KB_EXTRA_FIELD",
      issue: "extra_field",
      table: spec.name,
      field: actual.name,
      message:
        `数据表 "${spec.name}" 存在多余字段 "${actual.name}"（type=${actual.type}）；` +
        `多余字段不影响同步，保留不动。`,
    });
  }
}

/**
 * 执行路径写回 table_id：重新读取最新配置再合并，避免覆盖并发写下的其他字段；
 * 读取失败时退回本次调用开始时读到的配置。
 */
function write_table_ids(
  previous: Script2ShotConfig,
  tables: InitKnowledgeBSuccess["tables"],
): { ok: true } | InitKnowledgeBFailure {
  if (tables.knowledge_cards === null || tables.sync_state === null) {
    return failure("INTERNAL", "内部状态不一致：建表成功后仍缺少 table_id。", {
      tables: { ...tables },
    });
  }

  const latest = load_config();
  const merged = "error" in latest || !latest.exists ? structuredClone(previous) : latest.config;
  merged.lark.knowledge_cards_table_id = tables.knowledge_cards;
  merged.lark.sync_state_table_id = tables.sync_state;

  try {
    save_config(merged, { dry_run: false });
  } catch (error) {
    return failure("INTERNAL", `建表/校验已成功，但写入本地配置失败：${describe_error(error)}。`, {
      tables: { ...tables },
      hint:
        "请手动把两张表的 table_id 写入 config.toml 的 " +
        "lark.knowledge_cards_table_id 与 lark.sync_state_table_id。",
    });
  }
  return { ok: true };
}

function partial_write_failure(
  failure_result: LarkBaseFailure,
  failed_table: string,
  tables: InitKnowledgeBSuccess["tables"],
): InitKnowledgeBFailure {
  return {
    ok: false,
    error: {
      ...failure_result.error,
      details: {
        ...(failure_result.error.details ?? {}),
        failed_table,
        tables_created: { ...tables },
        config_updated: false,
      },
    },
  };
}

function parse_dry_run(value: unknown): { value: boolean } | InitKnowledgeBFailure {
  if (value === undefined) {
    return { value: true };
  }
  if (typeof value !== "boolean") {
    return failure("CONFIG_INVALID", '输入字段 "dry_run" 期望布尔值。', { field: "dry_run" });
  }
  return { value };
}

function failure(
  code: InitKnowledgeBErrorCode,
  message: string,
  details?: Record<string, unknown>,
): InitKnowledgeBFailure {
  return {
    ok: false,
    error: details === undefined ? { code, message } : { code, message, details },
  };
}

function normalize_type(value: string): string {
  return value.trim().toLowerCase();
}

function has_text(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function describe_error(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
