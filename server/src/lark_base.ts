import type { BaseCellValue, BaseFieldMap, BaseRecord } from "./base_mapping.js";
import { STDERR_LIMIT, run_cli, type LarkCliErrorCode } from "./lark_cli.js";

/**
 * 飞书 Base 适配层（架构 §5、§7.3、§8）。
 *
 * - 只经子进程参数数组调用 lark-cli base 子命令，不拼 shell 字符串；当前实现不传
 *   `--as`（与 health 的 `base +table-list` 保持一致）。
 * - 命令形态按 2026-10-21 `--help` 复核：`+table-list` / `+table-create --name
 *   --fields` / `+field-list --table-id` / `+record-list ... --offset --limit
 *   --format json` / `+record-batch-create --json '{"create_records":[字段映射...]}'`
 *   / `+record-batch-update --json '{"update_records":{"<record_id>":字段映射}}'`
 *   / `+record-delete --json '{"record_id_list":[...]}'` 加 `--yes`（执行）或
 *   `--dry-run`（预览）。
 * - `+record-list` 固定使用 `--format json` 的矩阵形状（`data.fields` 字段名数组 +
 *   `data.data` 行数组 + `data.record_id_list`），在本层按 fields × data rows 拼装
 *   对象数组，不改用 ndjson；分页跟随 `data.next_offset` 直到 `has_more=false`。
 * - 返回值一律是结果对象，不抛异常；业务失败按读写语义归一化为 `KB_READ_FAILED` /
 *   `KB_WRITE_FAILED`，错误详情只带 base token 前缀，不带完整 token。
 */

export const BASE_BATCH_SIZE = 200;
export const BASE_MAX_PAGE_SIZE = 200;
export const BASE_DEFAULT_PAGE_SIZE = 200;

const BASE_TOKEN_PREFIX_LENGTH = 6;

export type LarkBaseErrorCode = LarkCliErrorCode | "KB_READ_FAILED" | "KB_WRITE_FAILED";

export interface LarkBaseContext {
  cli_path: string;
  base_token: string;
  /** 默认 process.env；测试可注入受控环境。 */
  env?: NodeJS.ProcessEnv;
  /** 默认 30s（见 lark_cli.run_cli）。 */
  timeout_ms?: number;
}

export interface LarkBaseFailure {
  ok: false;
  error: {
    code: LarkBaseErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface LarkBaseTable {
  id: string;
  name: string;
}

/** 建表字段定义（`base +table-create --fields` 的数组元素）。 */
export interface LarkBaseFieldDefinition {
  name: string;
  type: string;
}

/** `base +field-list` 返回的字段；id 缺失时省略。 */
export interface LarkBaseField {
  id?: string;
  name: string;
  type: string;
}

export interface BaseRecordUpdate {
  record_id: string;
  fields: BaseFieldMap;
}

export interface ListRecordsOptions {
  /** `--filter-json` 的过滤对象（shape 见 lark-cli 帮助），原样序列化传入。 */
  filter?: Record<string, unknown>;
  /** `--field-id` 投影，可写字段 ID 或字段名；空数组表示不过滤字段。 */
  fields?: readonly string[];
  /** 每页 `--limit`，json 格式上限 200；缺省 200。 */
  page_size?: number;
}

export interface DeleteRecordsOptions {
  /** 缺省 true：只发 `--dry-run` 预览，不带高风险确认 `--yes`。 */
  dry_run?: boolean;
}

export type ListTablesResult = { ok: true; tables: LarkBaseTable[] } | LarkBaseFailure;
export type CreateTableResult = { ok: true; table_id: string } | LarkBaseFailure;
export type ListFieldsResult = { ok: true; fields: LarkBaseField[] } | LarkBaseFailure;
export type ListRecordsResult = { ok: true; records: BaseRecord[] } | LarkBaseFailure;
export type BatchCreateRecordsResult = { ok: true; record_ids: string[] } | LarkBaseFailure;
export type BatchUpdateRecordsResult = { ok: true } | LarkBaseFailure;
export type DeleteRecordsResult =
  | { ok: true; dry_run: boolean; record_ids: string[] }
  | LarkBaseFailure;

interface CommandContext {
  command: string;
  table_id?: string;
  partial_record_ids?: string[];
}

interface RecordPage {
  records: BaseRecord[];
  has_more: boolean;
  next_offset?: number;
}

/** `base +table-list`；表 id 兼容 id / table_id 两种键。 */
export async function list_tables(base: LarkBaseContext): Promise<ListTablesResult> {
  const run = await run_base_command(
    base,
    ["base", "+table-list", "--base-token", base.base_token],
    "KB_READ_FAILED",
    { command: "+table-list" },
  );
  if (!run.ok) {
    return run;
  }

  const entries = first_array(run.payload, [["data", "tables"], ["data", "items"], ["tables"]]);
  if (entries === undefined) {
    return internal_error("无法解析 base +table-list 返回的表列表。", {
      command: "+table-list",
    });
  }

  const tables: LarkBaseTable[] = [];
  for (const entry of entries) {
    const id = first_string(entry, ["id", "table_id"]);
    const name = first_string(entry, ["name", "table_name"]);
    if (id === undefined || name === undefined) {
      return internal_error("base +table-list 返回的表缺少 id 或 name。", {
        command: "+table-list",
      });
    }
    tables.push({ id, name });
  }
  return { ok: true, tables };
}

/** `base +table-create --name --fields`；首项即主字段。 */
export async function create_table(
  base: LarkBaseContext,
  name: string,
  fields: readonly LarkBaseFieldDefinition[],
): Promise<CreateTableResult> {
  if (fields.length === 0) {
    return internal_error("create_table 至少需要一个字段定义。", {
      command: "+table-create",
      field_count: fields.length,
    });
  }

  const run = await run_base_command(
    base,
    [
      "base",
      "+table-create",
      "--base-token",
      base.base_token,
      "--name",
      name,
      "--fields",
      JSON.stringify(fields),
    ],
    "KB_WRITE_FAILED",
    { command: "+table-create" },
  );
  if (!run.ok) {
    return run;
  }

  // 主路径是 data.table.id；其余是 2026-10-21 实测记录里待复核的兼容位置。
  const table_id =
    first_string(read_path(run.payload, ["data", "table"]), ["id", "table_id"]) ??
    first_string(read_path(run.payload, ["data"]), ["id", "table_id"]) ??
    first_string(read_path(run.payload, ["table"]), ["id", "table_id"]);
  if (table_id === undefined) {
    return internal_error(
      "无法解析 base +table-create 返回的新表 id（已尝试 data.table.id / data.id / data.table_id）。",
      { command: "+table-create" },
    );
  }
  return { ok: true, table_id };
}

/** `base +field-list --table-id`。 */
export async function list_fields(
  base: LarkBaseContext,
  table_id: string,
): Promise<ListFieldsResult> {
  const run = await run_base_command(
    base,
    ["base", "+field-list", "--base-token", base.base_token, "--table-id", table_id],
    "KB_READ_FAILED",
    { command: "+field-list", table_id },
  );
  if (!run.ok) {
    return run;
  }

  const entries = first_array(run.payload, [["data", "fields"], ["data", "items"], ["data"]]);
  if (entries === undefined) {
    return internal_error("无法解析 base +field-list 返回的字段列表。", {
      command: "+field-list",
      table_id,
    });
  }

  const fields: LarkBaseField[] = [];
  for (const entry of entries) {
    const name = first_string(entry, ["name", "field_name"]);
    const type = first_string(entry, ["type", "field_type"]);
    if (name === undefined || type === undefined) {
      return internal_error("base +field-list 返回的字段缺少 name 或 type。", {
        command: "+field-list",
        table_id,
      });
    }
    const id = first_string(entry, ["id", "field_id"]);
    fields.push(id === undefined ? { name, type } : { id, name, type });
  }
  return { ok: true, fields };
}

/**
 * `base +record-list --format json`，按矩阵形状拼装对象数组；自动翻页直到
 * `has_more=false`（跟随 `data.next_offset`，缺省退化为 offset + 本页行数）。
 */
export async function list_records(
  base: LarkBaseContext,
  table_id: string,
  options: ListRecordsOptions = {},
): Promise<ListRecordsResult> {
  const page_size = options.page_size ?? BASE_DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(page_size) || page_size < 1 || page_size > BASE_MAX_PAGE_SIZE) {
    return internal_error(`page_size 必须是 1..${BASE_MAX_PAGE_SIZE} 的整数。`, {
      field: "page_size",
      value: options.page_size,
    });
  }
  if (options.filter !== undefined && !is_record(options.filter)) {
    return internal_error("filter 必须是普通对象（--filter-json 的形状）。", {
      field: "filter",
    });
  }
  const filter_json = options.filter === undefined ? undefined : JSON.stringify(options.filter);
  if (options.filter !== undefined && filter_json === undefined) {
    return internal_error("filter 无法序列化成 JSON。", { field: "filter" });
  }

  const records: BaseRecord[] = [];
  let offset = 0;
  for (;;) {
    const args = ["base", "+record-list", "--base-token", base.base_token, "--table-id", table_id];
    for (const field of options.fields ?? []) {
      args.push("--field-id", field);
    }
    if (filter_json !== undefined) {
      args.push("--filter-json", filter_json);
    }
    args.push("--offset", String(offset), "--limit", String(page_size), "--format", "json");

    const run = await run_base_command(base, args, "KB_READ_FAILED", {
      command: "+record-list",
      table_id,
    });
    if (!run.ok) {
      return run;
    }
    const page = parse_record_page(run.payload, table_id);
    if ("error" in page) {
      return page;
    }
    records.push(...page.records);
    if (!page.has_more) {
      break;
    }
    const next_offset = page.next_offset ?? offset + page.records.length;
    if (page.records.length === 0 || next_offset <= offset) {
      return internal_error(
        "base +record-list 分页未推进（has_more=true 但没有新的 offset），已停止以免死循环。",
        { command: "+record-list", table_id, offset },
      );
    }
    offset = next_offset;
  }
  return { ok: true, records };
}

/**
 * `base +record-batch-create`；每条记录直接是字段映射，每 200 条一批。
 * 返回按批合并后的 record_id 列表（供上层记录旧卡对应的新记录）。
 */
export async function batch_create_records(
  base: LarkBaseContext,
  table_id: string,
  records: readonly BaseFieldMap[],
): Promise<BatchCreateRecordsResult> {
  const record_ids: string[] = [];
  for (const batch of chunk(records, BASE_BATCH_SIZE)) {
    const args = [
      "base",
      "+record-batch-create",
      "--base-token",
      base.base_token,
      "--table-id",
      table_id,
      "--json",
      JSON.stringify({ create_records: batch }),
    ];
    const run = await run_base_command(base, args, "KB_WRITE_FAILED", {
      command: "+record-batch-create",
      table_id,
      partial_record_ids: record_ids,
    });
    if (!run.ok) {
      return run;
    }
    const batch_ids = first_array(run.payload, [["data", "record_id_list"]]);
    if (batch_ids === undefined || !batch_ids.every(is_non_empty_string)) {
      return internal_error("无法解析 base +record-batch-create 返回的 record_id_list。", {
        command: "+record-batch-create",
        table_id,
        partial_record_ids: record_ids,
      });
    }
    record_ids.push(...batch_ids);
  }
  return { ok: true, record_ids };
}

/** `base +record-batch-update`；`update_records` 为 record_id → 字段映射，每 200 条一批。 */
export async function batch_update_records(
  base: LarkBaseContext,
  table_id: string,
  updates: readonly BaseRecordUpdate[],
): Promise<BatchUpdateRecordsResult> {
  const updated_record_ids: string[] = [];
  for (const batch of chunk(updates, BASE_BATCH_SIZE)) {
    const update_records: Record<string, BaseFieldMap> = {};
    for (const update of batch) {
      update_records[update.record_id] = update.fields;
    }
    const args = [
      "base",
      "+record-batch-update",
      "--base-token",
      base.base_token,
      "--table-id",
      table_id,
      "--json",
      JSON.stringify({ update_records }),
    ];
    const run = await run_base_command(base, args, "KB_WRITE_FAILED", {
      command: "+record-batch-update",
      table_id,
      partial_record_ids: updated_record_ids,
    });
    if (!run.ok) {
      return run;
    }
    updated_record_ids.push(...batch.map((update) => update.record_id));
  }
  return { ok: true };
}

/**
 * `base +record-delete`，每 200 条一批。`dry_run` 缺省 true：只带 `--dry-run`
 * 预览，不带高风险确认 `--yes`；只有 `dry_run=false` 的执行路径才携带 `--yes`。
 */
export async function delete_records(
  base: LarkBaseContext,
  table_id: string,
  record_ids: readonly string[],
  options: DeleteRecordsOptions = {},
): Promise<DeleteRecordsResult> {
  const dry_run = options.dry_run ?? true;
  const deleted: string[] = [];
  for (const batch of chunk(record_ids, BASE_BATCH_SIZE)) {
    const args = [
      "base",
      "+record-delete",
      "--base-token",
      base.base_token,
      "--table-id",
      table_id,
      "--json",
      JSON.stringify({ record_id_list: batch }),
      dry_run ? "--dry-run" : "--yes",
    ];
    const run = await run_base_command(base, args, "KB_WRITE_FAILED", {
      command: "+record-delete",
      table_id,
      partial_record_ids: deleted,
    });
    if (!run.ok) {
      return run;
    }
    const batch_ids = first_array(run.payload, [["data", "record_id_list"]]);
    if (batch_ids !== undefined && batch_ids.every(is_non_empty_string)) {
      deleted.push(...batch_ids);
    } else {
      deleted.push(...batch);
    }
  }
  return { ok: true, dry_run, record_ids: deleted };
}

async function run_base_command(
  base: LarkBaseContext,
  args: string[],
  failure_code: "KB_READ_FAILED" | "KB_WRITE_FAILED",
  context: CommandContext,
): Promise<{ ok: true; payload: unknown } | LarkBaseFailure> {
  if (base.base_token.trim() === "") {
    return internal_error("base_token 为空，无法访问知识库 B。", {
      command: context.command,
    });
  }

  const run = await run_cli(base.cli_path, args, {
    env: base.env,
    timeout_ms: base.timeout_ms,
    expect_json: true,
  });
  if (!run.ok) {
    return run;
  }
  if (run.code !== 0 || business_failed(run.json)) {
    return {
      ok: false,
      error: {
        code: failure_code,
        message: business_failure_message(run.json, run.code, context.command),
        details: failure_details(base, run, context),
      },
    };
  }
  return { ok: true, payload: run.json };
}

function business_failed(payload: unknown): boolean {
  return is_record(payload) && payload.ok === false;
}

function business_failure_message(payload: unknown, exit_code: number, command: string): string {
  if (is_record(payload)) {
    const error = payload.error;
    if (is_record(error) && typeof error.message === "string" && error.message.trim() !== "") {
      return `lark-cli ${command} 失败：${error.message}`;
    }
    if (typeof payload.message === "string" && payload.message.trim() !== "") {
      return `lark-cli ${command} 失败：${payload.message}`;
    }
  }
  return `lark-cli ${command} 失败（exit code ${exit_code}）。`;
}

function failure_details(
  base: LarkBaseContext,
  run: { code: number; stderr: string },
  context: CommandContext,
): Record<string, unknown> {
  const details: Record<string, unknown> = {
    command: context.command,
    base_token_prefix: base.base_token.slice(0, BASE_TOKEN_PREFIX_LENGTH),
    exit_code: run.code,
    stderr: truncate(run.stderr),
    stderr_truncated: run.stderr.length > STDERR_LIMIT,
  };
  if (context.table_id !== undefined) {
    details.table_id = context.table_id;
  }
  if (context.partial_record_ids !== undefined && context.partial_record_ids.length > 0) {
    details.partial_record_ids = context.partial_record_ids;
  }
  return details;
}

function parse_record_page(payload: unknown, table_id: string): RecordPage | LarkBaseFailure {
  const data = read_path(payload, ["data"]);
  const names = is_record(data) ? data.fields : undefined;
  const rows = is_record(data) ? data.data : undefined;
  const ids = is_record(data) ? data.record_id_list : undefined;

  if (!Array.isArray(names) || !names.every(is_non_empty_string)) {
    return internal_error("base +record-list 返回缺少 data.fields（字段名数组）。", {
      command: "+record-list",
      table_id,
    });
  }
  if (!Array.isArray(rows)) {
    return internal_error("base +record-list 返回缺少 data.data（行数组）。", {
      command: "+record-list",
      table_id,
    });
  }
  if (!Array.isArray(ids) || !ids.every(is_non_empty_string)) {
    return internal_error("base +record-list 返回缺少 data.record_id_list。", {
      command: "+record-list",
      table_id,
    });
  }
  if (ids.length !== rows.length) {
    return internal_error("base +record-list 的 record_id_list 与数据行数不一致。", {
      command: "+record-list",
      table_id,
      row_count: rows.length,
      record_id_count: ids.length,
    });
  }

  const records: BaseRecord[] = [];
  for (const [row_index, row] of rows.entries()) {
    if (!Array.isArray(row) || row.length > names.length) {
      return internal_error("base +record-list 的数据行与字段数不一致。", {
        command: "+record-list",
        table_id,
        row_index,
      });
    }
    const fields: BaseFieldMap = {};
    for (const [column_index, name] of names.entries()) {
      const cell = row[column_index];
      fields[name] = cell === undefined ? null : (cell as BaseCellValue);
    }
    records.push({ record_id: ids[row_index] as string, fields });
  }

  const has_more = is_record(data) && data.has_more === true;
  const raw_next_offset = is_record(data) ? data.next_offset : undefined;
  const next_offset =
    typeof raw_next_offset === "number" && Number.isInteger(raw_next_offset)
      ? raw_next_offset
      : undefined;
  return next_offset === undefined
    ? { records, has_more }
    : { records, has_more, next_offset };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function read_path(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!is_record(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function first_array(
  value: unknown,
  paths: ReadonlyArray<readonly string[]>,
): unknown[] | undefined {
  for (const path of paths) {
    const candidate = read_path(value, path);
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function first_string(value: unknown, keys: readonly string[]): string | undefined {
  if (!is_record(value)) {
    return undefined;
  }
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate.trim();
    }
  }
  return undefined;
}

function internal_error(
  message: string,
  details: Record<string, unknown> = {},
): LarkBaseFailure {
  return { ok: false, error: { code: "INTERNAL", message, details } };
}

function truncate(text: string, limit = STDERR_LIMIT): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function is_non_empty_string(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
