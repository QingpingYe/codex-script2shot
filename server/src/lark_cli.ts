import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Script2ShotConfig } from "./config.js";

/**
 * lark-cli 适配层（架构 §7.3、§8）。
 *
 * - 只做发现、版本、登录状态和能力探测，全部是只读命令（--help / --version / auth status）。
 * - 子进程默认以参数数组直接 spawn；只有 Windows 的 .cmd/.bat 包装必须经 cmd.exe，
 *   此时按 cmd 规则逐参数转义，并以 verbatim 命令行传入（见 spawn_target）。
 * - 不向日志或错误信息写入 token / 凭据；错误详情只带截断后的 CLI 文本片段。
 */

export const DEFAULT_TIMEOUT_MS = 30_000;
export const STDERR_LIMIT = 500;
/** 每路输出（stdout / stderr）的累积上限；超限即终止子进程，避免输出无界占用内存。 */
export const DEFAULT_MAX_OUTPUT_BYTES = 1 << 20;

export type LarkCliSource = "env" | "config" | "path" | "common";
export type LarkCliErrorCode = "LARK_CLI_NOT_FOUND" | "AUTH_REQUIRED" | "INTERNAL";

export interface LarkCliError {
  code: LarkCliErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface LarkCliFailure {
  ok: false;
  error: LarkCliError;
}

export interface ResolveLarkCliOptions {
  /** 默认 process.env；测试可注入受控环境。 */
  env?: NodeJS.ProcessEnv;
  /** 默认 os.homedir()；用于展开 ~/.lark-cli 与 ~/.local/bin。 */
  home_dir?: string;
}

export type ResolveLarkCliResult =
  | { ok: true; path: string; source: LarkCliSource }
  | LarkCliFailure;

export interface RunCliOptions {
  cwd?: string;
  /** 默认 process.env；传入时会整体替换子进程环境。 */
  env?: NodeJS.ProcessEnv;
  /** 默认 30s。 */
  timeout_ms?: number;
  /** 为 true 时把退出码为 0 的 stdout 解析成 JSON；解析失败返回 INTERNAL。 */
  expect_json?: boolean;
  /** 默认 process.platform；注入后可在任意平台测试 Windows 的 cmd.exe 分支。 */
  platform?: NodeJS.Platform;
}

export type RunCliResult =
  | { ok: true; code: number; stdout: string; stderr: string; json?: unknown }
  | LarkCliFailure;

export interface GetVersionOptions {
  env?: NodeJS.ProcessEnv;
  timeout_ms?: number;
}

export type GetVersionResult = { ok: true; version: string; raw: string } | LarkCliFailure;

export interface GetAuthStatusOptions {
  verify?: boolean;
  env?: NodeJS.ProcessEnv;
  timeout_ms?: number;
}

export type GetAuthStatusResult =
  | { ok: true; logged_in: boolean; identity: string; user_name?: string }
  | LarkCliFailure;

export interface GetActiveProfileOptions {
  env?: NodeJS.ProcessEnv;
  timeout_ms?: number;
}

export type GetActiveProfileResult = { ok: true; profile: string } | LarkCliFailure;

export interface LarkCapabilities {
  wiki_node_list: boolean;
  docs_fetch: boolean;
  base_table_create: boolean;
  base_record_batch_create: boolean;
  base_record_delete: boolean;
  base_record_list: boolean;
  auth_status: boolean;
}

export interface ProbeCapabilitiesOptions {
  env?: NodeJS.ProcessEnv;
  timeout_ms?: number;
}

/**
 * 按 LARK_CLI_PATH → config.lark.cli_path → PATH → 常见目录的顺序查找 lark-cli（架构 §7.3）。
 * 显式路径只接受存在的文件；找不到时返回 LARK_CLI_NOT_FOUND 并列出搜索过的位置。
 */
export function resolve_lark_cli(
  config?: Script2ShotConfig,
  options: ResolveLarkCliOptions = {},
): ResolveLarkCliResult {
  const env = options.env ?? process.env;
  const home_dir = options.home_dir ?? os.homedir();
  const searched: string[] = [];

  const explicit_candidates: Array<{ source: LarkCliSource; value: string | undefined }> = [
    { source: "env", value: first_non_empty(env.LARK_CLI_PATH) },
    { source: "config", value: first_non_empty(config?.lark?.cli_path) },
  ];
  for (const candidate of explicit_candidates) {
    if (candidate.value === undefined) {
      continue;
    }
    const resolved = path.resolve(candidate.value);
    searched.push(resolved);
    if (is_usable_file(resolved)) {
      return { ok: true, path: resolved, source: candidate.source };
    }
  }

  const names = candidate_names();
  for (const entry of path_entries(env.PATH)) {
    for (const name of names) {
      const candidate = path.join(entry, name);
      searched.push(candidate);
      if (is_usable_file(candidate)) {
        return { ok: true, path: candidate, source: "path" };
      }
    }
  }

  for (const dir of common_directories(home_dir, env)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      searched.push(candidate);
      if (is_usable_file(candidate)) {
        return { ok: true, path: candidate, source: "common" };
      }
    }
  }

  return {
    ok: false,
    error: {
      code: "LARK_CLI_NOT_FOUND",
      message:
        "未找到 lark-cli。请安装 lark-cli，或用 LARK_CLI_PATH 环境变量 / config.toml 的 lark.cli_path 指定路径。",
      details: { searched },
    },
  };
}

/**
 * 统一子进程封装：超时、退出码、stdout/stderr 捕获和错误归一化。
 * `ok: true` 只表示进程跑完了；调用方需要自行按 `code` 判断业务结果。
 */
export function run_cli(
  cli_path: string,
  args: string[],
  options: RunCliOptions = {},
): Promise<RunCliResult> {
  const timeout_ms = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const target = spawn_target(cli_path, args, options.platform ?? process.platform);

  return new Promise<RunCliResult>((resolve) => {
    let settled = false;
    const finish = (result: RunCliResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(target.command, target.args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        windowsHide: true,
        windowsVerbatimArguments: target.windows_verbatim_arguments,
      });
    } catch (error) {
      resolve(internal_error(`无法启动 lark-cli：${describe_error(error)}`, { path: cli_path }));
      return;
    }

    const stdout_chunks: Buffer[] = [];
    const stderr_chunks: Buffer[] = [];
    const stream_bytes = { stdout: 0, stderr: 0 };
    const timer = setTimeout(() => {
      child.kill();
      // 超时立即结算：Windows 上 .cmd 包装的直接子进程是 cmd.exe，
      // 直接子进程被结束时孙进程可能仍持有管道，不能等 close 事件。
      finish(
        internal_error(`lark-cli 调用超时（${timeout_ms} ms）。`, {
          path: cli_path,
          timeout_ms,
        }),
      );
    }, timeout_ms);

    const enforce_output_limit = (stream: "stdout" | "stderr"): void => {
      child.kill();
      // 与超时一致：立即结算，不等待可能仍持有管道的孙进程退出。
      finish(
        internal_error(
          `lark-cli 的 ${stream} 输出超过上限（${DEFAULT_MAX_OUTPUT_BYTES} 字节），已终止子进程。`,
          {
            path: cli_path,
            stream,
            bytes_read: stream_bytes[stream],
            limit_bytes: DEFAULT_MAX_OUTPUT_BYTES,
          },
        ),
      );
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      stdout_chunks.push(chunk);
      stream_bytes.stdout += chunk.length;
      if (stream_bytes.stdout > DEFAULT_MAX_OUTPUT_BYTES) {
        clearTimeout(timer);
        enforce_output_limit("stdout");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      stderr_chunks.push(chunk);
      stream_bytes.stderr += chunk.length;
      if (stream_bytes.stderr > DEFAULT_MAX_OUTPUT_BYTES) {
        clearTimeout(timer);
        enforce_output_limit("stderr");
      }
    });

    child.on("error", (error: Error) => {
      clearTimeout(timer);
      finish(internal_error(`无法启动 lark-cli：${error.message}`, { path: cli_path }));
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (settled) {
        return;
      }

      const stdout = Buffer.concat(stdout_chunks).toString("utf8");
      const stderr = Buffer.concat(stderr_chunks).toString("utf8");
      const exit_code = code ?? -1;

      if (options.expect_json === true && exit_code === 0) {
        try {
          finish({ ok: true, code: exit_code, stdout, stderr, json: JSON.parse(stdout) });
        } catch {
          finish(
            internal_error("lark-cli 返回的 JSON 无法解析。", {
              path: cli_path,
              stderr: truncate(stderr),
              stderr_truncated: stderr.length > STDERR_LIMIT,
            }),
          );
        }
        return;
      }

      finish({ ok: true, code: exit_code, stdout, stderr });
    });
  });
}

/** 解析 `lark-cli version X.Y.Z`，同时保留原始输出片段。 */
export async function get_version(
  cli_path: string,
  options: GetVersionOptions = {},
): Promise<GetVersionResult> {
  const run = await run_cli(cli_path, ["--version"], options);
  if (!run.ok) {
    return run;
  }

  const raw = (run.stdout.trim() === "" ? run.stderr : run.stdout).trim();
  const match = /lark-cli version (\d+\.\d+\.\d+)/i.exec(raw);
  if (run.code !== 0 || match === null) {
    return internal_error("无法解析 lark-cli 版本输出。", {
      path: cli_path,
      exit_code: run.code,
      output: truncate(raw, 200),
    });
  }
  return { ok: true, version: match[1], raw };
}

/**
 * 执行 `auth status --json [--verify]`。
 * 退出码非 0、解析结果显式 `ok: false`，或真实形状中的用户身份不可用视为未登录；
 * JSON 解析失败归一化为 INTERNAL。兼容旧 `{ ok, data }` 形状。
 */
export async function get_auth_status(
  cli_path: string,
  options: GetAuthStatusOptions = {},
): Promise<GetAuthStatusResult> {
  const args = ["auth", "status", "--json"];
  if (options.verify === true) {
    args.push("--verify");
  }

  const run = await run_cli(cli_path, args, {
    env: options.env,
    timeout_ms: options.timeout_ms,
    expect_json: true,
  });
  if (!run.ok) {
    return run;
  }
  if (run.code !== 0) {
    return auth_required(cli_path, run.code, run.stderr);
  }

  const payload = is_record(run.json) ? run.json : {};
  if (payload.ok === false) {
    return auth_required(cli_path, run.code, run.stderr);
  }

  const identities = is_record(payload.identities) ? payload.identities : undefined;
  if (identities !== undefined) {
    const user = is_record(identities.user) ? identities.user : {};
    const status = extract_string(user, [["status"]]);
    const available = typeof user.available === "boolean" ? user.available : undefined;
    const token_status = extract_string(user, [["tokenStatus"]]);
    const identity =
      extract_string(payload, [
        ["identity"],
        ["identities", "user", "openId"],
        ["identities", "bot", "openId"],
      ]) ?? "unknown";
    const user_name = extract_string(user, [["userName"]]);

    // 真实 auth status 以 identities.user 为准：只有 ready + available 才算已登录。
    if (token_status === "expired" || available !== true || status !== "ready") {
      return auth_required(cli_path, run.code, run.stderr, {
        identity,
        user_status: status,
        user_available: available,
        token_status,
      });
    }

    return user_name === undefined
      ? { ok: true, logged_in: true, identity }
      : { ok: true, logged_in: true, identity, user_name };
  }

  // 兼容旧形状：顶层 ok 不为 false 时，沿用 data.* / snake_case 解析。
  const identity =
    extract_string(payload, [
      ["data", "identity"],
      ["data", "user", "open_id"],
      ["data", "user", "id"],
      ["data", "user", "user_id"],
      ["data", "user", "email"],
      ["data", "open_id"],
      ["identity"],
    ]) ?? "unknown";
  const user_name = extract_string(payload, [
    ["data", "user", "name"],
    ["data", "user_name"],
    ["data", "name"],
    ["user", "name"],
    ["user_name"],
  ]);

  return user_name === undefined
    ? { ok: true, logged_in: true, identity }
    : { ok: true, logged_in: true, identity, user_name };
}

/**
 * 读取 lark-cli 当前活动 profile。`profile list` 默认输出 JSON 数组，没有 `--json`
 * flag；这里只读列表，不调用 `profile use`，不切换 profile。
 */
export async function get_active_profile(
  cli_path: string,
  options: GetActiveProfileOptions = {},
): Promise<GetActiveProfileResult> {
  const run = await run_cli(cli_path, ["profile", "list"], {
    env: options.env,
    timeout_ms: options.timeout_ms,
    expect_json: true,
  });
  if (!run.ok) {
    return run;
  }
  if (run.code !== 0) {
    return internal_error("无法读取 lark-cli 活动 profile。", {
      path: cli_path,
      exit_code: run.code,
      stderr: truncate(run.stderr),
      stderr_truncated: run.stderr.length > STDERR_LIMIT,
    });
  }
  if (!Array.isArray(run.json)) {
    return internal_error("lark-cli profile list 返回的 JSON 不是数组。", {
      path: cli_path,
    });
  }

  const active_profiles = run.json
    .filter(is_record)
    .filter((profile) => profile.active === true)
    .map((profile) => (typeof profile.name === "string" ? profile.name.trim() : ""))
    .filter((name) => name !== "");
  if (active_profiles.length !== 1) {
    return internal_error(`无法确定唯一的活动 profile（找到 ${active_profiles.length} 个）。`, {
      path: cli_path,
    });
  }
  return { ok: true, profile: active_profiles[0] };
}

/**
 * 用各分组的 `--help` 输出探测能力（架构 §8），不发起真实写操作。
 * 帮助文本缺失或命令失败时对应能力为 false。
 */
export async function probe_capabilities(
  cli_path: string,
  options: ProbeCapabilitiesOptions = {},
): Promise<LarkCapabilities> {
  const [wiki_help, docs_help, base_help, auth_help] = await Promise.all([
    read_help(cli_path, "wiki", options),
    read_help(cli_path, "docs", options),
    read_help(cli_path, "base", options),
    read_help(cli_path, "auth", options),
  ]);

  return {
    wiki_node_list: wiki_help.includes("+node-list"),
    docs_fetch: docs_help.includes("+fetch"),
    base_table_create: base_help.includes("+table-create"),
    base_record_batch_create: base_help.includes("+record-batch-create"),
    base_record_delete: base_help.includes("+record-delete"),
    base_record_list: base_help.includes("+record-list"),
    auth_status: auth_help.includes("status"),
  };
}

async function read_help(
  cli_path: string,
  command: string,
  options: ProbeCapabilitiesOptions,
): Promise<string> {
  const run = await run_cli(cli_path, [command, "--help"], {
    env: options.env,
    timeout_ms: options.timeout_ms,
  });
  if (!run.ok || run.code !== 0) {
    return "";
  }
  return `${run.stdout}\n${run.stderr}`;
}

function internal_error(message: string, details: Record<string, unknown> = {}): LarkCliFailure {
  return { ok: false, error: { code: "INTERNAL", message, details } };
}

function auth_required(
  cli_path: string,
  exit_code: number,
  stderr: string,
  extra_details: Record<string, unknown> = {},
): LarkCliFailure {
  return {
    ok: false,
    error: {
      code: "AUTH_REQUIRED",
      message: "lark-cli 未登录或登录已过期，请运行 `lark-cli auth login` 后重试。",
      details: {
        path: cli_path,
        exit_code,
        stderr: truncate(stderr),
        stderr_truncated: stderr.length > STDERR_LIMIT,
        ...extra_details,
      },
    },
  };
}

const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

export interface SpawnTarget {
  command: string;
  args: string[];
  /** .cmd/.bat 的整条命令行由这里拼好，禁止 libuv 再加一层引号。 */
  windows_verbatim_arguments: boolean;
}

/**
 * 计算最终要 spawn 的命令与参数。
 * Windows 不能直接 spawn .cmd/.bat，必须经 cmd.exe；而 cmd.exe 会把参数当命令行
 * 二次解析（`%VAR%`、`&` 等会被改写），因此这里按 cmd 规则逐参数转义，并以
 * verbatim 方式传入整条命令行。其余平台保持参数数组直传，不做 shell 拼接。
 */
export function spawn_target(
  cli_path: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): SpawnTarget {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(cli_path)) {
    // .cmd 包装会把参数再解析一次（%* 展开），所以参数比命令路径多转义一层。
    const command_line = [
      escape_cmd_argument(cli_path, 1),
      ...args.map((arg) => escape_cmd_argument(arg, 2)),
    ].join(" ");
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", `"${command_line}"`],
      windows_verbatim_arguments: true,
    };
  }
  return { command: cli_path, args, windows_verbatim_arguments: false };
}

/**
 * 把一个参数转义成 cmd.exe 能原样转交的形式：
 * - 先按 CRT 规则处理内嵌双引号（`\"`）与结尾反斜杠，保证子进程能还原引号本身；
 * - 整体加引号后，再按解析层数对空格与 cmd 元字符逐字符加 `^`，
 *   避免 cmd 与 .cmd 包装再次解析（层数由调用方按 cmd 的解析次数给出）。
 */
function escape_cmd_argument(value: string, escape_layers: number): string {
  let escaped = value.replace(/(\\*)"/g, "$1$1\\\"");
  escaped = escaped.replace(/(\\*)$/, "$1$1");
  escaped = `"${escaped}"`;
  for (let layer = 0; layer < escape_layers; layer += 1) {
    escaped = escaped.replace(CMD_META_CHARS, "^$1");
  }
  return escaped;
}

function first_non_empty(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function candidate_names(): string[] {
  return process.platform === "win32"
    ? ["lark-cli.exe", "lark-cli.cmd", "lark-cli"]
    : ["lark-cli"];
}

function is_usable_file(file_path: string): boolean {
  try {
    if (!statSync(file_path).isFile()) {
      return false;
    }
    if (process.platform !== "win32") {
      accessSync(file_path, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function path_entries(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const entry of value.split(path.delimiter)) {
    const trimmed = entry.trim();
    if (trimmed === "" || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    entries.push(trimmed);
  }
  return entries;
}

function common_directories(home_dir: string, env: NodeJS.ProcessEnv): string[] {
  const dirs = [path.join(home_dir, ".lark-cli")];
  if (process.platform === "win32") {
    const local_app_data = first_non_empty(env.LOCALAPPDATA);
    if (local_app_data !== undefined) {
      dirs.push(path.join(local_app_data, "Programs", "lark-cli"));
    }
  } else {
    dirs.push("/usr/local/bin");
  }
  dirs.push(path.join(home_dir, ".local", "bin"));
  return dirs;
}

function truncate(text: string, limit = STDERR_LIMIT): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extract_string(source: Record<string, unknown>, paths: string[][]): string | undefined {
  for (const candidate_path of paths) {
    let current: unknown = source;
    for (const key of candidate_path) {
      if (!is_record(current)) {
        current = undefined;
        break;
      }
      current = current[key];
    }
    if (typeof current === "string" && current.trim() !== "") {
      return current;
    }
  }
  return undefined;
}

function describe_error(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
