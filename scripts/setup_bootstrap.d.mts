/**
 * `scripts/setup_bootstrap.mjs` 的公开契约（架构 §7.1、§5.2）。
 *
 * 脚本本身是零依赖 JS，这里只声明导入面：所有子命令返回 `BootstrapResult`，
 * `ok` 表示子命令是否成功，失败时 `error.code` 是 SCREAMING_SNAKE 错误码，
 * 成功时携带各自的产物字段（`dist_path` / `cli_path` / `profile` 等）。
 */

export interface BootstrapDeps {
  run: (
    command: string,
    args: string[],
    options?: Record<string, unknown>,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  fetch_json: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  fetch_bytes: (url: string, options?: Record<string, unknown>) => Promise<Uint8Array>;
  extract: (
    archivePath: string,
    format: string,
    destination: string,
  ) => Promise<Record<string, unknown>>;
  can_write: (target: string) => boolean;
  mcp_session: (call: {
    node_path: string;
    server_path: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout_ms?: number;
    requests: Array<{ method: string; params?: unknown }>;
  }) => Promise<
    | { ok: true; results: Array<Record<string, unknown>> }
    | { ok: false; error: { code: string; message: string } }
  >;
  remove_file: (target: string) => void;
  now: () => number;
}

export interface BootstrapOptions {
  env?: NodeJS.ProcessEnv;
  home_dir?: string;
  deps?: Partial<BootstrapDeps>;
  io?: {
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
  };
  plugin_root?: string;
  cli_path?: string;
  platform?: string;
  arch?: string;
  npm_path?: string;
  node_path?: string;
  server_path?: string;
  timeout_ms?: number;
  create?: boolean;
  force?: boolean;
  allow_global?: boolean;
  device_code?: string;
  cli_version?: string;
  node_version?: string;
  input_file?: string;
  read_stdin?: () => Promise<string>;
}

/** 子命令结果：成功时带产物字段，失败时 `error.code` 为错误码。 */
export interface BootstrapResult {
  ok: boolean;
  /**
   * 失败时出现：`{ code, message, details?, next_actions? }`；成功结果没有该字段。
   * 这里保留为 `any`，让调用方可以直接读 `error.code` 而不用先做类型收窄。
   */
  error: any;
  /** 成功时携带的产物字段（`dist_path` / `cli_path` / `profile` 等）各不相同。 */
  [key: string]: any;
}

export const EXIT_OK: number;
export const EXIT_FAILED: number;
export const EXIT_NEEDS_HUMAN: number;
export const NEEDS_HUMAN_ERROR_CODES: string[];
export const MIN_NODE_MAJOR: number;
export const NETWORK_PROBE_URL: string;
export const NODE_DIST_BASE: string;
export const NODE_INDEX_URL: string;
export const NODE_SHA256_FILE: string;
export const CHECK_IDS: string[];
export const USAGE_COMMANDS: string[];
export const LARK_CLI_PACKAGE: string;
export const LARK_CLI_TARGET_VERSION: string;
export const LARK_CLI_ARCHIVE_BASE: string;
export const MCP_PROTOCOL_VERSION: string;
export const AUTH_DOMAINS: string;

export function failure(code: string, message: string, extra?: Record<string, unknown>): BootstrapResult;
export function exit_code_for(result: unknown): number;
export function create_default_deps(): BootstrapDeps;
export function doctor(options?: BootstrapOptions): Promise<BootstrapResult>;
export function ensure_runtime(options?: BootstrapOptions): Promise<BootstrapResult>;
export function install_cli(options?: BootstrapOptions): Promise<BootstrapResult>;
export function build_server(options?: BootstrapOptions): Promise<BootstrapResult>;
export function ensure_app(options?: BootstrapOptions): Promise<BootstrapResult>;
export function auth_login(options?: BootstrapOptions): Promise<BootstrapResult>;
export function resolve_profile(options?: BootstrapOptions): Promise<BootstrapResult>;
export function call_tool(
  name: string,
  input: unknown,
  options?: BootstrapOptions,
): Promise<BootstrapResult>;
export function run_cli(argv?: string[], options?: BootstrapOptions): Promise<number>;
