import { existsSync } from "node:fs";
import path from "node:path";
import {
  ensure_local_dirs,
  field_type_message,
  load_config,
  parse_project_roots,
  resolve_home,
  save_config,
  type ConfigWarning,
  type LarkConfig,
  type ProjectRoot,
  type Script2ShotConfig,
} from "../config.js";
import { SETUP_DEFAULTS } from "../setup_defaults.js";

/**
 * `write_config` MCP Tool（架构 §8）。
 *
 * - `dry_run` 缺省为 true：只返回将写入的 config.toml diff 和将创建的目录，不落盘。
 * - `dry_run: false`：按需执行 `ensure_local_dirs()`，再原子写入 config.toml。
 * - 逐字段判定顺序：**显式 > 既有（`preserve_existing` 缺省 true）> 默认**。
 *   显式提供的值（包括显式空数组）优先；否则保留磁盘上的非空值并在
 *   `preserved_existing` 里列出；再否则套 `SETUP_DEFAULTS` 并在
 *   `applied_defaults` 里列出。`preserve_existing: false` 跳过全部磁盘值，
 *   保持"纯默认覆盖"的旧语义。
 * - `lark.profile` 没有默认值：未显式传入、磁盘也没有时返回 `CONFIG_INVALID`，
 *   `details.missing_keys` 含 `lark.profile`。磁盘 TOML 损坏时不静默丢弃，
 *   同样返回 `CONFIG_INVALID`。
 * - `config`、`lark`、`retrieval` 若出现必须是普通对象，否则 CONFIG_INVALID。
 * - 返回值与错误信息里的 base_b 一律掩码（前 6 位 + `…`）；完整 token 只出现在配置文件里。
 */

export type WriteConfigErrorCode = "CONFIG_INVALID" | "INTERNAL";

export interface WriteConfigInput {
  /** 完整配置对象：`{ lark, retrieval }`，见架构 §7.3。 */
  config: unknown;
  /** 缺省 true：写入时创建本地 cache/index/logs 目录。 */
  create_local_dirs?: unknown;
  /** 缺省 true：只预览不写入。 */
  dry_run?: unknown;
  /** 缺省 true：保留磁盘上既有的非空字段；false 时按纯默认语义覆盖。 */
  preserve_existing?: unknown;
}

export interface WriteConfigSuccess {
  dry_run: boolean;
  config_path: string;
  diff: string;
  created_dirs: string[];
  written: boolean;
  /** 本次按缺省语义填充的键路径，例如 `["lark.profile", "lark.space_a"]`。 */
  applied_defaults: string[];
  /** 本次从磁盘保留的既有键路径，例如 `["lark.base_b", "lark.space_a"]`。 */
  preserved_existing: string[];
}

export interface WriteConfigFailure {
  ok: false;
  error: {
    code: WriteConfigErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type WriteConfigResult = WriteConfigSuccess | WriteConfigFailure;

/** 与 config.ts `ensure_local_dirs` 创建的目录保持一致（架构 §7.2）。 */
const LOCAL_DIR_NAMES = ["cache", "index", "logs"] as const;
const BASE_TOKEN_PREFIX_LENGTH = 6;
/** 缺省时套 `SETUP_DEFAULTS` 的字段；`profile` 不在此列，它没有默认值。 */
const DEFAULTED_LARK_STRING_KEYS = ["space_a", "base_b"] as const;
const PASSTHROUGH_LARK_STRING_KEYS = [
  "cli_path",
  "knowledge_cards_table_id",
  "sync_state_table_id",
] as const;
const EXISTING_LARK_KEYS = [
  "cli_path",
  "profile",
  "space_a",
  "base_b",
  "knowledge_cards_table_id",
  "sync_state_table_id",
] as const;

export interface NormalizeConfigOptions {
  /**
   * 缺省 true：从磁盘保留既有非空字段；false 时完全不读磁盘（`preserve_existing:
   * false` 的显式重写，以及 `pending_config` 这类"提供即替代磁盘配置"的调用）。
   */
  preserve_existing?: boolean;
}

export interface NormalizedConfig {
  config: Script2ShotConfig;
  applied_defaults: string[];
  preserved_existing: string[];
}

export function write_config(input: WriteConfigInput): WriteConfigResult {
  const preserve_existing = parse_boolean_flag(
    input.preserve_existing,
    "preserve_existing",
    true,
  );
  if ("error" in preserve_existing) {
    return preserve_existing;
  }

  const normalized = normalize_config(input.config, {
    preserve_existing: preserve_existing.value,
  });
  if ("error" in normalized) {
    return normalized;
  }
  const config = normalized.config;
  const applied_defaults = normalized.applied_defaults;
  const preserved_existing = normalized.preserved_existing;
  const dry_run = parse_boolean_flag(input.dry_run, "dry_run", true);
  if ("error" in dry_run) {
    return dry_run;
  }
  const create_local_dirs = parse_boolean_flag(
    input.create_local_dirs,
    "create_local_dirs",
    true,
  );
  if ("error" in create_local_dirs) {
    return create_local_dirs;
  }

  try {
    const previous_base_b = existing_base_b();
    if (dry_run.value) {
      const preview = save_config(config, { dry_run: true });
      return {
        dry_run: true,
        config_path: preview.path,
        diff: mask_base_b(preview.diff, [config.lark.base_b, previous_base_b]),
        created_dirs: create_local_dirs.value ? missing_local_dirs() : [],
        written: false,
        applied_defaults,
        preserved_existing,
      };
    }

    const created = create_local_dirs.value ? ensure_local_dirs().created : [];
    const saved = save_config(config, { dry_run: false });
    return {
      dry_run: false,
      config_path: saved.path,
      diff: mask_base_b(saved.diff, [config.lark.base_b, previous_base_b]),
      created_dirs: created,
      written: true,
      applied_defaults,
      preserved_existing,
    };
  } catch (error) {
    return internal_error(`写入本地配置失败：${describe_error(error)}`);
  }
}

/** 读取当前配置文件里的 base_b；文件不存在或无法解析时返回 undefined（此时靠按行兜底掩码）。 */
function existing_base_b(): string | undefined {
  const loaded = load_config();
  if ("error" in loaded || !loaded.exists) {
    return undefined;
  }
  return loaded.config.lark.base_b;
}

/** 磁盘配置里用于"保留"判定的字段快照；缺省字段不出现。 */
interface ExistingConfig {
  lark: Partial<Pick<LarkConfig, (typeof EXISTING_LARK_KEYS)[number]>>;
  project_roots: ProjectRoot[];
  default_top_k?: number;
}

/**
 * 把 `load_config()` 的结果转成"磁盘上真正写过的值"。
 *
 * `load_config()` 会对缺失的 `retrieval.default_top_k` 套默认值并写
 * `CONFIG_FIELD_DEFAULTED` warning；这里按 warning 把它还原成"磁盘上没有"，
 * 避免把默认值误记为"既有值保留"。
 */
function snapshot_existing(loaded: {
  config: Script2ShotConfig;
  warnings: ConfigWarning[];
}): ExistingConfig {
  const lark: ExistingConfig["lark"] = {};
  for (const key of EXISTING_LARK_KEYS) {
    const value = loaded.config.lark[key];
    if (value !== undefined) {
      lark[key] = value;
    }
  }
  const top_k_defaulted = loaded.warnings.some(
    (warning) =>
      warning.code === "CONFIG_FIELD_DEFAULTED" &&
      (warning.refs ?? []).includes("retrieval.default_top_k"),
  );
  return {
    lark,
    project_roots: loaded.config.lark.project_roots,
    ...(top_k_defaulted ? {} : { default_top_k: loaded.config.retrieval.default_top_k }),
  };
}

/**
 * 归一化并校验配置：**显式 > 既有（`preserve_existing`）> 默认**。
 *
 * 导出的原因是 `init_knowledge_b` / `health` 的 `pending_config` 必须复用同一套
 * 校验与默认值规则（架构 §8）；这些调用方传 `preserve_existing: false`，保证
 * 本次调用完全不读磁盘配置。
 */
export function normalize_config(
  raw: unknown,
  options: NormalizeConfigOptions = {},
): NormalizedConfig | WriteConfigFailure {
  const preserve_existing = options.preserve_existing ?? true;

  // 容器类型必须 fail-closed：null / 数组等非对象输入不得被当作空配置套默认值。
  if (!is_record(raw)) {
    return config_invalid('配置字段 "config" 必须提供且为普通对象。', { field: "config" });
  }
  const record = raw;

  const raw_lark = record.lark;
  if (raw_lark !== undefined && !is_record(raw_lark)) {
    return config_invalid('配置字段 "lark" 期望普通对象。', { field: "lark" });
  }
  const lark = is_record(raw_lark) ? raw_lark : {};

  const raw_retrieval = record.retrieval;
  if (raw_retrieval !== undefined && !is_record(raw_retrieval)) {
    return config_invalid('配置字段 "retrieval" 期望普通对象。', { field: "retrieval" });
  }

  // 只有 preserve_existing 为真时才读磁盘：磁盘配置损坏不静默丢弃。
  let existing: ExistingConfig | undefined;
  if (preserve_existing) {
    const loaded = load_config();
    if ("error" in loaded) {
      return loaded;
    }
    existing = loaded.exists ? snapshot_existing(loaded) : undefined;
  }

  const applied_defaults: string[] = [];
  const preserved_existing: string[] = [];

  const lark_config: LarkConfig = { project_roots: [] };
  for (const key of DEFAULTED_LARK_STRING_KEYS) {
    const value = lark[key];
    if (typeof value === "string") {
      lark_config[key] = value.trim();
      continue;
    }
    if (value !== undefined) {
      return config_invalid(`配置字段 "lark.${key}" 期望字符串。`, { field: `lark.${key}` });
    }
    const existing_value = existing?.lark[key];
    if (has_text(existing_value)) {
      lark_config[key] = existing_value;
      preserved_existing.push(`lark.${key}`);
      continue;
    }
    lark_config[key] = SETUP_DEFAULTS.lark[key];
    applied_defaults.push(`lark.${key}`);
  }

  // profile 没有默认值：显式 > 既有 > 缺失（后面按 CONFIG_INVALID 报 missing_keys）。
  const raw_profile = lark.profile;
  if (typeof raw_profile === "string") {
    lark_config.profile = raw_profile.trim();
  } else if (raw_profile !== undefined) {
    return config_invalid('配置字段 "lark.profile" 期望字符串。', { field: "lark.profile" });
  } else if (has_text(existing?.lark.profile)) {
    lark_config.profile = existing.lark.profile;
    preserved_existing.push("lark.profile");
  }

  for (const key of PASSTHROUGH_LARK_STRING_KEYS) {
    const value = lark[key];
    if (typeof value === "string") {
      lark_config[key] = value.trim();
      continue;
    }
    if (value !== undefined) {
      return config_invalid(`配置字段 "lark.${key}" 期望字符串。`, { field: `lark.${key}` });
    }
    const existing_value = existing?.lark[key];
    if (has_text(existing_value)) {
      lark_config[key] = existing_value;
      preserved_existing.push(`lark.${key}`);
    }
  }

  const raw_roots = lark.project_roots;
  if (raw_roots !== undefined) {
    const parsed_roots = parse_project_roots(raw_roots);
    if (!("roots" in parsed_roots)) {
      return config_invalid(parsed_roots.invalid_message, { field: parsed_roots.field });
    }
    lark_config.project_roots = parsed_roots.roots;
  } else if (existing !== undefined && existing.project_roots.length > 0) {
    // 既有映射非空才保留；空数组按"空值"处理，回落到默认映射。
    lark_config.project_roots = existing.project_roots.map((root) => ({ ...root }));
    preserved_existing.push("lark.project_roots");
  } else {
    // 克隆默认映射，避免调用方改动返回值时波及 SETUP_DEFAULTS。
    lark_config.project_roots = SETUP_DEFAULTS.lark.project_roots.map((root) => ({ ...root }));
    applied_defaults.push("lark.project_roots");
  }

  // 默认值应用后仍执行原有的必填校验：显式空值不会被默认值悄悄覆盖。
  const missing_keys: string[] = [];
  if (!has_text(lark_config.profile)) {
    missing_keys.push("lark.profile");
  }
  if (!has_text(lark_config.space_a)) {
    missing_keys.push("lark.space_a");
  }
  if (!has_text(lark_config.base_b)) {
    missing_keys.push("lark.base_b");
  }
  if (missing_keys.length > 0) {
    return config_invalid(
      `配置缺少必填项：${missing_keys.join("、")}。请补齐后重新运行 write_config。`,
      { missing_keys },
    );
  }

  let default_top_k: number;
  const raw_top_k = is_record(raw_retrieval) ? raw_retrieval.default_top_k : undefined;
  if (raw_top_k !== undefined) {
    if (typeof raw_top_k !== "number" || !Number.isInteger(raw_top_k) || raw_top_k <= 0) {
      return config_invalid(
        field_type_message("retrieval.default_top_k", "正整数", raw_top_k),
        { field: "retrieval.default_top_k" },
      );
    }
    default_top_k = raw_top_k;
  } else if (existing?.default_top_k !== undefined) {
    default_top_k = existing.default_top_k;
    preserved_existing.push("retrieval.default_top_k");
  } else {
    default_top_k = SETUP_DEFAULTS.retrieval.default_top_k;
    applied_defaults.push("retrieval.default_top_k");
  }

  return {
    config: { lark: lark_config, retrieval: { default_top_k } },
    applied_defaults,
    preserved_existing,
  };
}

function parse_boolean_flag(
  value: unknown,
  field: "dry_run" | "create_local_dirs" | "preserve_existing",
  default_value: boolean,
): { value: boolean } | WriteConfigFailure {
  if (value === undefined) {
    return { value: default_value };
  }
  if (typeof value !== "boolean") {
    return config_invalid(`配置字段 "${field}" 期望布尔值。`, { field });
  }
  return { value };
}

/** dry-run 下不调用 `ensure_local_dirs()`，只预测缺失目录；创建规则与其保持一致。 */
function missing_local_dirs(): string[] {
  const home = resolve_home();
  return LOCAL_DIR_NAMES.map((name) => path.join(home, name)).filter((dir) => !existsSync(dir));
}

function mask_base_b(diff: string, full_tokens: Array<string | undefined>): string {
  let masked = diff;
  // 整串替换同时覆盖本次写入值与旧配置值，可命中注释、上下文行等任意位置，
  // 不依赖书写形式是双引号还是单引号。
  for (const token of unique_secrets(full_tokens)) {
    masked = masked.replaceAll(token, mask_secret(token));
  }
  // 兜底：旧配置无法解析时拿不到旧值，按行掩码 base_b 字面量。
  return masked.split("\n").map(mask_base_b_line).join("\n");
}

function unique_secrets(values: Array<string | undefined>): string[] {
  const secrets = new Set<string>();
  for (const value of values) {
    if (has_text(value)) {
      secrets.add(value);
    }
  }
  // 长值先替换，避免一个 token 是另一个 token 子串时留下尾部。
  return [...secrets].sort((a, b) => b.length - a.length);
}

/**
 * 掩码一行 `base_b = "<value>"` 或 `base_b = '<value>'`，只保留值的前 6 位；
 * 找不到闭合引号时退化为首个引号截断。
 */
function mask_base_b_line(line: string): string {
  const closed = /^(.*base_b\s*=\s*)(["'])([\s\S]*)\2(.*)$/.exec(line);
  if (closed) {
    return `${closed[1]}${closed[2]}${mask_secret(closed[3])}${closed[2]}${closed[4]}`;
  }
  return line.replace(
    /(base_b\s*=\s*)(["'])([^"'\n]*)/,
    (_match, prefix: string, quote: string, value: string) =>
      `${prefix}${quote}${mask_secret(value)}`,
  );
}

function mask_secret(value: string): string {
  return `${value.slice(0, BASE_TOKEN_PREFIX_LENGTH)}…`;
}

function config_invalid(message: string, details?: Record<string, unknown>): WriteConfigFailure {
  return { ok: false, error: { code: "CONFIG_INVALID", message, details } };
}

function internal_error(message: string): WriteConfigFailure {
  return { ok: false, error: { code: "INTERNAL", message } };
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function has_text(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function describe_error(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
