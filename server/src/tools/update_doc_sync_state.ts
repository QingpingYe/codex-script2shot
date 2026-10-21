import path from "node:path";
import { to_base_fields, type BaseRecord, type SyncState } from "../base_mapping.js";
import { CONFIG_FILE_NAME, load_config, resolve_home } from "../config.js";
import {
  batch_create_records,
  batch_update_records,
  list_records,
  type LarkBaseContext,
} from "../lark_base.js";
import { resolve_lark_cli, type LarkCliErrorCode } from "../lark_cli.js";
import { validate_sync_state } from "../schemas.js";

/**
 * `update_doc_sync_state` MCP Tool（架构 §6.3、§8）。
 *
 * - 按 `source_doc_token` upsert：SyncState 表中已有该 token 的记录 ⇒
 *   `batch_update_records`（action=updated）；没有 ⇒ `batch_create_records`
 *   （action=created）。不做整表重写，也不碰其他文档的状态。
 * - 现有记录只按 `source_doc_token` 字段本地过滤（与 read_sync_state 一致，不用
 *   `--filter-json`）。同一 token 出现多条记录时报 `UPSTREAM_INVALID`，不猜其中一条。
 * - 输入按 `sync_state.schema.json` 校验；`read_sync_state` 回读记录携带的
 *   `record_id` 会在校验前剥离（upsert 只认 `source_doc_token`）。
 * - 本工具不提供 dry-run：执行顺序由 Skill 编排固定为
 *   `replace_doc_cards` 成功后调用，替换失败时不得调用。
 * - 返回值一律是结果对象，不抛异常；错误码为 SCREAMING_SNAKE。
 */

export type UpdateDocSyncStateErrorCode =
  | LarkCliErrorCode
  | "CONFIG_INVALID"
  | "CONFIG_MISSING"
  | "SCHEMA_INVALID"
  | "KB_READ_FAILED"
  | "KB_WRITE_FAILED"
  | "UPSTREAM_INVALID"
  | "INTERNAL";

export type UpdateDocSyncStateAction = "created" | "updated";

export interface UpdateDocSyncStateInput {
  /** SyncState 逻辑记录；可携带 read_sync_state 回读的 record_id（upsert 时忽略）。 */
  record: SyncState & { record_id?: string };
  /** 默认 process.env；测试可注入受控环境。 */
  env?: NodeJS.ProcessEnv;
  /** 默认 os.homedir()；用于 lark-cli 常见安装目录探测。 */
  home_dir?: string;
}

export interface UpdateDocSyncStateSuccess {
  record_id: string;
  action: UpdateDocSyncStateAction;
}

export interface UpdateDocSyncStateFailure {
  ok: false;
  error: {
    code: UpdateDocSyncStateErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type UpdateDocSyncStateResult = UpdateDocSyncStateSuccess | UpdateDocSyncStateFailure;

export async function update_doc_sync_state(
  input: UpdateDocSyncStateInput,
): Promise<UpdateDocSyncStateResult> {
  const candidate: unknown = input?.record;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return failure("CONFIG_INVALID", '输入字段 "record" 期望 SyncState 对象。', {
      field: "record",
    });
  }

  // read_sync_state 的回读记录带 record_id；upsert 只按 source_doc_token，先剥离再校验。
  const { record_id: _ignored_record_id, ...record } = candidate as SyncState & {
    record_id?: string;
  };
  const validated = validate_sync_state(record);
  if (!validated.ok) {
    return failure("SCHEMA_INVALID", "输入 record 不符合 SyncState schema。", {
      field: "record",
      errors: validated.errors,
    });
  }
  const state = record as SyncState;

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
  const config = loaded.config;
  const config_path = path.join(resolve_home(), CONFIG_FILE_NAME);
  const base_b = config.lark.base_b;
  if (!has_text(base_b)) {
    return failure("CONFIG_INVALID", "配置缺少 lark.base_b，无法更新 SyncState。", {
      field: "lark.base_b",
      path: config_path,
    });
  }
  const table_id = config.lark.sync_state_table_id;
  if (!has_text(table_id)) {
    return failure(
      "CONFIG_INVALID",
      "配置缺少 lark.sync_state_table_id，无法更新 SyncState；请先运行 $setup 或 init_knowledge_b。",
      { field: "lark.sync_state_table_id", path: config_path },
    );
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

  const listed = await list_records(base, table_id);
  if (!listed.ok) {
    return listed;
  }
  const matched = find_records_by_token(listed.records, state.source_doc_token);
  if (matched.length > 1) {
    return failure(
      "UPSTREAM_INVALID",
      `SyncState 表中 source_doc_token=${state.source_doc_token} 有多条记录（${matched.length} 条），` +
        `无法确定更新哪一条；请人工清理重复记录后重试。`,
      { table_id, record_ids: matched.map((record) => record.record_id) },
    );
  }

  const fields = to_base_fields(state);
  if (matched.length === 1) {
    const existing_record_id = matched[0].record_id;
    if (!has_text(existing_record_id)) {
      return failure("INTERNAL", "命中的 SyncState 记录缺少 Base record_id，无法更新。", {
        table_id,
      });
    }
    const updated = await batch_update_records(base, table_id, [
      { record_id: existing_record_id, fields },
    ]);
    if (!updated.ok) {
      return updated;
    }
    return { record_id: existing_record_id, action: "updated" };
  }

  const created = await batch_create_records(base, table_id, [fields]);
  if (!created.ok) {
    return created;
  }
  const record_id = created.record_ids[0];
  if (!has_text(record_id)) {
    return failure("INTERNAL", "写入 SyncState 后未解析到 Base record_id。", { table_id });
  }
  return { record_id, action: "created" };
}

function find_records_by_token(
  records: readonly BaseRecord[],
  source_doc_token: string,
): BaseRecord[] {
  return records.filter((record) => record.fields.source_doc_token === source_doc_token);
}

function failure(
  code: UpdateDocSyncStateErrorCode,
  message: string,
  details?: Record<string, unknown>,
): UpdateDocSyncStateFailure {
  return {
    ok: false,
    error: details === undefined ? { code, message } : { code, message, details },
  };
}

function has_text(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
