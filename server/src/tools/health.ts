import { existsSync, statSync } from "node:fs";
import path from "node:path";
import {
  CONFIG_FILE_NAME,
  load_config,
  resolve_home,
  type LoadConfigResult,
  type Script2ShotConfig,
} from "../config.js";
import {
  get_active_profile,
  get_auth_status,
  get_version,
  resolve_lark_cli,
  run_cli,
  type RunCliResult,
} from "../lark_cli.js";

/**
 * 健康检查工具（架构 §8、§13）。
 *
 * - 全部只读：只读取配置、探测 lark-cli 和检查目录是否存在，不创建任何文件或目录。
 * - 单项失败不中断后续检查；依赖项不可用时对应 check 记 warn 并注明「已跳过」。
 * - detail 只放非敏感字段：路径、版本、table_id、base token 前 6 位。
 */

export type HealthCheckId =
  | "lark_cli"
  | "lark_cli_version"
  | "lark_profile"
  | "auth"
  | "config"
  | "space_a_reachable"
  | "base_b_reachable"
  | "local_dirs"
  | "index";

export type HealthStatus = "pass" | "warn" | "fail";

export interface HealthCheck {
  id: HealthCheckId;
  status: HealthStatus;
  message: string;
  detail?: Record<string, unknown>;
}

export interface HealthWarning {
  /** SCREAMING_SNAKE 语义码，供下游按 code + message 聚合去重。 */
  code: string;
  message: string;
}

export interface HealthResult {
  ok: boolean;
  checks: HealthCheck[];
  warnings: HealthWarning[];
}

export interface HealthOptions {
  /** 默认 process.env；测试可注入受控环境。 */
  env?: NodeJS.ProcessEnv;
  /** 默认 os.homedir()；用于 lark-cli 常见安装目录探测。 */
  home_dir?: string;
}

const LOCAL_DIR_NAMES = ["cache", "index", "logs"] as const;
const BASE_TOKEN_PREFIX_LENGTH = 6;

export async function health(options: HealthOptions = {}): Promise<HealthResult> {
  const checks: HealthCheck[] = [];
  const warnings: HealthWarning[] = [];
  const env = options.env;
  const home = resolve_home();

  const config_result = load_config();
  const config = loaded_config(config_result);

  const cli = resolve_lark_cli(config, { env, home_dir: options.home_dir });
  const cli_path = cli.ok ? cli.path : undefined;
  if (cli.ok) {
    push_check(checks, warnings, {
      id: "lark_cli",
      status: "pass",
      message: `已找到 lark-cli：${cli.path}`,
      detail: { path: cli.path, source: cli.source },
    });
  } else {
    push_check(checks, warnings, {
      id: "lark_cli",
      status: "fail",
      message: cli.error.message,
      detail: { code: cli.error.code, searched: cli.error.details?.searched },
    });
  }

  if (cli_path === undefined) {
    push_skipped(checks, warnings, "lark_cli_version", "lark-cli 不可用");
  } else {
    const version = await get_version(cli_path, { env });
    if (version.ok) {
      push_check(checks, warnings, {
        id: "lark_cli_version",
        status: "pass",
        message: `lark-cli 版本 ${version.version}`,
        detail: { version: version.version, path: cli_path },
      });
    } else {
      push_check(checks, warnings, {
        id: "lark_cli_version",
        status: "fail",
        message: version.error.message,
        detail: { code: version.error.code, path: cli_path },
      });
    }
  }

  let auth_ok = false;
  if (cli_path === undefined) {
    push_skipped(checks, warnings, "auth", "lark-cli 不可用");
  } else {
    const auth = await get_auth_status(cli_path, { env, verify: true });
    if (auth.ok) {
      auth_ok = true;
      push_check(checks, warnings, {
        id: "auth",
        status: "pass",
        message:
          auth.user_name === undefined
            ? `lark-cli 已登录（${auth.identity}）`
            : `lark-cli 已登录：${auth.user_name}`,
        detail: {
          identity: auth.identity,
          ...(auth.user_name === undefined ? {} : { user_name: auth.user_name }),
        },
      });
    } else {
      push_check(checks, warnings, {
        id: "auth",
        status: "fail",
        message: `lark-cli 登录状态检查失败，请运行 lark-cli auth login 后重试。`,
        detail: { code: auth.error.code, reason: auth.error.message },
      });
    }
  }

  if ("error" in config_result) {
    push_check(checks, warnings, {
      id: "config",
      status: "fail",
      message: config_result.error.message,
      detail: { code: "CONFIG_INVALID", path: config_result.error.details.path },
    });
  } else if (!config_result.exists) {
    const config_path = config_result.path;
    push_check(checks, warnings, {
      id: "config",
      status: "fail",
      message: `未找到配置文件：${config_path}。请先运行 $setup 完成初始化。`,
      detail: { code: "CONFIG_MISSING", path: config_path, hint: "先运行 $setup 生成配置。" },
    });
  } else {
    const config_path = path.join(home, CONFIG_FILE_NAME);
    const missing_keys: string[] = [];
    if (!has_text(config?.lark.space_a)) {
      missing_keys.push("lark.space_a");
    }
    if (!has_text(config?.lark.base_b)) {
      missing_keys.push("lark.base_b");
    }
    if (missing_keys.length > 0) {
      push_check(checks, warnings, {
        id: "config",
        status: "fail",
        message: `配置文件缺少必填项：${missing_keys.join("、")}。请先运行 $setup。`,
        detail: { code: "CONFIG_INCOMPLETE", path: config_path, missing_keys },
      });
    } else {
      push_check(checks, warnings, {
        id: "config",
        status: "pass",
        message: `配置已加载：${config_path}`,
        detail: { path: config_path },
      });
    }
  }

  const expected_profile = config?.lark.profile;
  if (cli_path !== undefined && has_text(expected_profile)) {
    const active_profile = await get_active_profile(cli_path, { env });
    if (!active_profile.ok) {
      push_check(
        checks,
        warnings,
        {
          id: "lark_profile",
          status: "warn",
          message: `无法读取当前活动 profile，未能校验配置中的 "${expected_profile}"。`,
          detail: {
            code: "LARK_PROFILE_UNKNOWN",
            expected_profile,
            reason: active_profile.error.message,
          },
        },
        "LARK_PROFILE_UNKNOWN",
      );
    } else if (active_profile.profile !== expected_profile) {
      push_check(
        checks,
        warnings,
        {
          id: "lark_profile",
          status: "warn",
          message:
            `配置期望活动 profile 为 "${expected_profile}"，当前为 "${active_profile.profile}"。` +
            `请运行 \`lark-cli profile use ${expected_profile}\`（需你本人确认）；插件不会自动切换 profile。`,
          detail: {
            code: "LARK_PROFILE_MISMATCH",
            expected_profile,
            active_profile: active_profile.profile,
            plugin_switches_profile: false,
          },
        },
        "LARK_PROFILE_MISMATCH",
      );
    }
  }

  const space_a = config?.lark.space_a;
  if (cli_path === undefined) {
    push_skipped(checks, warnings, "space_a_reachable", "lark-cli 不可用");
  } else if (!auth_ok) {
    push_skipped(checks, warnings, "space_a_reachable", "lark-cli 未登录");
  } else if (!has_text(space_a)) {
    push_skipped(checks, warnings, "space_a_reachable", "配置缺少 lark.space_a");
  } else {
    const run = await run_cli(
      cli_path,
      ["wiki", "+node-list", "--space-id", space_a, "--page-size", "1", "--as", "user"],
      { env, expect_json: true },
    );
    const exit_code = run.ok ? run.code : undefined;
    if (probe_ok(run)) {
      push_check(checks, warnings, {
        id: "space_a_reachable",
        status: "pass",
        message: `知识库 A 可达（space_id：${space_a}）。`,
        detail: { space_id: space_a },
      });
    } else {
      push_check(checks, warnings, {
        id: "space_a_reachable",
        status: "fail",
        message: `知识库 A 不可达（space_id：${space_a}），请检查 space_a 与访问权限。`,
        detail: {
          code: "KB_A_UNREACHABLE",
          space_id: space_a,
          exit_code,
        },
      });
    }
  }

  const base_b = config?.lark.base_b;
  if (cli_path === undefined) {
    push_skipped(checks, warnings, "base_b_reachable", "lark-cli 不可用");
  } else if (!auth_ok) {
    push_skipped(checks, warnings, "base_b_reachable", "lark-cli 未登录");
  } else if (!has_text(base_b)) {
    push_skipped(checks, warnings, "base_b_reachable", "配置缺少 lark.base_b");
  } else {
    const base_token_prefix = base_b.slice(0, BASE_TOKEN_PREFIX_LENGTH);
    const run = await run_cli(cli_path, ["base", "+table-list", "--base-token", base_b], {
      env,
      expect_json: true,
    });
    const exit_code = run.ok ? run.code : undefined;
    if (!probe_ok(run)) {
      push_check(checks, warnings, {
        id: "base_b_reachable",
        status: "fail",
        message: `知识库 B 不可达（base token 前缀 ${base_token_prefix}），请检查 base_b 与访问权限。`,
        detail: {
          code: "KB_B_UNREACHABLE",
          base_token_prefix,
          exit_code,
        },
      });
    } else {
      const table_ids = extract_table_ids(run.json);
      const configured_tables = [
        config?.lark.knowledge_cards_table_id,
        config?.lark.sync_state_table_id,
      ].filter(has_text);
      if (configured_tables.length === 0) {
        const warning_message = "table_id 未配置（setup 初始化后填写）";
        warnings.push({ code: "TABLE_ID_NOT_CONFIGURED", message: warning_message });
        push_check(checks, warnings, {
          id: "base_b_reachable",
          status: "pass",
          message: `知识库 B 可达；${warning_message}。`,
          detail: { base_token_prefix, warning: warning_message, tables: table_ids },
        });
      } else {
        const missing_tables = configured_tables.filter((table_id) => !table_ids.includes(table_id));
        if (missing_tables.length > 0) {
          push_check(checks, warnings, {
            id: "base_b_reachable",
            status: "fail",
            message:
              `知识库 B 缺少配置的数据表：${missing_tables.join("、")}。` +
              `请在 Phase 2 运行 $setup（调用 init_knowledge_b）建表。`,
            detail: {
              code: "KB_B_TABLE_MISSING",
              hint: "Phase 2 运行 $setup 并调用 init_knowledge_b。",
              base_token_prefix,
              missing_tables,
              tables: table_ids,
            },
          });
        } else {
          push_check(checks, warnings, {
            id: "base_b_reachable",
            status: "pass",
            message: `知识库 B 可达，已校验数据表：${configured_tables.join("、")}。`,
            detail: { base_token_prefix, checked_tables: configured_tables },
          });
        }
      }
    }
  }

  const missing_dirs = LOCAL_DIR_NAMES.filter((name) => !is_directory(path.join(home, name)));
  if (missing_dirs.length > 0) {
    push_check(
      checks,
      warnings,
      {
        id: "local_dirs",
        status: "warn",
        message: `本地目录缺失：${missing_dirs.join("、")}。请运行 $setup。`,
        detail: { home, missing: [...missing_dirs] },
      },
      "LOCAL_DIRS_MISSING",
    );
  } else {
    push_check(checks, warnings, {
      id: "local_dirs",
      status: "pass",
      message: `本地目录已就绪：${home}`,
      detail: { home },
    });
  }

  push_check(
    checks,
    warnings,
    {
      id: "index",
      status: "warn",
      message: "本地索引尚未构建（Phase 1 仅报告占位状态）。",
      detail: { state: "not_built" },
    },
    "INDEX_NOT_BUILT",
  );

  const ok = checks.every((entry) => entry.status !== "fail");
  return { ok, checks, warnings };
}

function loaded_config(result: LoadConfigResult): Script2ShotConfig | undefined {
  if ("error" in result || !result.exists) {
    return undefined;
  }
  return result.config;
}

function push_check(
  checks: HealthCheck[],
  warnings: HealthWarning[],
  check: HealthCheck,
  warning_code?: string,
): void {
  checks.push(check);
  if (check.status === "warn") {
    warnings.push({ code: warning_code ?? check.id.toUpperCase(), message: check.message });
  }
}

function push_skipped(
  checks: HealthCheck[],
  warnings: HealthWarning[],
  id: HealthCheckId,
  reason: string,
): void {
  push_check(
    checks,
    warnings,
    {
      id,
      status: "warn",
      message: `已跳过：${reason}。`,
      detail: { skipped: true, reason },
    },
    `${id.toUpperCase()}_SKIPPED`,
  );
}

function probe_ok(run: RunCliResult): run is Extract<RunCliResult, { ok: true }> {
  if (!run.ok || run.code !== 0) {
    return false;
  }
  return !(is_record(run.json) && run.json.ok === false);
}

function extract_table_ids(payload: unknown): string[] {
  const table_ids: string[] = [];
  const seen = new Set<string>();

  // 真实 `base +table-list` 形状：data.tables[].id；旧形状的 table_id 继续兼容。
  if (is_record(payload) && is_record(payload.data) && Array.isArray(payload.data.tables)) {
    for (const table of payload.data.tables) {
      if (!is_record(table)) {
        continue;
      }
      const table_id = first_table_id(table);
      if (table_id !== undefined && !seen.has(table_id)) {
        seen.add(table_id);
        table_ids.push(table_id);
      }
    }
    return table_ids;
  }

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (!is_record(value)) {
      return;
    }
    const table_id = first_table_id(value, ["table_id"]);
    if (table_id !== undefined && !seen.has(table_id)) {
      seen.add(table_id);
      table_ids.push(table_id);
    }
    for (const child of Object.values(value)) {
      visit(child);
    }
  };
  visit(payload);
  return table_ids;
}

function first_table_id(
  table: Record<string, unknown>,
  keys: readonly string[] = ["id", "table_id"],
): string | undefined {
  for (const key of keys) {
    const value = table[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function is_directory(dir: string): boolean {
  try {
    return existsSync(dir) && statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function has_text(value: string | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}
