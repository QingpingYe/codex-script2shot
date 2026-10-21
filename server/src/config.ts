import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, stringify, TomlError } from "smol-toml";
import { SETUP_DEFAULTS } from "./setup_defaults.js";

/**
 * 本地配置模块（架构 §7.2、§7.3）。
 *
 * - 配置目录默认 `~/.codex-script2shot`，可用 `SCRIPT2SHOT_HOME` 覆盖（测试隔离钩子）。
 * - 读写只发生在解析出的 home 下，配置内容不写入日志。
 * - 未知字段被忽略；已知字段类型不符按 CONFIG_INVALID 处理，不做强制转换。
 */

export const DEFAULT_HOME_DIR_NAME = ".codex-script2shot";
export const CONFIG_FILE_NAME = "config.toml";

const LOCAL_DIR_NAMES = ["cache", "index", "logs"] as const;
const LARK_KEYS = [
  "cli_path",
  "profile",
  "space_a",
  "base_b",
  "knowledge_cards_table_id",
  "sync_state_table_id",
] as const satisfies readonly (keyof LarkConfig)[];
const DIFF_CONTEXT_LINES = 3;

export interface LarkConfig {
  cli_path?: string;
  profile?: string;
  space_a?: string;
  base_b?: string;
  knowledge_cards_table_id?: string;
  sync_state_table_id?: string;
  project_roots: ProjectRoot[];
}

export interface ProjectRoot {
  node_token: string;
  project_id: string;
}

export interface RetrievalConfig {
  default_top_k: number;
}

export interface Script2ShotConfig {
  lark: LarkConfig;
  retrieval: RetrievalConfig;
}

export interface ConfigWarning {
  code: string;
  message: string;
  refs?: string[];
}

export interface ConfigError {
  ok: false;
  error: {
    code: "CONFIG_INVALID";
    message: string;
    details: { path: string; field?: string };
  };
}

export type LoadConfigResult =
  | { exists: false; path: string }
  | { exists: true; config: Script2ShotConfig; warnings: ConfigWarning[] }
  | ConfigError;

export interface SaveConfigResult {
  dry_run: boolean;
  path: string;
  diff: string;
}

export interface EnsureLocalDirsResult {
  created: string[];
  home: string;
}

export function resolve_home(): string {
  const override = process.env.SCRIPT2SHOT_HOME;
  if (override !== undefined && override.trim() !== "") {
    return path.resolve(override);
  }
  return path.join(os.homedir(), DEFAULT_HOME_DIR_NAME);
}

/**
 * 读取配置。文件不存在时返回 `{ exists: false, path }`，不创建任何文件或目录；
 * TOML 解析失败或已知字段类型不符时返回 CONFIG_INVALID，绝不改写用户文件。
 */
export function load_config(): LoadConfigResult {
  const file_path = config_path(resolve_home());
  const raw = read_config_text(file_path);
  if (raw === undefined) {
    return { exists: false, path: file_path };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parse(raw);
  } catch (error) {
    return invalid_config(file_path, `配置文件不是有效的 TOML：${describe_error(error)}`);
  }

  const built = build_config(parsed);
  if ("invalid_message" in built) {
    return invalid_config(file_path, built.invalid_message, built.invalid_field);
  }
  return { exists: true, config: built.config, warnings: built.warnings };
}

/**
 * 保存配置。`dry_run` 缺省为 true：只返回人类可读 diff，不写任何文件。
 * 实际写入使用同目录临时文件 + 原子替换；写入内容完全来自传入对象，不保留未知字段。
 */
export function save_config(
  config: Script2ShotConfig,
  options: { dry_run?: boolean } = {},
): SaveConfigResult {
  const dry_run = options.dry_run ?? true;
  const home = resolve_home();
  const file_path = config_path(home);
  const before = read_config_text(file_path) ?? null;
  const content = stringify_config(config);
  const diff = format_diff(file_path, before, content);

  if (dry_run) {
    return { dry_run: true, path: file_path, diff };
  }

  mkdirSync(home, { recursive: true });
  const temp_path = `${file_path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp_path, content, "utf8");
    renameSync(temp_path, file_path);
  } catch (error) {
    rmSync(temp_path, { force: true });
    throw error;
  }
  return { dry_run: false, path: file_path, diff };
}

/** 幂等创建本地数据目录（架构 §7.2），返回本次实际创建的目录清单。 */
export function ensure_local_dirs(): EnsureLocalDirsResult {
  const home = resolve_home();
  const created: string[] = [];
  for (const name of LOCAL_DIR_NAMES) {
    const dir = path.join(home, name);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      created.push(dir);
    }
  }
  return { created, home };
}

function config_path(home: string): string {
  return path.join(home, CONFIG_FILE_NAME);
}

function read_config_text(file_path: string): string | undefined {
  try {
    return readFileSync(file_path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function invalid_config(file_path: string, message: string, field?: string): ConfigError {
  const details: { path: string; field?: string } = { path: file_path };
  if (field !== undefined) {
    details.field = field;
  }
  return { ok: false, error: { code: "CONFIG_INVALID", message, details } };
}

function build_config(
  parsed: Record<string, unknown>,
):
  | { config: Script2ShotConfig; warnings: ConfigWarning[] }
  | { invalid_message: string; invalid_field?: string } {
  const warnings: ConfigWarning[] = [];

  const lark_value = parsed.lark;
  if (lark_value !== undefined && !is_table(lark_value)) {
    return { invalid_message: field_type_message("lark", "表（table）", lark_value) };
  }
  const lark_table = is_table(lark_value) ? lark_value : {};
  const lark: LarkConfig = { project_roots: [] };
  for (const key of LARK_KEYS) {
    const value = lark_table[key];
    if (value === undefined) {
      warnings.push({
        code: "CONFIG_FIELD_MISSING",
        message: `配置缺少 lark.${key}，不会自动猜测该值。`,
        refs: [`lark.${key}`],
      });
      continue;
    }
    if (typeof value !== "string") {
      return { invalid_message: field_type_message(`lark.${key}`, "字符串", value) };
    }
    lark[key] = value;
  }

  const roots_value = lark_table.project_roots;
  if (roots_value !== undefined) {
    // 缺省即「没有项目根节点映射」：保持空数组，不算配置缺失、不产生 warning。
    const parsed_roots = parse_project_roots(roots_value);
    if (!("roots" in parsed_roots)) {
      return {
        invalid_message: parsed_roots.invalid_message,
        invalid_field: parsed_roots.field,
      };
    }
    lark.project_roots = parsed_roots.roots;
  }

  const retrieval_value = parsed.retrieval;
  if (retrieval_value !== undefined && !is_table(retrieval_value)) {
    return { invalid_message: field_type_message("retrieval", "表（table）", retrieval_value) };
  }
  const retrieval_table = is_table(retrieval_value) ? retrieval_value : {};
  const top_k_value = retrieval_table.default_top_k;
  let default_top_k: number;
  if (top_k_value === undefined) {
    default_top_k = SETUP_DEFAULTS.retrieval.default_top_k;
    warnings.push({
      code: "CONFIG_FIELD_DEFAULTED",
      message: `配置缺少 retrieval.default_top_k，使用默认值 ${SETUP_DEFAULTS.retrieval.default_top_k}。`,
      refs: ["retrieval.default_top_k"],
    });
  } else if (typeof top_k_value !== "number" || !Number.isInteger(top_k_value)) {
    return { invalid_message: field_type_message("retrieval.default_top_k", "整数", top_k_value) };
  } else {
    default_top_k = top_k_value;
  }

  return { config: { lark, retrieval: { default_top_k } }, warnings };
}

/**
 * 校验 `lark.project_roots`：必须是数组表，每项含非空字符串 `node_token` 与
 * `project_id`。失败时返回出错字段的完整路径，供 load / write_config 回填
 * `details.field`。
 */
export function parse_project_roots(
  value: unknown,
): { roots: ProjectRoot[] } | { invalid_message: string; field: string } {
  if (!Array.isArray(value)) {
    return {
      invalid_message: field_type_message("lark.project_roots", "数组表（array of tables）", value),
      field: "lark.project_roots",
    };
  }

  const roots: ProjectRoot[] = [];
  for (const [index, entry] of value.entries()) {
    const entry_field = `lark.project_roots[${index}]`;
    if (!is_table(entry)) {
      return { invalid_message: field_type_message(entry_field, "表（table）", entry), field: entry_field };
    }

    const node_token = entry.node_token;
    if (typeof node_token !== "string" || node_token.trim() === "") {
      return {
        invalid_message: field_type_message(`${entry_field}.node_token`, "非空字符串", node_token),
        field: `${entry_field}.node_token`,
      };
    }

    const project_id = entry.project_id;
    if (typeof project_id !== "string" || project_id.trim() === "") {
      return {
        invalid_message: field_type_message(
          `${entry_field}.project_id`,
          "非空字符串",
          project_id,
        ),
        field: `${entry_field}.project_id`,
      };
    }

    roots.push({ node_token: node_token.trim(), project_id: project_id.trim() });
  }
  return { roots };
}

function stringify_config(config: Script2ShotConfig): string {
  const lark: Record<string, string | ProjectRoot[]> = {};
  for (const key of LARK_KEYS) {
    const value = config.lark[key];
    if (value !== undefined) {
      lark[key] = value;
    }
  }
  if (config.lark.project_roots !== undefined) {
    lark.project_roots = config.lark.project_roots.map((root) => ({ ...root }));
  }
  return stringify({ lark, retrieval: { default_top_k: config.retrieval.default_top_k } });
}

function format_diff(file_path: string, before: string | null, after: string): string {
  const lines_before = before === null ? [] : split_lines(before);
  const lines_after = split_lines(after);

  let prefix = 0;
  while (
    prefix < lines_before.length &&
    prefix < lines_after.length &&
    lines_before[prefix] === lines_after[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < lines_before.length - prefix &&
    suffix < lines_after.length - prefix &&
    lines_before[lines_before.length - 1 - suffix] === lines_after[lines_after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const header = [
    `--- ${file_path}${before === null ? "（当前不存在）" : "（当前内容）"}`,
    `+++ ${file_path}（将写入）`,
  ];
  const removed = lines_before.slice(prefix, lines_before.length - suffix);
  const added = lines_after.slice(prefix, lines_after.length - suffix);
  if (removed.length === 0 && added.length === 0) {
    return [...header, "（无变化）"].join("\n");
  }

  const context_before = lines_before.slice(Math.max(0, prefix - DIFF_CONTEXT_LINES), prefix);
  const context_after = lines_before.slice(
    lines_before.length - suffix,
    lines_before.length - suffix + DIFF_CONTEXT_LINES,
  );
  const start_line = prefix - context_before.length + 1;
  return [
    ...header,
    `@@ -${start_line},${context_before.length + removed.length + context_after.length} ` +
      `+${start_line},${context_before.length + added.length + context_after.length} @@`,
    ...context_before.map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    ...context_after.map((line) => ` ${line}`),
  ].join("\n");
}

function split_lines(text: string): string[] {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function is_table(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe_value(value: unknown): string {
  if (Array.isArray(value)) {
    return "数组";
  }
  if (typeof value === "string" && value.trim() === "") {
    return "空字符串";
  }
  if (typeof value === "number" && !Number.isInteger(value)) {
    return "小数";
  }
  if (value === null) {
    return "空值";
  }
  return typeof value;
}

function field_type_message(field: string, expected: string, actual: unknown): string {
  return `配置字段 "${field}" 期望${expected}，实际为 ${describe_value(actual)}。`;
}

function describe_error(error: unknown): string {
  if (error instanceof TomlError) {
    return `${error.message}（第 ${error.line} 行，第 ${error.column} 列）`;
  }
  return error instanceof Error ? error.message : String(error);
}
