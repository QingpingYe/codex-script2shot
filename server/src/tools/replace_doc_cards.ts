import path from "node:path";
import {
  to_base_fields,
  type BaseFieldMap,
  type KnowledgeCard,
  type KnowledgeScope,
} from "../base_mapping.js";
import { CONFIG_FILE_NAME, load_config, resolve_home } from "../config.js";
import {
  batch_create_records,
  batch_update_records,
  delete_records,
  list_records,
  type LarkBaseContext,
  type LarkBaseFailure,
  type ListedRecord,
} from "../lark_base.js";
import { resolve_lark_cli, type LarkCliErrorCode } from "../lark_cli.js";
import { validate_knowledge_card } from "../schemas.js";

/**
 * `replace_doc_cards` MCP Tool（架构 §6.3、§8）。
 *
 * - 两种模式二选一：
 *   - 替换模式（`cards`）：先记录该 `source_doc_token` 现有知识卡的 Base `record_id`
 *     集合（第 ① 步），再写入新卡（每 200 条一批），最后只删除第 ① 步记录的旧
 *     `record_id`。写入失败不执行删除；删除失败时新旧卡可能同时存在，不更新
 *     SyncState，下一次同步重新记录旧卡集合即可收敛。
 *   - `metadata_patch` 模式：只对现有卡批量更新来源元数据（`source_path` /
 *     `source_title` / `scope` / `project_id`），不写新卡、不删卡，卡片数量不变。
 * - 现有卡只按 `source_doc_token` 字段本地过滤；不使用 `--filter-json`（其真实形状
 *   未经 live 实测，避免猜 CLI 的过滤语法）。列表经 `list_records` 自动翻页。
 * - 输入校验：`cards` 逐条过 `validate_knowledge_card`，`card_id` 表内唯一，且每张卡的
 *   `source_doc_token` 必须等于本次要替换的文档 token（防止误删别的文档的旧卡）。
 * - `dry_run` 缺省 true：只读取现有 record_id 并在 `planned` 中列出计划，不写不删。
 * - 返回值一律是结果对象，不抛异常；错误码为 SCREAMING_SNAKE。
 */

export type ReplaceDocCardsErrorCode =
  | LarkCliErrorCode
  | "CONFIG_INVALID"
  | "CONFIG_MISSING"
  | "SCHEMA_INVALID"
  | "KB_READ_FAILED"
  | "KB_WRITE_FAILED"
  | "INTERNAL";

/** `metadata_patch` 允许更新的来源元数据字段。 */
export interface DocCardsMetadataPatch {
  source_path?: string;
  source_title?: string;
  scope?: KnowledgeScope;
  project_id?: string | null;
}

export interface ReplaceDocCardsPlan {
  mode: "replace" | "metadata_patch";
  cards_to_create: number;
  /** 第 ① 步记录的旧卡 record_id（替换模式的删除目标；metadata_patch 模式为空）。 */
  records_to_delete: string[];
  /** metadata_patch 模式要更新的 record_id；替换模式为空。 */
  records_to_update: string[];
}

export type ReplaceDocCardsWarningCode =
  | "CARD_ROW_WITHOUT_SOURCE_DOC_TOKEN"
  | "METADATA_PATCH_NO_EXISTING_CARDS";

export interface ReplaceDocCardsWarning {
  code: ReplaceDocCardsWarningCode;
  message: string;
  refs?: string[];
}

export interface ReplaceDocCardsInput {
  /** 要替换卡片的原始库文档 token（知识卡的 `source_doc_token`）。 */
  source_doc_token: string;
  /** 替换模式：该文档的完整新卡集合；与 `metadata_patch` 二选一。 */
  cards?: unknown;
  /** metadata_patch 模式：只更新来源元数据；与 `cards` 二选一。 */
  metadata_patch?: unknown;
  /** 缺省 true：只预览，不写不删。 */
  dry_run?: unknown;
  /** 默认 process.env；测试可注入受控环境。 */
  env?: NodeJS.ProcessEnv;
  /** 默认 os.homedir()；用于 lark-cli 常见安装目录探测。 */
  home_dir?: string;
}

export interface ReplaceDocCardsSuccess {
  dry_run: boolean;
  planned: ReplaceDocCardsPlan;
  created_record_ids: string[];
  deleted_record_ids: string[];
  warnings: ReplaceDocCardsWarning[];
}

export interface ReplaceDocCardsFailure {
  ok: false;
  error: {
    code: ReplaceDocCardsErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type ReplaceDocCardsResult = ReplaceDocCardsSuccess | ReplaceDocCardsFailure;

type ParsedMode =
  | { mode: "replace"; cards: KnowledgeCard[] }
  | { mode: "metadata_patch"; fields: BaseFieldMap };

export async function replace_doc_cards(
  input: ReplaceDocCardsInput,
): Promise<ReplaceDocCardsResult> {
  const source_doc_token =
    typeof input.source_doc_token === "string" ? input.source_doc_token.trim() : "";
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

  const parsed_mode = parse_mode(input, source_doc_token);
  if ("error" in parsed_mode) {
    return parsed_mode;
  }

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
    return failure("CONFIG_INVALID", "配置缺少 lark.base_b，无法访问 AI 库。", {
      field: "lark.base_b",
      path: config_path,
    });
  }
  const table_id = config.lark.knowledge_cards_table_id;
  if (!has_text(table_id)) {
    return failure(
      "CONFIG_INVALID",
      "配置缺少 lark.knowledge_cards_table_id，无法写入知识卡；请先运行 $setup 或 init_knowledge_b。",
      { field: "lark.knowledge_cards_table_id", path: config_path },
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

  // 第 ① 步：记录该 token 现有知识卡的 record_id（写入/删除之前）。
  const warnings: ReplaceDocCardsWarning[] = [];
  const listed = await list_records(base, table_id);
  if (!listed.ok) {
    return listed;
  }
  const collected = collect_existing_record_ids(
    listed.records,
    source_doc_token,
    warnings,
  );
  if ("error" in collected) {
    return collected;
  }
  const existing_record_ids = collected.record_ids;

  const planned: ReplaceDocCardsPlan =
    parsed_mode.mode === "replace"
      ? {
          mode: "replace",
          cards_to_create: parsed_mode.cards.length,
          records_to_delete: [...existing_record_ids],
          records_to_update: [],
        }
      : {
          mode: "metadata_patch",
          cards_to_create: 0,
          records_to_delete: [],
          records_to_update: [...existing_record_ids],
        };

  if (parsed_mode.mode === "metadata_patch" && existing_record_ids.length === 0) {
    warnings.push({
      code: "METADATA_PATCH_NO_EXISTING_CARDS",
      message: `文档 ${source_doc_token} 当前没有知识卡，metadata_patch 不会更新任何记录。`,
      refs: [source_doc_token],
    });
  }

  if (dry_run) {
    return {
      dry_run: true,
      planned,
      created_record_ids: [],
      deleted_record_ids: [],
      warnings,
    };
  }

  if (parsed_mode.mode === "metadata_patch") {
    if (existing_record_ids.length === 0) {
      return {
        dry_run: false,
        planned,
        created_record_ids: [],
        deleted_record_ids: [],
        warnings,
      };
    }
    const updated = await batch_update_records(
      base,
      table_id,
      existing_record_ids.map((record_id) => ({ record_id, fields: parsed_mode.fields })),
    );
    if (!updated.ok) {
      return updated;
    }
    return {
      dry_run: false,
      planned,
      created_record_ids: [],
      deleted_record_ids: [],
      warnings,
    };
  }

  // 第 ② 步：写入新卡。
  const created = await batch_create_records(
    base,
    table_id,
    parsed_mode.cards.map((card) => to_base_fields(card)),
  );
  if (!created.ok) {
    return stage_failure("create", created, {
      created_record_ids: partial_record_ids(created),
      deleted_record_ids: [],
    });
  }

  // 第 ③ 步：只删除第 ① 步记录的旧 record_id。
  if (existing_record_ids.length === 0) {
    return {
      dry_run: false,
      planned,
      created_record_ids: created.record_ids,
      deleted_record_ids: [],
      warnings,
    };
  }
  const deleted = await delete_records(base, table_id, existing_record_ids, { dry_run: false });
  if (!deleted.ok) {
    return stage_failure("delete", deleted, {
      created_record_ids: [...created.record_ids],
      deleted_record_ids: partial_record_ids(deleted),
    });
  }
  return {
    dry_run: false,
    planned,
    created_record_ids: created.record_ids,
    deleted_record_ids: deleted.record_ids,
    warnings,
  };
}

function parse_dry_run(value: unknown): { value: boolean } | ReplaceDocCardsFailure {
  if (value === undefined) {
    return { value: true };
  }
  if (typeof value !== "boolean") {
    return failure("CONFIG_INVALID", '输入字段 "dry_run" 期望布尔值。', { field: "dry_run" });
  }
  return { value };
}

function parse_mode(
  input: ReplaceDocCardsInput,
  source_doc_token: string,
): ParsedMode | ReplaceDocCardsFailure {
  const has_cards = input.cards !== undefined;
  const has_patch = input.metadata_patch !== undefined;
  if (has_cards === has_patch) {
    const provided = [
      ...(has_cards ? ["cards"] : []),
      ...(has_patch ? ["metadata_patch"] : []),
    ];
    return failure(
      "CONFIG_INVALID",
      '输入必须且只能提供 "cards" 或 "metadata_patch" 之一。',
      { fields: provided },
    );
  }
  return has_cards
    ? parse_cards_mode(input.cards, source_doc_token)
    : parse_metadata_patch_mode(input.metadata_patch);
}

function parse_cards_mode(
  value: unknown,
  source_doc_token: string,
): { mode: "replace"; cards: KnowledgeCard[] } | ReplaceDocCardsFailure {
  if (!Array.isArray(value)) {
    return failure("CONFIG_INVALID", '输入字段 "cards" 期望数组。', { field: "cards" });
  }

  const cards: KnowledgeCard[] = [];
  for (const [index, entry] of value.entries()) {
    const validated = validate_knowledge_card(entry);
    if (!validated.ok) {
      return failure("SCHEMA_INVALID", `第 ${index + 1} 张知识卡不符合 KnowledgeCard schema。`, {
        index,
        field: "cards",
        errors: validated.errors,
      });
    }
    const card = entry as KnowledgeCard;
    if (card.source_doc_token !== source_doc_token) {
      return failure(
        "SCHEMA_INVALID",
        `第 ${index + 1} 张知识卡的 source_doc_token 与本次替换的文档不一致。`,
        {
          index,
          field: "cards.source_doc_token",
          expected: source_doc_token,
          actual: card.source_doc_token,
        },
      );
    }
    cards.push(card);
  }

  const seen = new Map<string, number>();
  for (const [index, card] of cards.entries()) {
    const first_index = seen.get(card.card_id);
    if (first_index !== undefined) {
      return failure(
        "SCHEMA_INVALID",
        `输入 cards 中 card_id "${card.card_id}" 重复（第 ${first_index + 1} 张与第 ${index + 1} 张）。`,
        { field: "cards.card_id", card_id: card.card_id, first_index, duplicate_index: index },
      );
    }
    seen.set(card.card_id, index);
  }

  return { mode: "replace", cards };
}

const METADATA_PATCH_KEYS = ["source_path", "source_title", "scope", "project_id"] as const;

function parse_metadata_patch_mode(
  value: unknown,
): { mode: "metadata_patch"; fields: BaseFieldMap } | ReplaceDocCardsFailure {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return failure("CONFIG_INVALID", '输入字段 "metadata_patch" 期望对象。', {
      field: "metadata_patch",
    });
  }
  const patch = value as Record<string, unknown>;
  for (const key of Object.keys(patch)) {
    if (!(METADATA_PATCH_KEYS as readonly string[]).includes(key) || patch[key] === undefined) {
      return failure("CONFIG_INVALID", `metadata_patch 不支持字段 "${key}"。`, {
        field: `metadata_patch.${key}`,
        allowed: [...METADATA_PATCH_KEYS],
      });
    }
  }
  if (patch.source_path !== undefined && !has_text(patch.source_path)) {
    return failure("CONFIG_INVALID", 'metadata_patch.source_path 期望非空字符串。', {
      field: "metadata_patch.source_path",
    });
  }
  if (patch.source_title !== undefined && !has_text(patch.source_title)) {
    return failure("CONFIG_INVALID", 'metadata_patch.source_title 期望非空字符串。', {
      field: "metadata_patch.source_title",
    });
  }
  if (patch.scope !== undefined && patch.scope !== "general" && patch.scope !== "project") {
    return failure("CONFIG_INVALID", 'metadata_patch.scope 期望 "general" 或 "project"。', {
      field: "metadata_patch.scope",
      allowed: ["general", "project"],
    });
  }
  if (
    patch.project_id !== undefined &&
    patch.project_id !== null &&
    !has_text(patch.project_id)
  ) {
    return failure(
      "CONFIG_INVALID",
      "metadata_patch.project_id 期望非空字符串或 null（清空项目归属）。",
      { field: "metadata_patch.project_id" },
    );
  }

  const fields: BaseFieldMap = {};
  if (patch.source_path !== undefined) {
    fields.source_path = patch.source_path as string;
  }
  if (patch.source_title !== undefined) {
    fields.source_title = patch.source_title as string;
  }
  if (patch.scope !== undefined) {
    fields.scope = patch.scope as string;
  }
  if (patch.project_id !== undefined) {
    // 与 base_mapping 一致：可空文本字段写入空字符串。
    fields.project_id = (patch.project_id ?? "") as string;
  }
  if (Object.keys(fields).length === 0) {
    return failure("CONFIG_INVALID", "metadata_patch 至少要提供一个待更新字段。", {
      field: "metadata_patch",
      allowed: [...METADATA_PATCH_KEYS],
    });
  }
  return { mode: "metadata_patch", fields };
}

function collect_existing_record_ids(
  records: readonly ListedRecord[],
  source_doc_token: string,
  warnings: ReplaceDocCardsWarning[],
): { record_ids: string[] } | ReplaceDocCardsFailure {
  const record_ids: string[] = [];
  const unattributed: string[] = [];
  for (const record of records) {
    const record_id = record.record_id;
    const token_value = record.fields.source_doc_token;
    if (token_value === source_doc_token) {
      record_ids.push(record_id.trim());
      continue;
    }
    if (!has_text(token_value)) {
      unattributed.push(record_id);
    }
  }
  if (unattributed.length > 0) {
    warnings.push({
      code: "CARD_ROW_WITHOUT_SOURCE_DOC_TOKEN",
      message:
        `KnowledgeCards 中有 ${unattributed.length} 条记录缺少 source_doc_token，` +
        `本次不处理；请人工核对这些记录。`,
      refs: unattributed.slice(0, 10),
    });
  }
  return { record_ids };
}

function partial_record_ids(failure_result: LarkBaseFailure): string[] {
  const partial = failure_result.error.details?.partial_record_ids;
  return Array.isArray(partial) ? (partial as string[]) : [];
}

/**
 * 归一化写失败：写入阶段失败保留旧卡、未执行删除；删除阶段失败时新旧卡可能同时
 * 存在（不更新 SyncState，下一次同步重新记录旧卡集合即可收敛）。
 */
function stage_failure(
  stage: "create" | "delete",
  failure_result: LarkBaseFailure,
  progress: { created_record_ids: string[]; deleted_record_ids: string[] },
): ReplaceDocCardsFailure {
  const message =
    stage === "create"
      ? `写入新知识卡失败，原有知识卡保持不变，未执行删除：${failure_result.error.message}`
      : `删除旧知识卡失败，新旧知识卡可能同时存在，未更新 SyncState，可重试：${failure_result.error.message}`;
  return {
    ok: false,
    error: {
      code: failure_result.error.code,
      message,
      details: {
        ...(failure_result.error.details ?? {}),
        stage,
        created_count: progress.created_record_ids.length,
        created_record_ids: progress.created_record_ids,
        deleted_count: progress.deleted_record_ids.length,
        deleted_record_ids: progress.deleted_record_ids,
      },
    },
  };
}

function failure(
  code: ReplaceDocCardsErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ReplaceDocCardsFailure {
  return {
    ok: false,
    error: details === undefined ? { code, message } : { code, message, details },
  };
}

function has_text(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
