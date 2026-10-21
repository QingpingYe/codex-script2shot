import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { KnowledgeCard } from "./base_mapping.js";
import { resolve_home } from "./config.js";

/**
 * 本地知识卡缓存（架构 §7.2、§7.4）。
 *
 * - 缓存文件固定为 `<home>/cache/cards.json`，顶层形状
 *   `{ version: 1, docs: { [source_doc_token]: { source_revision, last_synced_at, cards[] } } }`。
 * - 缓存标记不是同步状态，只用于避免重复下载与重复建索引；知识库 B 的
 *   SyncState 始终是权威（§2.4）。
 * - `load_cache()` 不抛异常：文件缺失返回空缓存；解析失败、结构非法或版本
 *   不受支持时返回 `rebuild_needed: true` 与 warning，绝不自动覆盖文件，
 *   删除/重建由调用方（`refresh_local_index`）决定。
 * - `save_cache()` 先写同目录临时文件再原子替换，文件权限 0o600（缓存含知识
 *   正文）；失败时清理临时文件，绝不留半截 JSON。
 */

export const CACHE_VERSION = 1;
export const CACHE_FILE_NAME = "cards.json";

const CACHE_DIR_NAME = "cache";

/** 本地缓存标记：与知识库 B 的 SyncState 比对时的最小信息。 */
export interface DocMarker {
  source_revision: number;
  last_synced_at: string;
}

/** 单个文档在缓存中的完整条目：标记 + 该文档的全部知识卡。 */
export interface DocCacheEntry extends DocMarker {
  cards: KnowledgeCard[];
}

export interface LocalCardCache {
  version: number;
  docs: Record<string, DocCacheEntry>;
}

export interface CacheWarning {
  code: "CACHE_CORRUPT" | "CACHE_VERSION_UNSUPPORTED" | "CACHE_UNREADABLE";
  message: string;
  refs?: string[];
}

/**
 * `load_cache()` 的返回值。`rebuild_needed: true` 表示缓存不可用（损坏、
 * 版本不支持或读不到），此时 `docs` 为空对象，调用方决定是否重建。
 */
export interface CacheLoadResult {
  version: number;
  docs: Record<string, DocCacheEntry>;
  warnings: CacheWarning[];
  rebuild_needed?: true;
}

/** 缓存文件路径：`<home>/cache/cards.json`（home 由 `resolve_home()` 解析）。 */
export function cache_file_path(): string {
  return path.join(resolve_home(), CACHE_DIR_NAME, CACHE_FILE_NAME);
}

/**
 * 读取缓存。只读 `cards.json`，忽略缓存目录里的其他文件（例如失败残留的
 * `cards.json.*.tmp`）；不创建目录、不改写任何文件。
 */
export function load_cache(): CacheLoadResult {
  const file_path = cache_file_path();
  let raw: string;
  try {
    raw = readFileSync(file_path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return empty_result();
    }
    return {
      version: CACHE_VERSION,
      docs: {},
      warnings: [
        {
          code: "CACHE_UNREADABLE",
          message: `无法读取本地缓存文件：${describe_error(error)}。需要重建本地缓存。`,
          refs: [file_path],
        },
      ],
      rebuild_needed: true,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return corrupt_result(file_path, `缓存文件不是有效的 JSON：${describe_error(error)}。`);
  }
  if (!is_record(parsed)) {
    return corrupt_result(file_path, "缓存文件的顶层结构不是 JSON 对象。");
  }

  const version = parsed.version;
  if (version !== CACHE_VERSION) {
    return {
      version: CACHE_VERSION,
      docs: {},
      warnings: [
        {
          code: "CACHE_VERSION_UNSUPPORTED",
          message:
            `缓存文件版本 ${describe_version(version)} 不受支持` +
            `（当前版本 ${CACHE_VERSION}）。需要重建本地缓存。`,
          refs: [file_path],
        },
      ],
      rebuild_needed: true,
    };
  }

  const docs_value = parsed.docs;
  if (!is_record(docs_value)) {
    return corrupt_result(file_path, '缓存文件缺少 "docs" 对象。');
  }

  const docs: Record<string, DocCacheEntry> = {};
  for (const [token, entry] of Object.entries(docs_value)) {
    const parsed_entry = parse_doc_entry(entry);
    if (parsed_entry === undefined) {
      return corrupt_result(file_path, `缓存中文档 "${token}" 的条目结构不符合约定。`);
    }
    docs[token] = parsed_entry;
  }

  return { version: CACHE_VERSION, docs, warnings: [] };
}

/**
 * 原子写入缓存：先写同目录临时文件（0o600），再 `renameSync` 替换
 * `cards.json`。失败时清理临时文件后原样抛出。写入的 `version` 固定为
 * 当前 `CACHE_VERSION`，只持久化 `docs`。
 */
export function save_cache(cache: LocalCardCache): void {
  const file_path = cache_file_path();
  const content = `${JSON.stringify({ version: CACHE_VERSION, docs: cache.docs }, null, 2)}\n`;
  mkdirSync(path.dirname(file_path), { recursive: true });
  const temp_path = `${file_path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp_path, content, { encoding: "utf8", mode: 0o600 });
    renameSync(temp_path, file_path);
  } catch (error) {
    rmSync(temp_path, { force: true });
    throw error;
  }
}

/**
 * 读取磁盘缓存并返回指定文档的本地标记；文件缺失、损坏或文档不存在时返回
 * `undefined`（不抛异常，也不需要调用方先 `load_cache()`）。
 */
export function get_doc_marker(token: string): DocMarker | undefined {
  const entry = load_cache().docs[token];
  if (entry === undefined) {
    return undefined;
  }
  return { source_revision: entry.source_revision, last_synced_at: entry.last_synced_at };
}

/** 在内存缓存对象中写入/替换一个文档的标记与卡片（不落盘）。 */
export function set_doc(
  cache: LocalCardCache,
  token: string,
  marker: DocMarker,
  cards: readonly KnowledgeCard[],
): void {
  cache.docs[token] = {
    source_revision: marker.source_revision,
    last_synced_at: marker.last_synced_at,
    cards: [...cards],
  };
}

/** 从内存缓存对象中移除一个文档（不落盘）。 */
export function remove_doc(cache: LocalCardCache, token: string): void {
  delete cache.docs[token];
}

function empty_result(): CacheLoadResult {
  return { version: CACHE_VERSION, docs: {}, warnings: [] };
}

function corrupt_result(file_path: string, detail: string): CacheLoadResult {
  return {
    version: CACHE_VERSION,
    docs: {},
    warnings: [
      {
        code: "CACHE_CORRUPT",
        message: `${detail}需要重建本地缓存。`,
        refs: [file_path],
      },
    ],
    rebuild_needed: true,
  };
}

/** 浅校验单个文档条目：标记类型与 cards 数组齐全；卡片字段本身由 schema 层负责。 */
function parse_doc_entry(value: unknown): DocCacheEntry | undefined {
  if (!is_record(value)) {
    return undefined;
  }
  const { source_revision, last_synced_at, cards } = value;
  if (typeof source_revision !== "number" || !Number.isFinite(source_revision)) {
    return undefined;
  }
  if (typeof last_synced_at !== "string" || last_synced_at.trim() === "") {
    return undefined;
  }
  if (!Array.isArray(cards) || cards.some((card) => !is_record(card))) {
    return undefined;
  }
  return { source_revision, last_synced_at, cards: cards as KnowledgeCard[] };
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe_version(version: unknown): string {
  if (version === undefined) {
    return "缺失";
  }
  return typeof version === "number" ? String(version) : JSON.stringify(version);
}

function describe_error(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
