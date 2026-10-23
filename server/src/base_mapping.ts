/**
 * 知识卡与 SyncState 的逻辑模型，以及逻辑模型 ↔ 飞书 Base record 字段的映射
 * （架构 §5.2、§5.3）。
 *
 * - `tags`、`entities`、`target_models` 在 Base 中存 JSON 文本数组；
 *   `priority`、`source_revision`、`card_count` 存数字。
 * - `updated_at`、`last_synced_at` 的 Base datetime CellValue 写入时固定为
 *   `YYYY-MM-DD HH:mm`（无秒）；读回时可能是同形或 ISO 8601。两种输入都按
 *   时间点换算为带 `+08:00` 的 ISO 8601，换算函数只在本模块实现
 *   （决定记录在 server/README.md）。
 * - `obj_edit_time` 是不透明字符串：原样写入、原样读回，不做任何时间换算。
 * - 可空文本字段（`project_id`、`source_block_id`）写入空字符串，读回为 null。
 * - 输入对象先按 `schemas/*.schema.json` 校验再调用本模块；读单元格遇到不可解析
 *   的 JSON 文本或 datetime 格式时抛出带字段名的错误。
 */

export type KnowledgeScope = "general" | "project";

export type KnowledgeCategory =
  | "shot_breakdown"
  | "storyboard"
  | "prompt_technique"
  | "camera_lexicon"
  | "character_bible"
  | "scene_description"
  | "visual_style"
  | "project_rule"
  | "seedance_rule"
  | "example";

export type TargetModel = "seedance-2.0" | "seedance-2.5";

export interface KnowledgeCard {
  card_id: string;
  scope: KnowledgeScope;
  project_id: string | null;
  category: KnowledgeCategory;
  title: string;
  content: string;
  tags: string[];
  entities: string[];
  target_models: TargetModel[];
  priority: number;
  source_doc_token: string;
  source_node_token: string;
  source_path: string;
  source_title: string;
  source_revision: number;
  source_block_id: string | null;
  updated_at: string;
}

export interface SyncState {
  source_doc_token: string;
  source_node_token: string;
  source_path: string;
  source_title: string;
  scope: KnowledgeScope;
  project_id: string | null;
  obj_edit_time: string;
  source_revision: number;
  card_count: number;
  last_synced_at: string;
  last_sync_user: string;
  last_run_id: string;
}

export type BaseCellValue = string | number | null;
export type BaseFieldMap = Record<string, BaseCellValue>;

/** 飞书 Base 记录：`fields` 为字段名到 CellValue 的映射（lark-cli base record 形状）。 */
export interface BaseRecord {
  record_id?: string;
  fields: BaseFieldMap;
}

/** 时间换算首版固定时区：写入和读回 Base datetime CellValue 都按 +08:00 处理。 */
export const BASE_DATETIME_OFFSET = "+08:00";

const BASE_CELL_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;
const ISO8601_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const OFFSET_MINUTES = 8 * 60;
const MINUTE_MS = 60_000;

/** 逻辑对象 → Base 字段映射；按 `card_id` 区分知识卡与 SyncState。 */
export function to_base_fields(obj: KnowledgeCard | SyncState): BaseFieldMap {
  return "card_id" in obj ? card_to_base_fields(obj) : state_to_base_fields(obj);
}

/**
 * Base 字段映射（或带 `record_id` 的整条记录）→ 逻辑对象。
 * 与 `to_base_fields` 互逆；`updated_at`、`last_synced_at` 还原为带 +08:00 的 ISO 8601。
 */
export function from_base_record(record: BaseFieldMap | BaseRecord): KnowledgeCard | SyncState {
  const fields = unwrap_fields(record);
  return "card_id" in fields ? card_from_base_fields(fields) : state_from_base_fields(fields);
}

/** ISO 8601 → Base datetime CellValue `YYYY-MM-DD HH:mm`（+08:00 墙钟时间，秒截断）。 */
export function iso8601_to_base_cell(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`无法解析 ISO 8601 时间："${iso}"。`);
  }
  const shifted = new Date(parsed.getTime() + OFFSET_MINUTES * MINUTE_MS);
  return shifted.toISOString().slice(0, 16).replace("T", " ");
}

/** Base datetime CellValue（写入形状或 ISO 8601）→ 带 `+08:00` 的 ISO 8601。 */
export function base_cell_to_iso8601(cell: string): string {
  const base_match = BASE_CELL_PATTERN.exec(cell);
  if (base_match !== null) {
    const [year, month, day, hour, minute] = base_match.slice(1);
    const normalized = `${year}-${month}-${day}T${hour}:${minute}`;
    const probe = new Date(`${normalized}:00Z`);
    if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 16) !== normalized) {
      throw new Error(`Base datetime 单元格不是有效时间："${cell}"。`);
    }
    return `${normalized}:00${BASE_DATETIME_OFFSET}`;
  }

  const iso_match = ISO8601_PATTERN.exec(cell);
  if (iso_match === null) {
    throw new Error(
      `Base datetime 单元格应为 YYYY-MM-DD HH:mm 或 ISO 8601 格式："${cell}"。`,
    );
  }
  const timestamp = parse_iso8601_timestamp(iso_match);
  if (timestamp === null) {
    throw new Error(`Base datetime 单元格不是有效时间："${cell}"。`);
  }
  const shifted = new Date(timestamp + OFFSET_MINUTES * MINUTE_MS);
  return `${shifted.toISOString().slice(0, 19)}${BASE_DATETIME_OFFSET}`;
}

function parse_iso8601_timestamp(match: RegExpExecArray): number | null {
  const [, year, month, day, hour, minute, second, , zone, sign, offset_hour, offset_minute] =
    match;
  const year_number = Number(year);
  const month_number = Number(month);
  const day_number = Number(day);
  const hour_number = Number(hour);
  const minute_number = Number(minute);
  const second_number = Number(second);
  if (
    month_number < 1 ||
    month_number > 12 ||
    day_number < 1 ||
    day_number > 31 ||
    hour_number > 23 ||
    minute_number > 59 ||
    second_number > 59
  ) {
    return null;
  }

  const probe = new Date(0);
  probe.setUTCFullYear(year_number, month_number - 1, day_number);
  probe.setUTCHours(hour_number, minute_number, second_number, 0);
  if (
    probe.getUTCFullYear() !== year_number ||
    probe.getUTCMonth() !== month_number - 1 ||
    probe.getUTCDate() !== day_number ||
    probe.getUTCHours() !== hour_number ||
    probe.getUTCMinutes() !== minute_number ||
    probe.getUTCSeconds() !== second_number
  ) {
    return null;
  }

  let offset_minutes = 0;
  if (zone !== "Z") {
    const offset_hour_number = Number(offset_hour);
    const offset_minute_number = Number(offset_minute);
    if (
      offset_minute_number > 59 ||
      offset_hour_number > 14 ||
      (offset_hour_number === 14 && offset_minute_number !== 0)
    ) {
      return null;
    }
    offset_minutes = (offset_hour_number * 60 + offset_minute_number) * (sign === "+" ? 1 : -1);
  }
  return probe.getTime() - offset_minutes * MINUTE_MS;
}

function card_to_base_fields(card: KnowledgeCard): BaseFieldMap {
  return {
    card_id: card.card_id,
    scope: card.scope,
    project_id: card.project_id ?? "",
    category: card.category,
    title: card.title,
    content: card.content,
    tags: JSON.stringify(card.tags),
    entities: JSON.stringify(card.entities),
    target_models: JSON.stringify(card.target_models),
    priority: card.priority,
    source_doc_token: card.source_doc_token,
    source_node_token: card.source_node_token,
    source_path: card.source_path,
    source_title: card.source_title,
    source_revision: card.source_revision,
    source_block_id: card.source_block_id ?? "",
    updated_at: iso8601_to_base_cell(card.updated_at),
  };
}

function state_to_base_fields(state: SyncState): BaseFieldMap {
  return {
    source_doc_token: state.source_doc_token,
    source_node_token: state.source_node_token,
    source_path: state.source_path,
    source_title: state.source_title,
    scope: state.scope,
    project_id: state.project_id ?? "",
    obj_edit_time: state.obj_edit_time,
    source_revision: state.source_revision,
    card_count: state.card_count,
    last_synced_at: iso8601_to_base_cell(state.last_synced_at),
    last_sync_user: state.last_sync_user,
    last_run_id: state.last_run_id,
  };
}

function card_from_base_fields(fields: BaseFieldMap): KnowledgeCard {
  return {
    card_id: read_text(fields, "card_id"),
    scope: read_text(fields, "scope") as KnowledgeScope,
    project_id: read_nullable_text(fields, "project_id"),
    category: read_text(fields, "category") as KnowledgeCategory,
    title: read_text(fields, "title"),
    content: read_text(fields, "content"),
    tags: read_json_text_array(fields, "tags"),
    entities: read_json_text_array(fields, "entities"),
    target_models: read_json_text_array(fields, "target_models") as TargetModel[],
    priority: read_number(fields, "priority"),
    source_doc_token: read_text(fields, "source_doc_token"),
    source_node_token: read_text(fields, "source_node_token"),
    source_path: read_text(fields, "source_path"),
    source_title: read_text(fields, "source_title"),
    source_revision: read_number(fields, "source_revision"),
    source_block_id: read_nullable_text(fields, "source_block_id"),
    updated_at: base_cell_to_iso8601(read_text(fields, "updated_at")),
  };
}

function state_from_base_fields(fields: BaseFieldMap): SyncState {
  return {
    source_doc_token: read_text(fields, "source_doc_token"),
    source_node_token: read_text(fields, "source_node_token"),
    source_path: read_text(fields, "source_path"),
    source_title: read_text(fields, "source_title"),
    scope: read_text(fields, "scope") as KnowledgeScope,
    project_id: read_nullable_text(fields, "project_id"),
    obj_edit_time: read_text(fields, "obj_edit_time"),
    source_revision: read_number(fields, "source_revision"),
    card_count: read_number(fields, "card_count"),
    last_synced_at: base_cell_to_iso8601(read_text(fields, "last_synced_at")),
    last_sync_user: read_text(fields, "last_sync_user"),
    last_run_id: read_text(fields, "last_run_id"),
  };
}

function unwrap_fields(record: BaseFieldMap | BaseRecord): BaseFieldMap {
  const fields: unknown = (record as { fields?: unknown }).fields;
  if (typeof fields === "object" && fields !== null && !Array.isArray(fields)) {
    return fields as BaseFieldMap;
  }
  return record as BaseFieldMap;
}

function read_text(fields: BaseFieldMap, name: string): string {
  const value: unknown = fields[name];
  if (typeof value === "string") {
    return value;
  }
  throw new Error(`Base 字段 "${name}" 期望文本，实际为 ${describe_cell(value)}。`);
}

function read_nullable_text(fields: BaseFieldMap, name: string): string | null {
  const value: unknown = fields[name];
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  throw new Error(`Base 字段 "${name}" 期望文本或空值，实际为 ${describe_cell(value)}。`);
}

function read_number(fields: BaseFieldMap, name: string): number {
  const value: unknown = fields[name];
  if (typeof value === "number") {
    return value;
  }
  throw new Error(`Base 字段 "${name}" 期望数字，实际为 ${describe_cell(value)}。`);
}

function read_json_text_array(fields: BaseFieldMap, name: string): string[] {
  const raw = read_text(fields, name);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Base 字段 "${name}" 不是有效的 JSON 文本数组："${raw}"。`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`Base 字段 "${name}" 不是 JSON 文本数组："${raw}"。`);
  }
  return parsed as string[];
}

function describe_cell(value: unknown): string {
  if (value === null || value === undefined) {
    return "空值";
  }
  return typeof value;
}
