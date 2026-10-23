#!/usr/bin/env node
/**
 * setup 自举脚本（架构 §7.1、§5.2）。
 *
 * - 纯 ESM、零依赖：`server/node_modules` 不存在也能运行。
 * - 子命令输出 JSON 到 stdout；进度与人类可读信息走 stderr；敏感值一律掩码。
 * - 退出码：0 成功、1 失败（调用方读 error.code）、2 需要人类动作或提权。
 * - 所有外部动作（子进程、网络、解压、时钟）都经 `deps` 注入，测试不触碰真实环境。
 */

import { accessSync, constants, existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_NEEDS_HUMAN = 2;

/** 这些错误码对应"需要人类动作或提权"，退出码固定为 2（架构 §7.1）。 */
export const NEEDS_HUMAN_ERROR_CODES = [
  "APP_REGISTRATION_PENDING",
  "AUTH_LOGIN_PENDING",
  "NEEDS_ESCALATION",
];

export const MIN_NODE_MAJOR = 24;
export const NETWORK_PROBE_URL = "https://registry.npmjs.org/-/ping";
export const CHECK_IDS = [
  "plugin_dir",
  "node",
  "npm",
  "network",
  "home",
  "lark_cli",
  "config",
  "dist",
  "index",
];

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "..");
const HOME_DIR_NAME = ".codex-script2shot";
const PRIVATE_CLI_RELATIVE = ["cli", "node_modules", "@larksuite", "cli", "bin"];
const CONFIG_FILE_NAME = "config.toml";

/** 失败形状：调用方按 `error.code` 处置，`next_actions` 给 AI 的下一步。 */
export function failure(code, message, extra = {}) {
  return { ok: false, error: { code, message, ...extra } };
}

/** 退出码映射：成功 0，需要人类动作 / 提权 2，其余失败 1。 */
export function exit_code_for(result) {
  if (result !== undefined && result.ok === true) {
    return EXIT_OK;
  }
  return NEEDS_HUMAN_ERROR_CODES.includes(result?.error?.code)
    ? EXIT_NEEDS_HUMAN
    : EXIT_FAILED;
}

function default_io() {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

/** 子进程统一入口：永远 resolve，用 `code` 表达结果，不抛异常。 */
async function run_process(command, args, options = {}) {
  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: options.shell ?? false,
        windowsHide: true,
      });
    } catch (error) {
      resolve({ code: -1, stdout: "", stderr: describe_error(error) });
      return;
    }
    const stdout = [];
    const stderr = [];
    const timer =
      typeof options.timeout_ms === "number"
        ? setTimeout(() => {
            child.kill();
          }, options.timeout_ms)
        : undefined;
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve({ code: -1, stdout: "", stderr: describe_error(error) });
    });
    child.on("close", (code) => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function default_fetch_json(url, options = {}) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: options.timeout_ms === undefined ? undefined : AbortSignal.timeout(options.timeout_ms),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return await response.json();
}

async function default_fetch_bytes(url, options = {}) {
  const response = await fetch(url, {
    signal: options.timeout_ms === undefined ? undefined : AbortSignal.timeout(options.timeout_ms),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** 解压归档：交给系统 tar（Windows 10+ 的 bsdtar 也能解 .zip）。 */
async function default_extract(archive_path, format, destination, deps) {
  const result = await (deps.run ?? run_process)("tar", [
    "-xf",
    archive_path,
    "-C",
    destination,
  ]);
  if (result.code !== 0) {
    throw new Error(
      `解压失败（${format}，${archive_path}）：${(result.stderr || result.stdout).trim()}`,
    );
  }
  return { ok: true, archive_path, destination };
}

function default_deps() {
  const deps = {
    run: run_process,
    fetch_json: default_fetch_json,
    fetch_bytes: default_fetch_bytes,
    now: () => Date.now(),
  };
  deps.extract = (archive_path, format, destination) =>
    default_extract(archive_path, format, destination, deps);
  return deps;
}

function resolve_deps(injected) {
  return { ...default_deps(), ...(injected ?? {}) };
}

function check(id, status, message, detail) {
  return detail === undefined ? { id, status, message } : { id, status, message, detail };
}

/**
 * `doctor`：只读环境探测（架构 §7.1）。
 *
 * 返回 `checks[]`（固定 id 集合）、`capabilities` 四个布尔和 `next_actions[]`；
 * 探测失败只降级为 warn/fail，不抛异常。
 */
export async function doctor(options = {}) {
  const deps = resolve_deps(options.deps);
  const env = options.env ?? process.env;
  const home_dir = options.home_dir ?? os.homedir();
  const plugin_root = options.plugin_root ?? DEFAULT_PLUGIN_ROOT;
  const home = path.join(home_dir, HOME_DIR_NAME);

  const checks = [];
  const next_actions = [];

  const plugin_dir_writable = is_writable_path(plugin_root);
  checks.push(
    plugin_dir_writable
      ? check("plugin_dir", "pass", `插件目录可写：${plugin_root}`, { path: plugin_root })
      : check("plugin_dir", "warn", `插件目录不可写：${plugin_root}（构建需要写权限）。`, {
          path: plugin_root,
          code: "PLUGIN_DIR_READONLY",
        }),
  );
  if (!plugin_dir_writable) {
    next_actions.push("插件目录不可写：申请提权后重跑 doctor。");
  }

  const node = await probe_version(deps, { command: "node", args: ["--version"] }, env);
  const node_ok = node.ok && node.major !== undefined && node.major >= MIN_NODE_MAJOR;
  checks.push(
    node_ok
      ? check("node", "pass", `Node ${node.version}（${node.source}）`, {
          version: node.version,
          source: node.source,
        })
      : check("node", "warn", "未找到满足要求的 Node（需要 >= 24）。", {
          code: "NODE_UNAVAILABLE",
          required_major: MIN_NODE_MAJOR,
          ...(node.version === undefined ? {} : { version: node.version }),
        }),
  );
  if (!node_ok) {
    next_actions.push("Node 不满足要求：运行 ensure-runtime 准备私有运行时。");
  }

  const npm_call = npm_invocation(["--version"]);
  const npm = await probe_version(deps, npm_call, env);
  const npm_ok = npm.ok;
  checks.push(
    npm_ok
      ? check("npm", "pass", `npm ${npm.version}`, { version: npm.version })
      : check("npm", "warn", "未找到 npm（构建与私有安装需要它）。", { code: "NPM_UNAVAILABLE" }),
  );
  if (!npm_ok) {
    next_actions.push("npm 不可用：运行 ensure-runtime 补装 Node（含 npm）。");
  }

  let network_ok = false;
  let network_error = "";
  try {
    await deps.fetch_json(NETWORK_PROBE_URL, { timeout_ms: 10000 });
    network_ok = true;
  } catch (error) {
    network_error = describe_error(error);
  }
  checks.push(
    network_ok
      ? check("network", "pass", "网络可达。", { probe_url: NETWORK_PROBE_URL })
      : check("network", "warn", "网络探测失败（下载与登录需要出网）。", {
          code: "NETWORK_BLOCKED",
          probe_url: NETWORK_PROBE_URL,
          reason: network_error,
          allowed_domains: ["nodejs.org", "registry.npmjs.org", "github.com"],
        }),
  );
  if (!network_ok) {
    next_actions.push("网络不可达：先放行 nodejs.org / registry.npmjs.org / github.com 后重试。");
  }

  const home_writable = is_writable_path(home);
  checks.push(
    home_writable
      ? check("home", "pass", `本地数据目录可写：${home}`, { path: home })
      : check("home", "warn", `本地数据目录不可写：${home}。`, { path: home }),
  );
  if (!home_writable) {
    next_actions.push("本地数据目录不可写：申请提权后重跑 doctor。");
  }

  const lark_cli = find_lark_cli(env, home_dir);
  checks.push(
    lark_cli === undefined
      ? check("lark_cli", "warn", "未找到 lark-cli。", { code: "LARK_CLI_NOT_FOUND" })
      : check("lark_cli", "pass", `已找到 lark-cli：${lark_cli.path}`, {
          path: lark_cli.path,
          source: lark_cli.source,
        }),
  );
  if (lark_cli === undefined) {
    next_actions.push("lark-cli 缺失：运行 install-cli 安装到私有 prefix。");
  }

  const config_path = path.join(home, CONFIG_FILE_NAME);
  const config_exists = is_file(config_path);
  checks.push(
    config_exists
      ? check("config", "pass", `配置已存在：${config_path}`, { path: config_path })
      : check("config", "warn", `配置缺失：${config_path}。`, {
          path: config_path,
          code: "CONFIG_MISSING",
        }),
  );

  const dist_path = path.join(plugin_root, "server", "dist", "server.mjs");
  const dist_exists = is_file(dist_path);
  checks.push(
    dist_exists
      ? check("dist", "pass", `MCP Server 已构建：${dist_path}`, { path: dist_path })
      : check("dist", "warn", `MCP Server 尚未构建：${dist_path}。`, {
          path: dist_path,
          code: "DIST_MISSING",
        }),
  );
  if (!dist_exists) {
    next_actions.push("dist 缺失：运行 build-server 构建并做握手自检。");
  }

  const index_path = path.join(home, "index", "knowledge.sqlite");
  checks.push(
    is_file(index_path)
      ? check("index", "pass", `本地索引已存在：${index_path}`, { path: index_path })
      : check("index", "warn", "本地索引尚未构建（首次同步前属预期）。", {
          path: index_path,
          code: "INDEX_NOT_BUILT",
        }),
  );

  return {
    ok: true,
    platform: process.platform,
    arch: process.arch,
    plugin_root,
    home,
    checks,
    capabilities: {
      can_write_home: home_writable,
      can_write_plugin_dir: plugin_dir_writable,
      can_reach_network: network_ok,
      can_build: node_ok && npm_ok && plugin_dir_writable,
    },
    next_actions,
  };
}

/**
 * 子命令入口：输出 JSON 到 stdout，返回进程退出码。
 * 未识别的子命令返回 USAGE_ERROR；其余子命令由后续任务（§7.1）逐个接入。
 */
export async function run_cli(argv = [], options = {}) {
  const io = { ...default_io(), ...(options.io ?? {}) };
  const deps = resolve_deps(options.deps);
  const base_options = { ...options, deps, io };
  const command = argv[0];

  let result;
  if (command === "doctor") {
    result = await doctor(base_options);
  } else if (command === undefined) {
    result = failure("USAGE_ERROR", "缺少子命令：可用子命令为 doctor。", {
      details: { argv: [] },
      next_actions: ["运行 doctor 获取环境探测结果。"],
    });
  } else {
    result = failure("USAGE_ERROR", `未知子命令：${command}。可用子命令为 doctor。`, {
      details: { argv: [...argv], allowed: ["doctor"] },
      next_actions: ["运行 doctor 获取环境探测结果。"],
    });
  }

  io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  return exit_code_for(result);
}

async function main(argv) {
  const code = await run_cli(argv);
  process.exitCode = code;
}

const invoked_directly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invoked_directly) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`setup_bootstrap 未处理异常：${describe_error(error)}\n`);
    process.exitCode = EXIT_FAILED;
  });
}

async function probe_version(deps, call, env, extra = {}) {
  const result = await deps.run(call.command, call.args, { env, ...extra });
  if (result.code !== 0) {
    return { ok: false, source: "system", raw: (result.stderr || result.stdout).trim() };
  }
  const raw = (result.stdout || result.stderr).trim();
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (match === null) {
    return { ok: false, source: "system", raw };
  }
  return {
    ok: true,
    source: "system",
    version: `${match[1]}.${match[2]}.${match[3]}`,
    major: Number(match[1]),
    raw,
  };
}

/**
 * npm 在 Windows 上是 `.cmd`，Node 不允许直接 spawn（EINVAL），必须经 cmd.exe；
 * 这里显式拼命令行并按 cmd 规则转义参数，不依赖 `shell: true`。
 */
function npm_invocation(args) {
  if (process.platform !== "win32") {
    return { command: "npm", args: [...args] };
  }
  const line = ["npm", ...args.map(quote_cmd_argument)].join(" ");
  return { command: "cmd.exe", args: ["/d", "/s", "/c", line] };
}

function quote_cmd_argument(value) {
  const text = String(value);
  if (text === "") {
    return '""';
  }
  if (!/[\s"&|<>^(),;]/.test(text)) {
    return text;
  }
  return `"${text.replaceAll('"', '\\"')}"`;
}

function candidate_names() {
  return process.platform === "win32"
    ? ["lark-cli.exe", "lark-cli.cmd", "lark-cli"]
    : ["lark-cli"];
}

/** 只读查找 lark-cli：环境变量 → PATH → 私有 prefix（不启动子进程）。 */
function find_lark_cli(env, home_dir) {
  const explicit = first_non_empty(env.LARK_CLI_PATH);
  if (explicit !== undefined) {
    const resolved = path.resolve(explicit);
    if (is_file(resolved)) {
      return { path: resolved, source: "env" };
    }
  }
  for (const entry of path_entries(env.PATH)) {
    for (const name of candidate_names()) {
      const candidate = path.join(entry, name);
      if (is_file(candidate)) {
        return { path: candidate, source: "path" };
      }
    }
  }
  const private_dir = path.join(home_dir, HOME_DIR_NAME, ...PRIVATE_CLI_RELATIVE);
  for (const name of candidate_names()) {
    const candidate = path.join(private_dir, name);
    if (is_file(candidate)) {
      return { path: candidate, source: "private" };
    }
  }
  return undefined;
}

/** 目标路径（或它最近的既存父目录）是否可写；只读探测，不创建任何文件。 */
function is_writable_path(target) {
  let current = path.resolve(target);
  for (;;) {
    if (existsSync(current)) {
      try {
        accessSync(current, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

function is_file(target) {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

function path_entries(value) {
  if (typeof value !== "string") {
    return [];
  }
  const seen = new Set();
  const entries = [];
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

function first_non_empty(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function describe_error(error) {
  return error instanceof Error ? error.message : String(error);
}
