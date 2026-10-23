import path from "node:path";
import { from_base_record, type SyncState } from "../base_mapping.js";
import { CONFIG_FILE_NAME, load_config, resolve_home } from "../config.js";
import {
  list_records,
  type LarkBaseContext,
} from "../lark_base.js";
import { resolve_lark_cli, type LarkCliErrorCode } from "../lark_cli.js";

/**
 * `read_sync_state` 工具（架构 §5.3、§6.2、§8）。
 *
 * - 只读：`base +record-list --format json`（经 `lark_base.list_records` 自动翻页）。
 * - 每行按 Task 1 的 Base 映射还原成逻辑 `SyncState`，并带上 Base `record_id`
 *   （后续更新/删除 SyncState 需要记录 ID）。
 * - `list_records` 的 `ListedRecord` 已保证非空 `record_id`，这里直接收紧到
 *   `SyncStateRecord`。
 * - 返回值一律是结果对象，不抛异常。
 */

export interface SyncStateRecord extends SyncState {
  record_id: string;
}

export type ReadSyncStateErrorCode =
  | LarkCliErrorCode
  | "CONFIG_INVALID"
  | "CONFIG_MISSING"
  | "KB_READ_FAILED"
  | "SYNC_STATE_INVALID";

export interface ReadSyncStateInput {
  /** 默认 process.env；测试可注入受控环境。 */
  env?: NodeJS.ProcessEnv;
  /** 默认 os.homedir()；用于 lark-cli 常见安装目录探测。 */
  home_dir?: string;
}

export interface ReadSyncStateSuccess {
  records: SyncStateRecord[];
}

export interface ReadSyncStateFailure {
  ok: false;
  error: {
    code: ReadSyncStateErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type ReadSyncStateResult = ReadSyncStateSuccess | ReadSyncStateFailure;

export async function read_sync_state(
  input: ReadSyncStateInput = {},
): Promise<ReadSyncStateResult> {
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
    return failure("CONFIG_INVALID", "配置缺少 lark.base_b，无法读取 SyncState。", {
      field: "lark.base_b",
      path: config_path,
    });
  }
  const table_id = config.lark.sync_state_table_id;
  if (!has_text(table_id)) {
    return failure("CONFIG_INVALID", "配置缺少 lark.sync_state_table_id，无法读取 SyncState。", {
      field: "lark.sync_state_table_id",
      path: config_path,
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
  const listed = await list_records(base, table_id);
  if (!listed.ok) {
    // 归一到读语义：本工具只做读操作，不把 LarkBaseErrorCode 的写失败码透出去。
    return {
      ok: false,
      error: {
        code: listed.error.code === "KB_WRITE_FAILED" ? "KB_READ_FAILED" : listed.error.code,
        message: listed.error.message,
        ...(listed.error.details === undefined ? {} : { details: listed.error.details }),
      },
    };
  }

  const records: SyncStateRecord[] = [];
  for (const [row, record] of listed.records.entries()) {
    if (!("obj_edit_time" in record.fields)) {
      return failure(
        "SYNC_STATE_INVALID",
        `SyncState 第 ${row + 1} 行缺少 obj_edit_time 字段；` +
          `请检查 lark.sync_state_table_id 是否指向 SyncState 表。`,
        { row, table_id },
      );
    }

    let state: SyncState;
    try {
      state = from_base_record(record) as SyncState;
    } catch (error) {
      return failure(
        "SYNC_STATE_INVALID",
        `SyncState 第 ${row + 1} 行无法按 Base 映射还原：${describe_error(error)}。`,
        { row, table_id },
      );
    }
    records.push({ ...state, record_id: record.record_id.trim() });
  }

  return { records };
}

function failure(
  code: ReadSyncStateErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ReadSyncStateFailure {
  return {
    ok: false,
    error: details === undefined ? { code, message } : { code, message, details },
  };
}

function has_text(value: string | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function describe_error(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
