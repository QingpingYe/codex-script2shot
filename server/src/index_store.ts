import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { KnowledgeCard } from "./base_mapping.js";
import type { DocMarker } from "./cache.js";
import { resolve_home } from "./config.js";
import { normalize_text } from "./normalize.js";

/**
 * 本地关键词索引（架构 §7.1、§7.2、§7.4；Task 2 简报）。
 *
 * - 索引文件固定为 `<home>/index/knowledge.sqlite`（Node 内置 `node:sqlite`，
 *   不引入原生模块）。`open_index()` 自己创建 `index/` 目录，不假设 setup 跑过。
 * - `cards` 保留原始 title/content，同时写入 `title_norm`/`content_norm`
 *   （统一走 `normalize_text`）；`tags`/`entities`/`target_models` 存 JSON 文本数组。
 * - 索引只是知识库 B 的派生物：`replace_doc_rows` 按文档整体替换，单事务内
 *   完成「删旧行 -> 插新行 -> upsert doc_state」，失败整体回滚。
 * - `index_status()` 按路径**只读**探测：文件缺失返回 missing；存在但不是普通文件、
 *   0 字节、打不开或缺少 `cards` 表时返回 corrupt；其余返回 ready。绝不抛异常、
 *   不凭空创建文件、不执行任何 DDL（health 与 `refresh_local_index` 的 dry run
 *   依赖「探测不写入」这一保证；schema 保证只由写路径的 `open_index()` 负责）。
 */

export const INDEX_DIR_NAME = "index";
export const INDEX_FILE_NAME = "knowledge.sqlite";

const CREATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cards (
  card_id TEXT PRIMARY KEY,
  source_doc_token TEXT NOT NULL,
  scope TEXT,
  project_id TEXT,
  category TEXT,
  title TEXT,
  title_norm TEXT,
  content TEXT,
  content_norm TEXT,
  tags_json TEXT,
  entities_json TEXT,
  target_models_json TEXT,
  priority INTEGER,
  updated_at TEXT,
  source_path TEXT,
  source_revision INTEGER,
  last_synced_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cards_scope_project_category
  ON cards (scope, project_id, category);
CREATE TABLE IF NOT EXISTS doc_state (
  source_doc_token TEXT PRIMARY KEY,
  source_revision INTEGER,
  last_synced_at TEXT
);
`;

const INSERT_CARD_SQL = `
INSERT INTO cards (
  card_id, source_doc_token, scope, project_id, category, title, title_norm,
  content, content_norm, tags_json, entities_json, target_models_json,
  priority, updated_at, source_path, source_revision, last_synced_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const UPSERT_DOC_STATE_SQL = `
INSERT INTO doc_state (source_doc_token, source_revision, last_synced_at)
VALUES (?, ?, ?)
ON CONFLICT(source_doc_token) DO UPDATE SET
  source_revision = excluded.source_revision,
  last_synced_at = excluded.last_synced_at
`;

export type IndexState = "ready" | "missing" | "corrupt";

/** `index_status()` 的返回值；missing/corrupt 时 `card_count` 固定为 0。 */
export interface IndexStatus {
  state: IndexState;
  card_count: number;
}

/** `list_doc_markers()` 的条目：doc_state 行 + 主键 token。 */
export interface DocStateMarker extends DocMarker {
  source_doc_token: string;
}

/** 索引文件路径：`<home>/index/knowledge.sqlite`（home 由 `resolve_home()` 解析）。 */
export function index_file_path(): string {
  return path.join(resolve_home(), INDEX_DIR_NAME, INDEX_FILE_NAME);
}

/**
 * 打开索引数据库并确保 schema 存在。缺省路径为 `index_file_path()`；
 * 文件或父目录不存在时自动创建。文件是空字节按空库处理；非 SQLite 文件
 * 在首次执行 DDL 时抛错（调用方可用 `index_status()` 先做无异常探测）。
 */
export function open_index(file_path: string = index_file_path()): DatabaseSync {
  mkdirSync(path.dirname(file_path), { recursive: true });
  const db = new DatabaseSync(file_path);
  try {
    db.exec(CREATE_SCHEMA_SQL);
  } catch (error) {
    close_quietly(db);
    throw error;
  }
  return db;
}

/**
 * 按文档整体替换索引行：单事务内删除该 token 的旧行、插入新行、upsert
 * `doc_state`。任何一步失败整次回滚，旧索引与旧标记保持原样。
 * `cards[].source_doc_token` 不参与写入，行的归属统一取 `source_doc_token` 参数。
 */
export function replace_doc_rows(
  db: DatabaseSync,
  source_doc_token: string,
  cards: readonly KnowledgeCard[],
  marker: DocMarker,
): void {
  const delete_cards = db.prepare("DELETE FROM cards WHERE source_doc_token = ?");
  const insert_card = db.prepare(INSERT_CARD_SQL);
  const upsert_state = db.prepare(UPSERT_DOC_STATE_SQL);

  transaction(db, () => {
    delete_cards.run(source_doc_token);
    for (const card of cards) {
      insert_card.run(
        card.card_id,
        source_doc_token,
        card.scope,
        card.project_id,
        card.category,
        card.title,
        normalize_text(card.title),
        card.content,
        normalize_text(card.content),
        JSON.stringify(card.tags),
        JSON.stringify(card.entities),
        JSON.stringify(card.target_models),
        card.priority,
        card.updated_at,
        card.source_path,
        card.source_revision,
        marker.last_synced_at,
      );
    }
    upsert_state.run(source_doc_token, marker.source_revision, marker.last_synced_at);
  });
}

/** 删除一个来源文档的索引行与标记（单事务，幂等）。 */
export function delete_doc_rows(db: DatabaseSync, source_doc_token: string): void {
  const delete_cards = db.prepare("DELETE FROM cards WHERE source_doc_token = ?");
  const delete_state = db.prepare("DELETE FROM doc_state WHERE source_doc_token = ?");
  transaction(db, () => {
    delete_cards.run(source_doc_token);
    delete_state.run(source_doc_token);
  });
}

/**
 * 按路径只读探测索引状态，不抛异常、不凭空创建文件、不写任何字节：
 *
 * - 路径不存在 -> `missing`（不落盘）；
 * - 存在但不是普通文件、大小为 0、无法以只读方式打开、或缺少 `cards` 表 ->
 *   `corrupt`（0 字节文件不再当空库处理：这里绝不执行 DDL）；
 * - 其余 -> `ready` 并返回 `cards` 行数。
 *
 * 调用方（health、`refresh_local_index` 的 dry run 与重建判断）据此决定重建或
 * 降级；真正建表只发生在写路径的 `open_index()` 里。
 */
export function index_status(file_path: string = index_file_path()): IndexStatus {
  if (!existsSync(file_path)) {
    return { state: "missing", card_count: 0 };
  }

  let size = 0;
  let is_file = false;
  try {
    const stats = statSync(file_path);
    size = stats.size;
    is_file = stats.isFile();
  } catch {
    return { state: "corrupt", card_count: 0 };
  }
  if (!is_file || size === 0) {
    return { state: "corrupt", card_count: 0 };
  }

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file_path, { readOnly: true });
    const row = db.prepare("SELECT COUNT(*) AS card_count FROM cards").get();
    const card_count = row?.card_count;
    return { state: "ready", card_count: typeof card_count === "number" ? card_count : 0 };
  } catch {
    return { state: "corrupt", card_count: 0 };
  } finally {
    if (db !== undefined) {
      close_quietly(db);
    }
  }
}

/** 列出本地索引中的全部文档标记，按 `source_doc_token` 升序保证可复现。 */
export function list_doc_markers(db: DatabaseSync): DocStateMarker[] {
  const rows = db
    .prepare(
      "SELECT source_doc_token, source_revision, last_synced_at FROM doc_state " +
        "ORDER BY source_doc_token",
    )
    .all();
  return rows.map((row) => ({
    source_doc_token: row.source_doc_token as string,
    source_revision: row.source_revision as number,
    last_synced_at: row.last_synced_at as string,
  }));
}

/** 单事务帮助函数：BEGIN -> work -> COMMIT；失败时回滚并原样抛错。 */
function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 回滚失败（例如底层文件已损坏）时保留原始错误。
    }
    throw error;
  }
}

function close_quietly(db: DatabaseSync): void {
  try {
    db.close();
  } catch {
    // 探测路径下关闭失败不值得再抛，原状态结果优先。
  }
}
