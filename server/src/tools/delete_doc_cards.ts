import path from "node:path";
import { CONFIG_FILE_NAME, load_config, resolve_home } from "../config.js";
import {
  delete_records,
  list_records,
  type LarkBaseContext,
  type LarkBaseFailure,
} from "../lark_base.js";
import { resolve_lark_cli, type LarkCliErrorCode } from "../lark_cli.js";

/**
 * `delete_doc_cards` MCP Tool（架构 §6.2 第 8 步、§8）。
 *
 * - 删除一个来源文档在 AI 库中的全部知识卡与它的 SyncState 记录（先卡片、后状态）。
 * - 现有记录只按 `source_doc_token` 字段本地过滤（与 read_sync_state 一致，不用
 *   `--filter-json`）；记录不存在时直接返回 0，不发删除调用，重复删除幂等。
 * - `dry_run` 缺省 true：走 `base +record-delete --dry-run` 预览；只有 `dry_run=false`
 *   的执行路径才带高风险确认 `--yes`。
 * - 删除分块（每 200 条一批）与 `--yes` / `--dry-run` 的选择由 `lark_base.delete_records`
 *   统一负责。
 * - 返回值一律是结果对象，不抛异常；错误码为 SCREAMING_SNAKE。
 */

export type DeleteDocCardsErrorCode =
  | LarkCliErrorCode
  | "CONFIG_INVALID"
  | "CONFIG_MISSING"
  | "KB_READ_FAILED"
  | "KB_WRITE_FAILED"
  | "INTERNAL";

export interface DeleteDocCardsInput {
  /** 要删除知识卡与 SyncState 的原始库文档 token。 */
  source_doc_token: string;
  /** 缺省 true：只预览，不带 `--yes`，不真正删除。 */
  dry_run?: unknown;
  /** 默认 process.env；测试可注入受控环境。 */
  env?: NodeJS.ProcessEnv;
  /** 默认 os.homedir()；用于 lark-cli 常见安装目录探测。 */
  home_dir?: string;
}

export interface DeleteDocCardsSuccess {
  dry_run: boolean;
  /** 已删除（dry-run 时为计划删除）的知识卡记录数。 */
  deleted_cards: number;
  /** 已删除（dry-run 时为计划删除）的 SyncState 记录数，0 或 1。 */
  deleted_state: number;
}

export interface DeleteDocCardsFailure {
  ok: false;
  error: {
    code: DeleteDocCardsErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type DeleteDocCardsResult = DeleteDocCardsSuccess | DeleteDocCardsFailure;

export async function delete_doc_cards(
  input: DeleteDocCardsInput,
): Promise<DeleteDocCardsResult> {
  const source_doc_token =
    typeof input?.source_doc_token === "string" ? input.source_doc_token.trim() : "";
  if (source_doc_token === "") {
    return failure("CONFIG_INVALID", '输入字段 "source_doc_token" 期望非空字符串。', {
      field: "source_doc_token",
    });
  }

  const dry_run_parsed = parse_dry_run(input.dry_run);
  if ("error" in dry_run_parsed) {
    return dry_run_parsed;
  }
  const dry_run = dry_run_parsed.value;

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
    return failure("CONFIG_INVALID", "配置缺少 lark.base_b，无法删除知识卡。", {
      field: "lark.base_b",
      path: config_path,
    });
  }
  const cards_table_id = config.lark.knowledge_cards_table_id;
  if (!has_text(cards_table_id)) {
    return failure(
      "CONFIG_INVALID",
      "配置缺少 lark.knowledge_cards_table_id，无法删除知识卡；请先运行 $setup 或 init_knowledge_b。",
      { field: "lark.knowledge_cards_table_id", path: config_path },
    );
  }
  const state_table_id = config.lark.sync_state_table_id;
  if (!has_text(state_table_id)) {
    return failure(
      "CONFIG_INVALID",
      "配置缺少 lark.sync_state_table_id，无法删除 SyncState；请先运行 $setup 或 init_knowledge_b。",
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

  const card_ids = await list_record_ids_for_token(base, cards_table_id, source_doc_token);
  if ("error" in card_ids) {
    return card_ids;
  }
  const state_ids = await list_record_ids_for_token(base, state_table_id, source_doc_token);
  if ("error" in state_ids) {
    return state_ids;
  }

  // 记录不存在：不发删除调用，直接返回幂等结果。
  if (card_ids.record_ids.length === 0 && state_ids.record_ids.length === 0) {
    return { dry_run, deleted_cards: 0, deleted_state: 0 };
  }

  const deleted_cards = await delete_ids(
    base,
    cards_table_id,
    "knowledge_cards",
    card_ids.record_ids,
    dry_run,
    0,
  );
  if ("error" in deleted_cards) {
    return deleted_cards;
  }
  const deleted_state = await delete_ids(
    base,
    state_table_id,
    "sync_state",
    state_ids.record_ids,
    dry_run,
    deleted_cards.count,
  );
  if ("error" in deleted_state) {
    return deleted_state;
  }
  return { dry_run, deleted_cards: deleted_cards.count, deleted_state: deleted_state.count };
}

function parse_dry_run(value: unknown): { value: boolean } | DeleteDocCardsFailure {
  if (value === undefined) {
    return { value: true };
  }
  if (typeof value !== "boolean") {
    return failure("CONFIG_INVALID", '输入字段 "dry_run" 期望布尔值。', { field: "dry_run" });
  }
  return { value };
}

async function list_record_ids_for_token(
  base: LarkBaseContext,
  table_id: string,
  source_doc_token: string,
): Promise<{ record_ids: string[] } | DeleteDocCardsFailure> {
  const listed = await list_records(base, table_id);
  if (!listed.ok) {
    return listed;
  }
  const record_ids: string[] = [];
  for (const [row, record] of listed.records.entries()) {
    if (record.fields.source_doc_token !== source_doc_token) {
      continue;
    }
    const record_id = record.record_id;
    if (!has_text(record_id)) {
      return failure("INTERNAL", `AI 库第 ${row + 1} 行缺少 Base record_id，无法删除。`, {
        row,
        table_id,
      });
    }
    record_ids.push(record_id.trim());
  }
  return { record_ids };
}

/**
 * 删除一组 record_id。空集合表示「没有要删的记录」，直接返回 0 且不发 CLI 调用。
 * 失败时在 details 中列明已删除（前序批次）与本批目标的进度。
 */
async function delete_ids(
  base: LarkBaseContext,
  table_id: string,
  stage: "knowledge_cards" | "sync_state",
  record_ids: readonly string[],
  dry_run: boolean,
  deleted_cards_so_far: number,
): Promise<{ count: number } | DeleteDocCardsFailure> {
  if (record_ids.length === 0) {
    return { count: 0 };
  }
  const result = await delete_records(base, table_id, record_ids, { dry_run });
  if (!result.ok) {
    return stage_failure(result, table_id, stage, deleted_cards_so_far);
  }
  return { count: result.record_ids.length };
}

function stage_failure(
  failure_result: LarkBaseFailure,
  table_id: string,
  stage: "knowledge_cards" | "sync_state",
  deleted_cards_so_far: number,
): DeleteDocCardsFailure {
  return {
    ok: false,
    error: {
      ...failure_result.error,
      message: `删除文档记录失败（表 ${table_id}）：${failure_result.error.message}`,
      details: {
        ...(failure_result.error.details ?? {}),
        stage,
        deleted_cards: deleted_cards_so_far,
      },
    },
  };
}

function failure(
  code: DeleteDocCardsErrorCode,
  message: string,
  details?: Record<string, unknown>,
): DeleteDocCardsFailure {
  return {
    ok: false,
    error: details === undefined ? { code, message } : { code, message, details },
  };
}

function has_text(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
