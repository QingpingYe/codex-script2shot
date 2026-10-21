import { existsSync } from "node:fs";
import path from "node:path";
import {
  ensure_local_dirs,
  load_config,
  parse_project_roots,
  resolve_home,
  save_config,
  type LarkConfig,
  type Script2ShotConfig,
} from "../config.js";
import { SETUP_DEFAULTS } from "../setup_defaults.js";

/**
 * `write_config` MCP Tool（架构 §8）。
 *
 * - `dry_run` 缺省为 true：只返回将写入的 config.toml diff 和将创建的目录，不落盘。
 * - `dry_run: false`：按需执行 `ensure_local_dirs()`，再原子写入 config.toml。
 * - `config` 里缺省的字段（profile / space_a / base_b / project_roots）用
 *   `SETUP_DEFAULTS` 填充，显式提供的值（包括显式空数组）优先；
 *   返回值用 `applied_defaults` 列出实际套用的默认键路径。
 * - 返回值与错误信息里的 base_b 一律掩码（前 6 位 + `…`）；完整 token 只出现在配置文件里。
 */

export type WriteConfigErrorCode = "CONFIG_INVALID" | "INTERNAL";

export interface WriteConfigInput {
  /** 完整配置对象：`{ lark, retrieval }`，见架构 §7.3。 */
  config?: unknown;
  /** 缺省 true：写入时创建本地 cache/index/logs 目录。 */
  create_local_dirs?: boolean;
  /** 缺省 true：只预览不写入。 */
  dry_run?: boolean;
}

export interface WriteConfigSuccess {
  dry_run: boolean;
  config_path: string;
  diff: string;
  created_dirs: string[];
  written: boolean;
  /** 本次按缺省语义填充的键路径，例如 `["lark.profile", "lark.space_a"]`。 */
  applied_defaults: string[];
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
const DEFAULTED_LARK_STRING_KEYS = ["profile", "space_a", "base_b"] as const;
const PASSTHROUGH_LARK_STRING_KEYS = [
  "cli_path",
  "knowledge_cards_table_id",
  "sync_state_table_id",
] as const;

export function write_config(input: WriteConfigInput = {}): WriteConfigResult {
  const normalized = normalize_config(input.config);
  if ("error" in normalized) {
    return normalized;
  }
  const config = normalized.config;
  const applied_defaults = normalized.applied_defaults;
  const dry_run = input.dry_run ?? true;
  const create_local_dirs = input.create_local_dirs ?? true;

  try {
    const previous_base_b = existing_base_b();
    if (dry_run) {
      const preview = save_config(config, { dry_run: true });
      return {
        dry_run: true,
        config_path: preview.path,
        diff: mask_base_b(preview.diff, [config.lark.base_b, previous_base_b]),
        created_dirs: create_local_dirs ? missing_local_dirs() : [],
        written: false,
        applied_defaults,
      };
    }

    const created = create_local_dirs ? ensure_local_dirs().created : [];
    const saved = save_config(config, { dry_run: false });
    return {
      dry_run: false,
      config_path: saved.path,
      diff: mask_base_b(saved.diff, [config.lark.base_b, previous_base_b]),
      created_dirs: created,
      written: true,
      applied_defaults,
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

function normalize_config(
  raw: unknown,
): { config: Script2ShotConfig; applied_defaults: string[] } | WriteConfigFailure {
  const record = is_record(raw) ? raw : {};
  const lark = is_record(record.lark) ? record.lark : {};
  const applied_defaults: string[] = [];

  const lark_config: LarkConfig = { project_roots: [] };
  for (const key of DEFAULTED_LARK_STRING_KEYS) {
    const value = lark[key];
    if (value === undefined) {
      lark_config[key] = SETUP_DEFAULTS.lark[key];
      applied_defaults.push(`lark.${key}`);
    } else if (typeof value === "string") {
      lark_config[key] = value;
    } else {
      return config_invalid(`配置字段 "lark.${key}" 期望字符串。`, { field: `lark.${key}` });
    }
  }

  for (const key of PASSTHROUGH_LARK_STRING_KEYS) {
    const value = lark[key];
    if (typeof value === "string") {
      lark_config[key] = value;
    }
  }

  const raw_roots = lark.project_roots;
  if (raw_roots === undefined) {
    // 克隆默认映射，避免调用方改动返回值时波及 SETUP_DEFAULTS。
    lark_config.project_roots = SETUP_DEFAULTS.lark.project_roots.map((root) => ({ ...root }));
    applied_defaults.push("lark.project_roots");
  } else {
    const parsed_roots = parse_project_roots(raw_roots);
    if (!("roots" in parsed_roots)) {
      return config_invalid(parsed_roots.invalid_message, { field: parsed_roots.field });
    }
    lark_config.project_roots = parsed_roots.roots;
  }

  // 默认值应用后仍执行原有的必填校验：显式空值不会被默认值悄悄覆盖。
  const missing_keys: string[] = [];
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

  let default_top_k = SETUP_DEFAULTS.retrieval.default_top_k;
  const raw_top_k = is_record(record.retrieval) ? record.retrieval.default_top_k : undefined;
  if (raw_top_k !== undefined) {
    if (typeof raw_top_k !== "number" || !Number.isInteger(raw_top_k)) {
      return config_invalid('配置字段 "retrieval.default_top_k" 期望整数。', {
        field: "retrieval.default_top_k",
      });
    }
    default_top_k = raw_top_k;
  }

  return {
    config: { lark: lark_config, retrieval: { default_top_k } },
    applied_defaults,
  };
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
