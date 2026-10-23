import { normalize_text } from "./normalize.js";

/**
 * 检索的纯函数层（架构 §10.1、§10.2；Task 4 简报）。
 *
 * 本模块只做内存计算：**不读文件系统、不碰数据库、不抛异常**，索引行与缓存卡
 * 都由调用方先映射成 `RankableCard` 再进来。这样 `search_knowledge` 的 SQL 粗过滤
 * 与纯函数测试一定得到同一套结论（命中级别只在内存里精算一次）。
 *
 * - 过滤顺序固定：`scope -> project_id -> category -> target_model`（§10.1）。
 *   `categories` 缺省或空数组表示不过滤；`target_model` 放行两类卡：清单里含该
 *   模型，或 `target_models` 为空/缺失（通用卡，§3.1）。
 * - 命中级别（§10.2，1 最好，取第一个命中的级别）：
 *   1 = 归一化标题或实体与归一化查询相等；
 *   2 = 归一化标题或标签包含归一化查询；
 *   3 = 归一化正文包含归一化查询。
 *   两侧一律走 `normalize_text()`，不各自实现归一化。
 * - 排序固定五级：命中级别升序 -> `priority` 降序 -> `updated_at` 降序 ->
 *   `card_id` 升序（确定性兜底，无权重参数）。
 */

export type MatchLevel = 1 | 2 | 3;

/** 过滤、命中与排序需要的最小卡片投影。 */
export interface RankableCard {
  card_id: string;
  scope?: string | null;
  project_id?: string | null;
  category?: string | null;
  title: string;
  content: string;
  tags?: readonly string[];
  entities?: readonly string[];
  /** 空数组、`null` 或缺失都表示「通用卡」（不过滤掉）。 */
  target_models?: readonly string[] | null;
  priority: number;
  updated_at: string;
}

/** 四个过滤条件的组合；未给的字段不参与过滤。 */
export interface CardFilters {
  scope?: string;
  project_id?: string;
  categories?: readonly string[];
  target_model?: string;
}

/** 命中卡片 + 命中级别；`match_level` 只在关键词检索路径上有意义。 */
export interface RankedEntry<T extends RankableCard = RankableCard> {
  card: T;
  match_level: MatchLevel;
}

/** 上下文拼接分隔符：卡片正文之间空一行，不含任何来源标注（§3.5）。 */
export const CONTEXT_SEPARATOR = "\n\n";

/**
 * 过滤顺序 `scope -> project_id -> category -> target_model`（§10.1）。
 * 四个条件依次放行/淘汰，任一不满足即出局。
 */
export function card_passes_filters(card: RankableCard, filters: CardFilters): boolean {
  if (filters.scope !== undefined && (card.scope ?? null) !== filters.scope) {
    return false;
  }

  if (filters.project_id !== undefined && (card.project_id ?? null) !== filters.project_id) {
    return false;
  }

  if (
    filters.categories !== undefined &&
    filters.categories.length > 0 &&
    !filters.categories.includes(card.category ?? "")
  ) {
    return false;
  }

  if (filters.target_model !== undefined) {
    const models = card.target_models ?? [];
    if (models.length > 0 && !models.includes(filters.target_model)) {
      return false;
    }
  }

  return true;
}

/**
 * 三级关键词命中（§10.2）。空/全空白查询返回 `null`：调用方
 * （`search_knowledge`）对空查询单独给 `EMPTY_QUERY` warning，不在这里伪装命中。
 */
export function keyword_match_level(card: RankableCard, query: string): MatchLevel | null {
  const normalized_query = normalize_text(query);
  if (normalized_query === "") {
    return null;
  }

  const title_norm = normalize_text(card.title);
  if (title_norm === normalized_query) {
    return 1;
  }
  for (const entity of card.entities ?? []) {
    if (normalize_text(entity) === normalized_query) {
      return 1;
    }
  }

  if (title_norm.includes(normalized_query)) {
    return 2;
  }
  for (const tag of card.tags ?? []) {
    if (normalize_text(tag).includes(normalized_query)) {
      return 2;
    }
  }

  if (normalize_text(card.content).includes(normalized_query)) {
    return 3;
  }
  return null;
}

/**
 * 关键词路径的完整排序：过滤 -> 命中级别 -> 五级排序（§10.1、§10.2）。
 * 不命中的卡不进入返回列表。
 */
export function rank_matching_cards<T extends RankableCard>(
  cards: readonly T[],
  filters: CardFilters,
  query: string,
): Array<RankedEntry<T>> {
  const entries: Array<RankedEntry<T>> = [];
  for (const card of cards) {
    if (!card_passes_filters(card, filters)) {
      continue;
    }
    const match_level = keyword_match_level(card, query);
    if (match_level === null) {
      continue;
    }
    entries.push({ card, match_level });
  }
  entries.sort(
    (a, b) => a.match_level - b.match_level || compare_priority_rank(a.card, b.card),
  );
  return entries;
}

/**
 * 索引不可用的回退排序（§13「按 priority 降序回退并写 warning」）：
 * `priority` 降序 -> `updated_at` 降序 -> `card_id` 升序。
 */
export function compare_priority_rank(a: RankableCard, b: RankableCard): number {
  const by_priority = compare_descending_number(
    finite_or_zero(a.priority),
    finite_or_zero(b.priority),
  );
  if (by_priority !== 0) {
    return by_priority;
  }

  const by_updated_at = compare_descending_timestamp(a.updated_at, b.updated_at);
  if (by_updated_at !== 0) {
    return by_updated_at;
  }

  return compare_ascending_text(a.card_id, b.card_id);
}

/**
 * 上下文文本：按候选顺序拼接卡片正文，卡片之间空一行，不含来源标注（§3.5）。
 * `char_budget` 就是按本函数的返回值长度比较的。
 */
export function assemble_context(contents: readonly string[]): string {
  return contents.join(CONTEXT_SEPARATOR);
}

function compare_descending_number(a: number, b: number): number {
  if (a === b) {
    return 0;
  }
  return a > b ? -1 : 1;
}

/**
 * `updated_at` 是带时区的 ISO 8601：能解析时按时间点比较，否则退回字符串比较，
 * 两种分支都确定性可复现。
 */
function compare_descending_timestamp(a: string, b: string): number {
  const time_a = Date.parse(a);
  const time_b = Date.parse(b);
  if (!Number.isNaN(time_a) && !Number.isNaN(time_b) && time_a !== time_b) {
    return time_a > time_b ? -1 : 1;
  }
  return compare_descending_text(a, b);
}

function compare_descending_text(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a > b ? -1 : 1;
}

function compare_ascending_text(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function finite_or_zero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
