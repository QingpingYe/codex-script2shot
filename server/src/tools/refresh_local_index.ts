import { rmSync } from "node:fs";
import path from "node:path";
import { from_base_record, type KnowledgeCard } from "../base_mapping.js";
import {
  cache_file_path,
  load_cache,
  remove_doc,
  save_cache,
  set_doc,
  type DocMarker,
  type LocalCardCache,
} from "../cache.js";
import { CONFIG_FILE_NAME, load_config, resolve_home } from "../config.js";
import {
  delete_doc_rows,
  index_file_path,
  index_status,
  open_index,
  replace_doc_rows,
  type IndexStatus,
} from "../index_store.js";
import { list_records, type LarkBaseContext } from "../lark_base.js";
import { resolve_lark_cli } from "../lark_cli.js";
import {
  read_sync_state,
  type ReadSyncStateErrorCode,
  type SyncStateRecord,
} from "./read_sync_state.js";

/**
 * `refresh_local_index` MCP Tool（架构 §7.4、§8、§9.3、§13；Task 3 简报）。
 *
 * 算法（架构 §7.4；B 的 SyncState 是唯一权威同步状态，§2.4）：
 * 1. 读 B 的 SyncState 全表，与本地缓存标记逐文档比较 `source_revision` 与
 *    `last_synced_at`；本地缓存没有该 token 的条目视为新增。
 * 2. 只对变化文档发 `base +record-list --filter-json { logic, conditions }`
 *    （按 `source_doc_token` 等值过滤）拉取知识卡；全部取卡成功后才进入写阶段，
 *    任何一次取卡失败都保持本地状态原样（简报：不做单文档容错）。
 * 3. 写阶段只更新变化文档的缓存与索引行；本地存在但 SyncState 已不存在的文档
 *    从缓存与索引中删除。
 * 4. 缓存损坏（`rebuild_needed`）时把本地状态视为空：所有 B 文档都按新增处理；
 *    索引缺失或损坏时也整体重建。索引是 B 的派生临时数据（§7.4），重建前直接删除
 *    旧索引文件：既避免残留旧行，也绕开 Windows 上无法用 rename 覆盖损坏文件的问题。
 *
 * `dry_run` 缺省 true（写操作先 dry-run 的全局约定）：只读 B 并算出同样的清单，
 * 不写缓存、不打开/创建索引、不建目录。B 不可达（`KB_B_UNREACHABLE` /
 * `read_sync_state` 归一化后的 `KB_READ_FAILED`）时：有可用缓存则
 * `degraded: true` + warning 继续；没有可用缓存则返回 `KB_B_UNREACHABLE` 错误。
 * 其余 `read_sync_state` 失败码原样传播，不伪装成降级。
 *
 * 返回值一律是结果对象，不抛异常；错误码为 SCREAMING_SNAKE，与 Phase 2 工具一致。
 */

export type RefreshReason = "added" | "updated";

/** 本次刷新过的文档：token、当前卡片数、原因（新增 / 标记变化）。 */
export interface RefreshedDoc {
  source_doc_token: string;
  card_count: number;
  reason: RefreshReason;
}

export interface RefreshWarning {
  code: string;
  message: string;
  refs?: string[];
}

export interface RefreshLocalIndexSuccess {
  dry_run: boolean;
  refreshed_docs: RefreshedDoc[];
  removed_docs: string[];
  unchanged_docs: string[];
  /** 本次运行结束时的索引状态（dry run 为运行前的状态）。 */
  index_status: IndexStatus;
  /** 只有「B 不可达但有缓存」时为 true。 */
  degraded: boolean;
  warnings: RefreshWarning[];
}

export type RefreshLocalIndexErrorCode =
  | ReadSyncStateErrorCode
  | "KB_B_UNREACHABLE"
  | "INDEX_UNAVAILABLE"
  | "INTERNAL";

export interface RefreshLocalIndexFailure {
  ok: false;
  error: {
    code: RefreshLocalIndexErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type RefreshLocalIndexResult = RefreshLocalIndexSuccess | RefreshLocalIndexFailure;

export interface RefreshLocalIndexInput {
  /** 缺省 true：只读取并计算，不写缓存、不建索引。 */
  dry_run?: unknown;
  /** 默认 process.env；测试可注入受控环境。 */
  env?: NodeJS.ProcessEnv;
  /** 默认 os.homedir()；用于 lark-cli 常见安装目录探测。 */
  home_dir?: string;
}

/** `read_sync_state` 里等价于「知识库 B 不可达」的失败码。 */
const KB_B_UNREACHABLE_CODES: readonly string[] = ["KB_B_UNREACHABLE", "KB_READ_FAILED"];

export async function refresh_local_index(
  input: RefreshLocalIndexInput = {},
): Promise<RefreshLocalIndexResult> {
  const dry_run_parsed = parse_dry_run(input?.dry_run);
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
    return failure("CONFIG_INVALID", "配置缺少 lark.base_b，无法刷新本地索引。", {
      field: "lark.base_b",
      path: config_path,
    });
  }
  const cards_table_id = config.lark.knowledge_cards_table_id;
  if (!has_text(cards_table_id)) {
    return failure(
      "CONFIG_INVALID",
      "配置缺少 lark.knowledge_cards_table_id，无法拉取知识卡；请先运行 $setup 或 init_knowledge_b。",
      { field: "lark.knowledge_cards_table_id", path: config_path },
    );
  }

  const cache = load_cache();
  const cache_rebuild_needed = cache.rebuild_needed === true;
  const warnings: RefreshWarning[] = cache.warnings.map((warning) =>
    warning.refs === undefined
      ? { code: warning.code, message: warning.message }
      : { code: warning.code, message: warning.message, refs: [...warning.refs] },
  );
  const index_path = index_file_path();
  const index_before = index_status(index_path);

  const sync = await read_sync_state({ env: input.env, home_dir: input.home_dir });
  if (!("records" in sync)) {
    if (KB_B_UNREACHABLE_CODES.includes(sync.error.code)) {
      const usable_cache = !cache_rebuild_needed && Object.keys(cache.docs).length > 0;
      if (!usable_cache) {
        return failure(
          "KB_B_UNREACHABLE",
          `知识库 B 不可达，且本地没有可用缓存：${sync.error.message}`,
          { cause: sync.error.code },
        );
      }
      warnings.push({
        code: "KB_B_UNREACHABLE",
        message: `知识库 B 不可达，已按本地缓存继续：${sync.error.message}`,
      });
      return {
        dry_run,
        refreshed_docs: [],
        removed_docs: [],
        unchanged_docs: Object.keys(cache.docs).sort(),
        index_status: index_before,
        degraded: true,
        warnings,
      };
    }
    return failure(sync.error.code, sync.error.message, sync.error.details);
  }

  const state_by_token = new Map<string, SyncStateRecord>();
  for (const [row, record] of sync.records.entries()) {
    const token = record.source_doc_token;
    if (!has_text(token)) {
      return failure("SYNC_STATE_INVALID", `SyncState 第 ${row + 1} 行缺少 source_doc_token。`, {
        row,
      });
    }
    if (state_by_token.has(token)) {
      return failure(
        "SYNC_STATE_INVALID",
        `SyncState 第 ${row + 1} 行的 source_doc_token 与前面的行重复，无法确定权威标记。`,
        { row, source_doc_token: token },
      );
    }
    state_by_token.set(token, record);
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

  const changed: Array<{ token: string; record: SyncStateRecord; reason: RefreshReason }> = [];
  const unchanged: string[] = [];
  const removed: string[] = [];
  for (const token of [...state_by_token.keys()].sort()) {
    const record = state_by_token.get(token) as SyncStateRecord;
    const local = cache.docs[token];
    if (local === undefined) {
      changed.push({ token, record, reason: "added" });
      continue;
    }
    if (
      local.source_revision === record.source_revision &&
      local.last_synced_at === record.last_synced_at
    ) {
      unchanged.push(token);
      continue;
    }
    changed.push({ token, record, reason: "updated" });
  }
  for (const token of Object.keys(cache.docs).sort()) {
    if (!state_by_token.has(token)) {
      removed.push(token);
    }
  }

  // 先取全部变化文档的卡片；任何一次失败都在写盘之前返回，本地状态保持不变。
  const fetched: Array<{
    token: string;
    record: SyncStateRecord;
    reason: RefreshReason;
    cards: KnowledgeCard[];
  }> = [];
  for (const entry of changed) {
    const listed = await list_records(base, cards_table_id, {
      filter: source_doc_filter(entry.token),
    });
    if (!listed.ok) {
      return failure(
        listed.error.code === "KB_WRITE_FAILED" ? "KB_READ_FAILED" : listed.error.code,
        listed.error.message,
        listed.error.details,
      );
    }
    const cards: KnowledgeCard[] = [];
    for (const [row, record] of listed.records.entries()) {
      let card: KnowledgeCard;
      try {
        card = from_base_record(record) as KnowledgeCard;
      } catch (error) {
        return failure(
          "KB_READ_FAILED",
          `文档 ${entry.token} 的第 ${row + 1} 条知识卡无法按 Base 映射还原：` +
            `${describe_error(error)}。`,
          { source_doc_token: entry.token, row },
        );
      }
      // 过滤条件若被忽略（例如 CLI 不支持该 filter），这里 fail-closed，
      // 避免把别的文档的卡片写进这个 token。
      if (card.source_doc_token !== entry.token) {
        return failure(
          "KB_READ_FAILED",
          `文档 ${entry.token} 的知识卡返回了其它 source_doc_token，已停止以免写错归属。`,
          { source_doc_token: entry.token, row, card_source_doc_token: card.source_doc_token },
        );
      }
      cards.push(card);
    }
    fetched.push({ ...entry, cards });
  }

  const refreshed_docs: RefreshedDoc[] = fetched.map((entry) => ({
    source_doc_token: entry.token,
    card_count: entry.cards.length,
    reason: entry.reason,
  }));

  if (dry_run) {
    return {
      dry_run: true,
      refreshed_docs,
      removed_docs: removed,
      unchanged_docs: unchanged,
      index_status: index_before,
      degraded: false,
      warnings,
    };
  }

  const rebuild_index = cache_rebuild_needed || index_before.state !== "ready";
  if (!rebuild_index && fetched.length === 0 && removed.length === 0) {
    return {
      dry_run: false,
      refreshed_docs,
      removed_docs: removed,
      unchanged_docs: unchanged,
      index_status: index_before,
      degraded: false,
      warnings,
    };
  }

  if (rebuild_index) {
    // 索引是 B 的派生临时数据：重建时从干净文件开始（旧文件可能损坏或残留旧行）。
    const remove_error = remove_index_file(index_path);
    if (remove_error !== undefined) {
      return failure(
        "INDEX_UNAVAILABLE",
        `旧的本地索引文件无法删除，已放弃本次重建：${remove_error}。`,
        { path: index_path, cleanup_failed: true },
      );
    }
  }
  try {
    const db = open_index(index_path);
    try {
      for (const entry of fetched) {
        replace_doc_rows(db, entry.token, entry.cards, state_marker(entry.record));
      }
      if (rebuild_index && !cache_rebuild_needed) {
        for (const token of unchanged) {
          const local = cache.docs[token];
          if (local !== undefined) {
            replace_doc_rows(db, token, local.cards, {
              source_revision: local.source_revision,
              last_synced_at: local.last_synced_at,
            });
          }
        }
      }
      for (const token of removed) {
        delete_doc_rows(db, token);
      }
    } finally {
      db.close();
    }
  } catch (error) {
    // 不留半截索引：检索若读到最后一次失败的中间状态会给出错误结果，删掉更安全。
    const cleanup_error = remove_index_file(index_path);
    if (cleanup_error !== undefined) {
      return failure(
        "INDEX_UNAVAILABLE",
        `本地索引写入失败：${describe_error(error)}；且不完整的索引文件无法删除：` +
          `${cleanup_error}。`,
        { path: index_path, cleanup_failed: true },
      );
    }
    return failure(
      "INDEX_UNAVAILABLE",
      `本地索引写入失败，已删除不完整的索引文件：${describe_error(error)}。`,
      { path: index_path, cleanup_failed: false },
    );
  }

  // 先索引后缓存：索引写失败时缓存标记保持原样，下次运行会重试这些文档。
  const next_cache: LocalCardCache = { version: cache.version, docs: cache.docs };
  for (const entry of fetched) {
    set_doc(next_cache, entry.token, state_marker(entry.record), entry.cards);
  }
  for (const token of removed) {
    remove_doc(next_cache, token);
  }
  try {
    save_cache(next_cache);
  } catch (error) {
    return failure("INTERNAL", `本地缓存写入失败：${describe_error(error)}。`, {
      path: cache_file_path(),
    });
  }

  return {
    dry_run: false,
    refreshed_docs,
    removed_docs: removed,
    unchanged_docs: unchanged,
    index_status: index_status(index_path),
    degraded: false,
    warnings,
  };
}

/** `--filter-json` 的过滤对象；形状与 `lark_base.list_records` 的既有用法一致。 */
function source_doc_filter(token: string): Record<string, unknown> {
  return { logic: "and", conditions: [["source_doc_token", "==", token]] };
}

/**
 * 删除索引文件（重建前清理旧文件、写失败后清理半成品）。删除失败时返回错误
 * 描述而不是抛出：Windows 上被其它进程占用或权限异常的索引文件会让 `rmSync`
 * 抛 EBUSY/EPERM，调用方必须把它转成结构化结果，不能让它逃出工具契约。
 */
function remove_index_file(file_path: string): string | undefined {
  try {
    rmSync(file_path, { force: true });
    return undefined;
  } catch (error) {
    return describe_error(error);
  }
}

function state_marker(record: SyncStateRecord): DocMarker {
  return { source_revision: record.source_revision, last_synced_at: record.last_synced_at };
}

function parse_dry_run(raw: unknown): { ok: true; value: boolean } | RefreshLocalIndexFailure {
  if (raw === undefined) {
    return { ok: true, value: true };
  }
  if (typeof raw !== "boolean") {
    return failure("CONFIG_INVALID", '入参字段 "dry_run" 期望布尔值。', { field: "dry_run" });
  }
  return { ok: true, value: raw };
}

function failure(
  code: RefreshLocalIndexErrorCode,
  message: string,
  details?: Record<string, unknown>,
): RefreshLocalIndexFailure {
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
