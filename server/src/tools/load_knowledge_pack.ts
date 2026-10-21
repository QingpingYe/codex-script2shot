import { DatabaseSync } from "node:sqlite";
import type { TargetModel } from "../base_mapping.js";
import { index_file_path, index_status, type IndexState } from "../index_store.js";
import { TARGET_MODEL_VALUES } from "./search_knowledge.js";

/**
 * `load_knowledge_pack` MCP Tool（架构 §10.3；Task 5 简报）。
 *
 * 每次生成前按 `project_id` 与 `target_model` 组装知识包，卡片顺序固定：
 * general（category 升序 -> card_id 升序）-> project（同上）-> seedance（同上）。
 *
 * 三个来源块（同一张卡只输出一次，按 general -> project -> seedance 的顺序
 * 归类计数）：
 * - general：全部 `scope = "general"` 卡片；
 * - project：`scope = "project"` 且 `project_id` 匹配的卡片；
 * - seedance：`category = "seedance_rule"` 且 `target_models` 兼容目标模型的
 *   卡片（含当前模型，或为空/缺失 = 通用卡，stage-conventions §3.1）。
 *
 * 只读本地索引：`index_status()` 探测 + `readOnly` 打开 sqlite。索引缺失、
 * 损坏或读取失败一律返回 `INDEX_UNAVAILABLE`——本工具只消费 Task 2 索引，
 * **没有缓存回退**，也绝不创建或修复索引文件。
 *
 * `explain` 是 Phase 5 的诊断输出（§10.4）：本期接受参数、不改变行为，
 * 传 `true` 时返回 warning `EXPLAIN_NOT_AVAILABLE`。
 *
 * 返回值一律是结果对象，不抛异常（工具契约与 Phase 2/3 其他工具一致）。
 */

export interface LoadKnowledgePackInput {
  project_id?: unknown;
  target_model?: unknown;
  explain?: unknown;
}

/** 输出卡片字段是 Task 4 的冻结候选字段去掉 `match_level`，供阶段产物拼 `knowledge_refs`。 */
export interface PackCard {
  card_id: string;
  category: string;
  title: string;
  content: string;
  tags: string[];
  entities: string[];
  priority: number;
  source_doc_token: string;
  source_path: string;
  source_revision: number;
  last_synced_at: string;
}

export interface PackStats {
  general: number;
  project: number;
  seedance: number;
}

export interface PackWarning {
  code: string;
  message: string;
}

export interface LoadKnowledgePackSuccess {
  cards: PackCard[];
  stats: PackStats;
  warnings: PackWarning[];
}

export type LoadKnowledgePackErrorCode = "CONFIG_INVALID" | "INDEX_UNAVAILABLE";

export interface LoadKnowledgePackFailure {
  ok: false;
  error: {
    code: LoadKnowledgePackErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type LoadKnowledgePackResult = LoadKnowledgePackSuccess | LoadKnowledgePackFailure;

/** 工具的入参字段清单；`server/src/index.ts` 的分发层用它做 fail-closed 校验。 */
export const LOAD_KNOWLEDGE_PACK_FIELDS = ["project_id", "target_model", "explain"] as const;

/** 索引行：三个来源块需要的过滤字段 + 输出卡片字段。 */
interface PackRow {
  card_id: string;
  scope: string | null;
  project_id: string | null;
  category: string;
  title: string;
  content: string;
  tags: string[];
  entities: string[];
  target_models: string[];
  priority: number;
  source_doc_token: string;
  source_path: string;
  source_revision: number;
  last_synced_at: string;
}

interface PackOptions {
  project_id: string;
  target_model: TargetModel;
  explain: boolean;
}

const PACK_COLUMNS = [
  "card_id",
  "source_doc_token",
  "scope",
  "project_id",
  "category",
  "title",
  "content",
  "tags_json",
  "entities_json",
  "target_models_json",
  "priority",
  "source_path",
  "source_revision",
  "last_synced_at",
].join(", ");

/**
 * SQL 只做三个来源块的并集粗过滤（与纯 JS 语义逐字等价）：`target_models`
 * 存在 JSON 文本里，模型兼容性一律在内存里精算。排序也在内存里做，
 * 保证 category / card_id 升序与运行环境无关。
 */
const PACK_SQL =
  `SELECT ${PACK_COLUMNS} FROM cards ` +
  "WHERE scope = 'general' OR (scope = 'project' AND project_id = ?) " +
  "OR category = 'seedance_rule'";

export function load_knowledge_pack(
  input: LoadKnowledgePackInput = {},
): LoadKnowledgePackResult {
  const parsed = parse_input(input ?? {});
  if (parsed.ok === false) {
    return parsed;
  }
  const options = parsed.value;

  const index_path = index_file_path();
  const status = index_status(index_path);
  if (status.state !== "ready") {
    return index_unavailable(index_path, status.state);
  }

  const rows = read_pack_rows(index_path, options.project_id);
  if (rows === undefined) {
    // 索引状态为 ready 但读取失败（并发重建、文件被占用等）：同样按
    // 「索引不可用」处理，不把内部异常抛给调用方，也不重建索引。
    return index_unavailable(index_path, status.state, true);
  }

  return build_pack(rows, options);
}

function parse_input(
  input: LoadKnowledgePackInput,
): { ok: true; value: PackOptions } | LoadKnowledgePackFailure {
  if (!is_record(input)) {
    return failure("CONFIG_INVALID", "工具入参必须是 JSON 对象。", { field: "arguments" });
  }

  const project_id = input.project_id;
  if (typeof project_id !== "string" || project_id.trim() === "") {
    return invalid("project_id", '入参字段 "project_id" 期望非空字符串。');
  }

  const target_model = input.target_model;
  if (
    typeof target_model !== "string" ||
    !(TARGET_MODEL_VALUES as readonly string[]).includes(target_model)
  ) {
    return invalid(
      "target_model",
      `入参字段 "target_model" 只支持 ${TARGET_MODEL_VALUES.join(" 和 ")}。`,
    );
  }

  const explain = input.explain;
  if (explain !== undefined && typeof explain !== "boolean") {
    return invalid("explain", '入参字段 "explain" 期望布尔值。');
  }

  return {
    ok: true,
    value: {
      project_id,
      target_model: target_model as TargetModel,
      explain: explain === true,
    },
  };
}

/**
 * 三个来源块按规则顺序归类（general -> project -> seedance），`card_id` 去重：
 * 先命中的块拥有这张卡。每块内部按 category 升序、card_id 升序排列。
 */
function build_pack(rows: readonly PackRow[], options: PackOptions): LoadKnowledgePackSuccess {
  const general: PackRow[] = [];
  const project: PackRow[] = [];
  const seedance: PackRow[] = [];
  const emitted = new Set<string>();

  for (const row of rows) {
    if (row.scope === "general" && !emitted.has(row.card_id)) {
      emitted.add(row.card_id);
      general.push(row);
    }
  }
  for (const row of rows) {
    if (
      row.scope === "project" &&
      row.project_id === options.project_id &&
      !emitted.has(row.card_id)
    ) {
      emitted.add(row.card_id);
      project.push(row);
    }
  }
  for (const row of rows) {
    if (
      row.category === "seedance_rule" &&
      target_model_allows(row.target_models, options.target_model) &&
      !emitted.has(row.card_id)
    ) {
      emitted.add(row.card_id);
      seedance.push(row);
    }
  }

  for (const block of [general, project, seedance]) {
    block.sort(compare_pack_order);
  }

  return {
    cards: [...general, ...project, ...seedance].map(to_card),
    stats: {
      general: general.length,
      project: project.length,
      seedance: seedance.length,
    },
    warnings: collect_warnings({
      general_empty: general.length === 0,
      project_empty: project.length === 0,
      explain: options.explain,
    }),
  };
}

/** §3.1：`target_models` 含当前模型，或为空/缺失（通用卡）都放行。 */
function target_model_allows(models: readonly string[], target_model: string): boolean {
  return models.length === 0 || models.includes(target_model);
}

/** 块内固定排序：`category` 升序 -> `card_id` 升序。 */
function compare_pack_order(a: PackRow, b: PackRow): number {
  const by_category = compare_ascending_text(a.category, b.category);
  return by_category === 0 ? compare_ascending_text(a.card_id, b.card_id) : by_category;
}

function to_card(row: PackRow): PackCard {
  return {
    card_id: row.card_id,
    category: row.category,
    title: row.title,
    content: row.content,
    tags: [...row.tags],
    entities: [...row.entities],
    priority: row.priority,
    source_doc_token: row.source_doc_token,
    source_path: row.source_path,
    source_revision: row.source_revision,
    last_synced_at: row.last_synced_at,
  };
}

/**
 * 读取索引行。**只读打开**（不复用 `open_index()` 的建库/建表路径）：探测与
 * 打开之间索引文件被删或被换成非法文件时，这里会直接失败 ⇒ 调用方按
 * 「索引不可用」返回错误，而不是重建一个空索引。
 *
 * 任何失败（打开、查询、关闭前抛错）都返回 undefined；句柄一律在 `finally`
 * 里关闭。
 */
function read_pack_rows(index_path: string, project_id: string): PackRow[] | undefined {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(index_path, { readOnly: true });
    const rows = db.prepare(PACK_SQL).all(project_id) as Array<Record<string, unknown>>;
    return rows.map(from_index_row);
  } catch {
    return undefined;
  } finally {
    if (db !== undefined) {
      try {
        db.close();
      } catch {
        // 读取失败路径下关闭失败不值得再抛：索引本身已判为不可用。
      }
    }
  }
}

function from_index_row(row: Record<string, unknown>): PackRow {
  return {
    card_id: text_or(row.card_id, ""),
    scope: text_or_null(row.scope),
    project_id: text_or_null(row.project_id),
    category: text_or(row.category, ""),
    title: text_or(row.title, ""),
    content: text_or(row.content, ""),
    tags: json_text_array(row.tags_json),
    entities: json_text_array(row.entities_json),
    target_models: json_text_array(row.target_models_json),
    priority: finite_or(row.priority, 0),
    source_doc_token: text_or(row.source_doc_token, ""),
    source_path: text_or(row.source_path, ""),
    source_revision: finite_or(row.source_revision, 0),
    last_synced_at: text_or(row.last_synced_at, ""),
  };
}

/** warning 顺序固定：GENERAL_KNOWLEDGE_EMPTY -> PROJECT_KNOWLEDGE_EMPTY -> EXPLAIN_NOT_AVAILABLE。 */
function collect_warnings(flags: {
  general_empty?: boolean;
  project_empty?: boolean;
  explain?: boolean;
}): PackWarning[] {
  const warnings: PackWarning[] = [];
  if (flags.general_empty === true) {
    warnings.push({
      code: "GENERAL_KNOWLEDGE_EMPTY",
      message: "本地索引中没有 scope=general 的通用知识卡片，知识包缺少通用知识部分。",
    });
  }
  if (flags.project_empty === true) {
    warnings.push({
      code: "PROJECT_KNOWLEDGE_EMPTY",
      message: "本地索引中没有该项目的项目知识卡片，知识包缺少项目知识部分。",
    });
  }
  if (flags.explain === true) {
    warnings.push({
      code: "EXPLAIN_NOT_AVAILABLE",
      message: "explain 诊断输出属于 Phase 5，本期只接受参数、不改变知识包内容。",
    });
  }
  return warnings;
}

function index_unavailable(
  index_path: string,
  index_state: IndexState,
  read_failed = false,
): LoadKnowledgePackFailure {
  const details: Record<string, unknown> = { index_path, index_state };
  if (read_failed) {
    details.index_read_failed = true;
  }
  return failure(
    "INDEX_UNAVAILABLE",
    "本地知识索引不可用（缺失或损坏），load_knowledge_pack 没有缓存回退；" +
      "请先运行 refresh_local_index 重建本地索引。",
    details,
  );
}

function invalid(field: string, message: string): LoadKnowledgePackFailure {
  return failure("CONFIG_INVALID", message, { field });
}

function failure(
  code: LoadKnowledgePackErrorCode,
  message: string,
  details?: Record<string, unknown>,
): LoadKnowledgePackFailure {
  return {
    ok: false,
    error: details === undefined ? { code, message } : { code, message, details },
  };
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text_or(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function text_or_null(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function finite_or(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function string_list(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

/** `tags_json` / `entities_json` / `target_models_json` 解析；非法 JSON 当空数组。 */
function json_text_array(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  return string_list(parsed);
}

function compare_ascending_text(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}
