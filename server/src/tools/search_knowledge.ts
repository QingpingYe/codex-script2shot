import type { DatabaseSync } from "node:sqlite";
import type { KnowledgeCategory, KnowledgeScope, TargetModel } from "../base_mapping.js";
import { cache_file_path, load_cache, type CacheLoadResult } from "../cache.js";
import { load_config } from "../config.js";
import { index_file_path, index_status, open_index } from "../index_store.js";
import { normalize_text } from "../normalize.js";
import {
  assemble_context,
  card_passes_filters,
  compare_priority_rank,
  rank_matching_cards,
  type CardFilters,
  type MatchLevel,
  type RankableCard,
} from "../ranking.js";
import { SETUP_DEFAULTS } from "../setup_defaults.js";

/**
 * `search_knowledge` MCP Tool（架构 §10.1、§10.2、§13；Task 4 简报）。
 *
 * 过滤顺序固定：`scope -> project_id -> category -> target_model -> 关键词 -> 排序`。
 * `scope` / `project_id` / `category` 交给 SQL 粗过滤，`target_model` 与关键词匹配
 * 一律在内存里由 `server/src/ranking.ts` 的纯函数精算（与纯函数测试逐字一致）。
 *
 * - `max_cards` 缺省取 `retrieval.default_top_k`（配置文件缺失时取插件默认值 12）；
 *   `char_budget` 可选，按「候选顺序拼接的正文」（不含来源标注）的长度比较。
 *   两类截断（超出 `max_cards`、超出 `char_budget`）都从最低排序端开始，
 *   被截断的 `card_id` 按「排序结果的反序」记入 `dropped_by_budget`（§3.5）。
 * - 空/全空白查询 ⇒ 空候选 + warning `EMPTY_QUERY`（索引就绪时不再落任何检索）。
 * - 索引不可用（`index_status` 为 missing / corrupt，或读取中途失败）⇒ 回退到
 *   Task 1 缓存：仍应用同样的四个过滤条件，按 `priority` 降序取候选，
 *   `degraded: true` + warning `INDEX_UNAVAILABLE`，`match_level` 一律为 `null`
 *   （回退路径不重跑关键词匹配）。缓存缺失、损坏或为空 ⇒ `INDEX_UNAVAILABLE` 错误。
 * - `explain` 是 Phase 5 的诊断输出（§10.4）：本期接受参数、不改变行为，
 *   传 `true` 时返回 warning `EXPLAIN_NOT_AVAILABLE`。
 *
 * 返回值一律是结果对象，不抛异常（工具契约与 Phase 2/3 其他工具一致）。
 */

export interface SearchKnowledgeInput {
  query?: unknown;
  scope?: unknown;
  project_id?: unknown;
  categories?: unknown;
  target_model?: unknown;
  max_cards?: unknown;
  char_budget?: unknown;
  explain?: unknown;
}

/** 输出卡片字段是 Task 5 也要用的冻结集合（索引里没有 `source_title`）。 */
export interface SearchCandidate {
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
  /** 1=精确、2=部分、3=正文；回退路径不重跑匹配，固定为 null。 */
  match_level: MatchLevel | null;
}

export interface SearchWarning {
  code: string;
  message: string;
}

export interface SearchKnowledgeSuccess {
  candidates: SearchCandidate[];
  /** 被 `max_cards` 或 `char_budget` 截断的 `card_id`，按排序结果的反序。 */
  dropped_by_budget: string[];
  /** 只有走缓存回退路径时为 true。 */
  degraded: boolean;
  /** 候选正文按顺序拼接的上下文文本（不含来源标注）；只含存活候选。 */
  context: string;
  warnings: SearchWarning[];
}

export type SearchKnowledgeErrorCode = "CONFIG_INVALID" | "INDEX_UNAVAILABLE";

export interface SearchKnowledgeFailure {
  ok: false;
  error: {
    code: SearchKnowledgeErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type SearchKnowledgeResult = SearchKnowledgeSuccess | SearchKnowledgeFailure;

/** 工具的入参字段清单；`server/src/index.ts` 的分发层用它做 fail-closed 校验。 */
export const SEARCH_KNOWLEDGE_FIELDS = [
  "query",
  "scope",
  "project_id",
  "categories",
  "target_model",
  "max_cards",
  "char_budget",
  "explain",
] as const;

export const KNOWLEDGE_SCOPE_VALUES: readonly KnowledgeScope[] = ["general", "project"];

export const KNOWLEDGE_CATEGORY_VALUES: readonly KnowledgeCategory[] = [
  "shot_breakdown",
  "storyboard",
  "prompt_technique",
  "camera_lexicon",
  "character_bible",
  "scene_description",
  "visual_style",
  "project_rule",
  "seedance_rule",
  "example",
];

export const TARGET_MODEL_VALUES: readonly TargetModel[] = ["seedance-2.0", "seedance-2.5"];

/** 内部卡片：`RankableCard` 的字段 + 输出需要的来源四元组。 */
interface LocalCard extends RankableCard {
  scope: string | null;
  project_id: string | null;
  category: string | null;
  tags: string[];
  entities: string[];
  target_models: string[];
  source_doc_token: string;
  source_path: string;
  source_revision: number;
  last_synced_at: string;
}

interface OrderedCard {
  card: LocalCard;
  match_level: MatchLevel | null;
}

interface SearchOptions {
  query: string;
  filters: CardFilters;
  max_cards: number;
  char_budget?: number;
  explain: boolean;
}

const CARD_COLUMNS = [
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
  "updated_at",
  "source_path",
  "source_revision",
  "last_synced_at",
].join(", ");

export function search_knowledge(input: SearchKnowledgeInput = {}): SearchKnowledgeResult {
  const parsed = parse_input(input ?? {});
  if (parsed.ok === false) {
    return parsed;
  }
  const options = parsed.value;
  const empty_query = normalize_text(options.query) === "";

  const index_path = index_file_path();
  const status = index_status(index_path);
  let index_read_failed = false;
  if (status.state === "ready") {
    const indexed = read_index_cards(index_path, options.filters);
    if (indexed !== undefined) {
      if (empty_query) {
        return {
          candidates: [],
          dropped_by_budget: [],
          degraded: false,
          context: "",
          warnings: collect_warnings({ empty_query: true, explain: options.explain }),
        };
      }
      const ranked = rank_matching_cards(indexed, options.filters, options.query);
      const ordered: OrderedCard[] = ranked.map((entry) => ({
        card: entry.card,
        match_level: entry.match_level,
      }));
      return build_result(
        ordered,
        options,
        false,
        collect_warnings({ explain: options.explain }),
      );
    }
    // 索引状态为 ready 但读取失败（并发重建、文件被占用等）：与 missing/corrupt
    // 同样按「索引不可用」处理，走缓存回退，不把内部异常抛给调用方。
    index_read_failed = true;
  }

  const cached = read_cache_cards();
  if (cached === undefined) {
    return failure(
      "INDEX_UNAVAILABLE",
      "本地关键词索引不可用，且没有可用的本地缓存；请先运行 refresh_local_index 重建本地索引。",
      {
        index_path,
        index_state: status.state,
        index_read_failed,
        cache_path: cache_file_path(),
      },
    );
  }

  // 回退路径不重跑关键词匹配，查询本身不参与筛选：空查询在这里同样只应用四个
  // 过滤条件并给 EMPTY_QUERY warning（Task 4 简报：空查询仍要应用过滤走回退）。
  const filtered = cached.filter((card) => card_passes_filters(card, options.filters));
  filtered.sort(compare_priority_rank);
  const ordered: OrderedCard[] = filtered.map((card) => ({ card, match_level: null }));
  return build_result(
    ordered,
    options,
    true,
    collect_warnings({
      index_unavailable: true,
      empty_query,
      explain: options.explain,
    }),
  );
}

function parse_input(
  input: SearchKnowledgeInput,
): { ok: true; value: SearchOptions } | SearchKnowledgeFailure {
  if (!is_record(input)) {
    return failure("CONFIG_INVALID", "工具入参必须是 JSON 对象。", { field: "arguments" });
  }

  const query = input.query;
  if (typeof query !== "string") {
    return invalid("query", '入参字段 "query" 期望字符串。');
  }

  let scope: string | undefined;
  if (input.scope !== undefined) {
    if (
      typeof input.scope !== "string" ||
      !(KNOWLEDGE_SCOPE_VALUES as readonly string[]).includes(input.scope)
    ) {
      return invalid("scope", '入参字段 "scope" 期望 "general" 或 "project"。');
    }
    scope = input.scope;
  }

  let project_id: string | undefined;
  if (input.project_id !== undefined) {
    if (typeof input.project_id !== "string" || input.project_id.trim() === "") {
      return invalid("project_id", '入参字段 "project_id" 期望非空字符串。');
    }
    project_id = input.project_id;
  }

  let categories: string[] | undefined;
  if (input.categories !== undefined) {
    if (!Array.isArray(input.categories)) {
      return invalid("categories", '入参字段 "categories" 期望字符串数组。');
    }
    for (const entry of input.categories) {
      if (
        typeof entry !== "string" ||
        !(KNOWLEDGE_CATEGORY_VALUES as readonly string[]).includes(entry)
      ) {
        return invalid(
          "categories",
          `入参字段 "categories" 只接受知识分类：${KNOWLEDGE_CATEGORY_VALUES.join("、")}。`,
        );
      }
    }
    categories = [...(input.categories as string[])];
  }

  let target_model: string | undefined;
  if (input.target_model !== undefined) {
    if (
      typeof input.target_model !== "string" ||
      !(TARGET_MODEL_VALUES as readonly string[]).includes(input.target_model)
    ) {
      return invalid(
        "target_model",
        `入参字段 "target_model" 只支持 ${TARGET_MODEL_VALUES.join(" 和 ")}。`,
      );
    }
    target_model = input.target_model;
  }

  let max_cards: number | undefined;
  if (input.max_cards !== undefined) {
    const invalid_limit = check_limit("max_cards", input.max_cards);
    if (invalid_limit !== undefined) {
      return invalid_limit;
    }
    max_cards = input.max_cards as number;
  } else {
    const resolved = default_top_k();
    if (resolved.ok === false) {
      return resolved;
    }
    max_cards = resolved.value;
  }

  let char_budget: number | undefined;
  if (input.char_budget !== undefined) {
    const invalid_limit = check_limit("char_budget", input.char_budget);
    if (invalid_limit !== undefined) {
      return invalid_limit;
    }
    char_budget = input.char_budget as number;
  }

  const explain = input.explain;
  if (explain !== undefined && typeof explain !== "boolean") {
    return invalid("explain", '入参字段 "explain" 期望布尔值。');
  }

  return {
    ok: true,
    value: {
      query,
      filters: {
        ...(scope === undefined ? {} : { scope }),
        ...(project_id === undefined ? {} : { project_id }),
        ...(categories === undefined ? {} : { categories }),
        ...(target_model === undefined ? {} : { target_model }),
      },
      max_cards,
      ...(char_budget === undefined ? {} : { char_budget }),
      explain: explain === true,
    },
  };
}

/** `max_cards` / `char_budget` 都必须是 0 或正整数（负值与小数按 CONFIG_INVALID 拒绝）。 */
function check_limit(
  field: "max_cards" | "char_budget",
  value: unknown,
): SearchKnowledgeFailure | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return invalid(field, `入参字段 "${field}" 期望 0 或正整数。`);
  }
  return undefined;
}

/** `max_cards` 缺省值：配置里的 `retrieval.default_top_k`；配置文件不存在时用插件默认值。 */
function default_top_k(): { ok: true; value: number } | SearchKnowledgeFailure {
  const loaded = load_config();
  if ("error" in loaded) {
    const details: Record<string, unknown> = { path: loaded.error.details.path };
    if (loaded.error.details.field !== undefined) {
      details.field = loaded.error.details.field;
    }
    return failure("CONFIG_INVALID", loaded.error.message, details);
  }
  if (!loaded.exists) {
    return { ok: true, value: SETUP_DEFAULTS.retrieval.default_top_k };
  }
  return { ok: true, value: loaded.config.retrieval.default_top_k };
}

/**
 * SQL 粗过滤只在「与纯函数语义逐字等价」的字段上做：`scope`、`project_id`、
 * `category`。`target_model` 存在 JSON 文本里、关键词要归一化后匹配，都在内存里
 * 由 `ranking.ts` 精算。
 */
function build_cards_query(filters: CardFilters): { sql: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];

  if (filters.scope !== undefined) {
    clauses.push("scope = ?");
    params.push(filters.scope);
  }
  if (filters.project_id !== undefined) {
    clauses.push("project_id = ?");
    params.push(filters.project_id);
  }
  if (filters.categories !== undefined && filters.categories.length > 0) {
    clauses.push(`category IN (${filters.categories.map(() => "?").join(", ")})`);
    params.push(...filters.categories);
  }

  const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
  return { sql: `SELECT ${CARD_COLUMNS} FROM cards${where}`, params };
}

/**
 * 读取索引卡片；任何失败（打开、查询、关闭前抛错）都返回 undefined，由调用方
 * 按「索引不可用」走缓存回退。句柄一律在 `finally` 里关闭。
 */
function read_index_cards(index_path: string, filters: CardFilters): LocalCard[] | undefined {
  let db: DatabaseSync | undefined;
  try {
    db = open_index(index_path);
    const { sql, params } = build_cards_query(filters);
    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(from_index_row);
  } catch {
    return undefined;
  } finally {
    if (db !== undefined) {
      try {
        db.close();
      } catch {
        // 回退路径下关闭失败不值得再抛：索引本身已判为不可用。
      }
    }
  }
}

function from_index_row(row: Record<string, unknown>): LocalCard {
  return {
    card_id: text_or(row.card_id, ""),
    scope: text_or_null(row.scope),
    project_id: text_or_null(row.project_id),
    category: text_or_null(row.category),
    title: text_or(row.title, ""),
    content: text_or(row.content, ""),
    tags: json_text_array(row.tags_json),
    entities: json_text_array(row.entities_json),
    target_models: json_text_array(row.target_models_json),
    priority: finite_or(row.priority, 0),
    updated_at: text_or(row.updated_at, ""),
    source_doc_token: text_or(row.source_doc_token, ""),
    source_path: text_or(row.source_path, ""),
    source_revision: finite_or(row.source_revision, 0),
    last_synced_at: text_or(row.last_synced_at, ""),
  };
}

/**
 * 缓存回退卡片；缓存不可用（`rebuild_needed`）或一张卡都没有时返回 undefined。
 * 来源四元组取缓存条目的标记（`source_doc_token` / `source_revision` /
 * `last_synced_at`），与索引行的取值口径一致。
 */
function read_cache_cards(): LocalCard[] | undefined {
  return cache_cards(load_cache());
}

function cache_cards(cache: CacheLoadResult): LocalCard[] | undefined {
  if (cache.rebuild_needed === true) {
    return undefined;
  }
  const cards: LocalCard[] = [];
  for (const [token, entry] of Object.entries(cache.docs)) {
    for (const card of entry.cards) {
      const raw = card as Partial<Record<keyof LocalCard, unknown>>;
      cards.push({
        card_id: text_or(raw.card_id, ""),
        scope: text_or_null(raw.scope),
        project_id: text_or_null(raw.project_id),
        category: text_or_null(raw.category),
        title: text_or(raw.title, ""),
        content: text_or(raw.content, ""),
        tags: string_list(raw.tags),
        entities: string_list(raw.entities),
        target_models: string_list(raw.target_models),
        priority: finite_or(raw.priority, 0),
        updated_at: text_or(raw.updated_at, ""),
        source_doc_token: token,
        source_path: text_or(raw.source_path, ""),
        source_revision: finite_or(entry.source_revision, 0),
        last_synced_at: typeof entry.last_synced_at === "string" ? entry.last_synced_at : "",
      });
    }
  }
  return cards.length > 0 ? cards : undefined;
}

/**
 * 截断与结果组装：先按 `max_cards` 取前缀，再按 `char_budget` 从最低排序端继续丢，
 * 直到上下文文本不超过预算。`dropped_by_budget` 按排序结果的反序记录（最低排序
 * 的卡最先被丢），确定且可复现。
 */
function build_result(
  ordered: readonly OrderedCard[],
  options: SearchOptions,
  degraded: boolean,
  warnings: SearchWarning[],
): SearchKnowledgeSuccess {
  const kept = ordered.slice(0, options.max_cards);
  const char_budget = options.char_budget;
  while (
    char_budget !== undefined &&
    kept.length > 0 &&
    assemble_context(kept.map((entry) => entry.card.content)).length > char_budget
  ) {
    kept.pop();
  }

  const kept_ids = new Set(kept.map((entry) => entry.card.card_id));
  const dropped_by_budget: string[] = [];
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const entry = ordered[index] as OrderedCard;
    if (!kept_ids.has(entry.card.card_id)) {
      dropped_by_budget.push(entry.card.card_id);
    }
  }

  return {
    candidates: kept.map(to_candidate),
    dropped_by_budget,
    degraded,
    context: assemble_context(kept.map((entry) => entry.card.content)),
    warnings,
  };
}

function to_candidate(entry: OrderedCard): SearchCandidate {
  const { card } = entry;
  return {
    card_id: card.card_id,
    category: card.category ?? "",
    title: card.title,
    content: card.content,
    tags: [...card.tags],
    entities: [...card.entities],
    priority: card.priority,
    source_doc_token: card.source_doc_token,
    source_path: card.source_path,
    source_revision: card.source_revision,
    last_synced_at: card.last_synced_at,
    match_level: entry.match_level,
  };
}

/** warning 顺序固定：INDEX_UNAVAILABLE -> EMPTY_QUERY -> EXPLAIN_NOT_AVAILABLE。 */
function collect_warnings(flags: {
  index_unavailable?: boolean;
  empty_query?: boolean;
  explain?: boolean;
}): SearchWarning[] {
  const warnings: SearchWarning[] = [];
  if (flags.index_unavailable === true) {
    warnings.push({
      code: "INDEX_UNAVAILABLE",
      message:
        "本地关键词索引不可用（缺失或损坏），已按 priority 降序回退到本地缓存；" +
        "本次结果不含关键词命中级别。",
    });
  }
  if (flags.empty_query === true) {
    warnings.push({
      code: "EMPTY_QUERY",
      message: "查询为空，没有执行关键词匹配。",
    });
  }
  if (flags.explain === true) {
    warnings.push({
      code: "EXPLAIN_NOT_AVAILABLE",
      message: "explain 诊断输出属于 Phase 5，本期只接受参数、不改变检索行为。",
    });
  }
  return warnings;
}

function invalid(field: string, message: string): SearchKnowledgeFailure {
  return failure("CONFIG_INVALID", message, { field });
}

function failure(
  code: SearchKnowledgeErrorCode,
  message: string,
  details?: Record<string, unknown>,
): SearchKnowledgeFailure {
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
