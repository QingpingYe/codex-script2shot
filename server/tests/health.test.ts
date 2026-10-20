import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  health,
  type HealthCheck,
  type HealthCheckId,
  type HealthResult,
} from "../src/tools/health.js";

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));
const IS_WINDOWS = process.platform === "win32";

const SPACE_A = "space-a-1";
const BASE_B = "basetoken-b-123456789";
const CARDS_TABLE = "tbl_cards";
const STATE_TABLE = "tbl_state";
const NODE_DIR = path.dirname(process.execPath);
const SYSTEM32_DIR = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
const CHECK_ORDER: HealthCheckId[] = [
  "lark_cli",
  "lark_cli_version",
  "auth",
  "config",
  "space_a_reachable",
  "base_b_reachable",
  "local_dirs",
  "index",
];

let tempRoot = "";
let homeDir = "";
let fakeHomeDir = "";
let emptyBinDir = "";
let localAppDataDir = "";
let fakeCli = "";
let previousHome: string | undefined;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "script2shot-health-"));
  homeDir = path.join(tempRoot, "home");
  fakeHomeDir = path.join(tempRoot, "resolve-home");
  emptyBinDir = path.join(tempRoot, "empty-bin");
  localAppDataDir = path.join(tempRoot, "local-app-data");
  mkdirSync(emptyBinDir, { recursive: true });
  mkdirSync(localAppDataDir, { recursive: true });
  fakeCli = install_fake_cli(path.join(tempRoot, "bin"));

  previousHome = process.env.SCRIPT2SHOT_HOME;
  process.env.SCRIPT2SHOT_HOME = homeDir;
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.SCRIPT2SHOT_HOME;
  } else {
    process.env.SCRIPT2SHOT_HOME = previousHome;
  }
  rmSync(tempRoot, { recursive: true, force: true });
});

/** 把假 CLI 装进指定目录，返回可直接执行的包装脚本路径（Windows 为 .cmd）。 */
function install_fake_cli(dir: string, name = "lark-cli"): string {
  mkdirSync(dir, { recursive: true });
  const wrapper_name = IS_WINDOWS ? `${name}.cmd` : name;
  cpSync(
    path.join(FIXTURES_DIR, IS_WINDOWS ? "fake-lark-cli.cmd" : "fake-lark-cli"),
    path.join(dir, wrapper_name),
  );
  cpSync(path.join(FIXTURES_DIR, "fake-lark-cli.mjs"), path.join(dir, `${name}.mjs`));
  const wrapper_path = path.join(dir, wrapper_name);
  if (!IS_WINDOWS) {
    chmodSync(wrapper_path, 0o755);
  }
  return wrapper_path;
}

/**
 * 封闭环境：只指向临时目录与假 CLI，不解析真实 lark-cli、不触碰真实用户目录。
 * PATH 只保留 Node 所在目录（.cmd 包装需要 node）、System32（cmd.exe）与空目录。
 */
function fake_env(scenario: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.LARK_CLI_PATH;
  delete env.FAKE_SCENARIO;
  return {
    ...env,
    PATH: [NODE_DIR, ...(IS_WINDOWS ? [SYSTEM32_DIR] : []), emptyBinDir].join(path.delimiter),
    LOCALAPPDATA: localAppDataDir,
    LARK_CLI_PATH: fakeCli,
    FAKE_SCENARIO: scenario,
    ...overrides,
  };
}

function run_health(scenario: string, overrides: NodeJS.ProcessEnv = {}): Promise<HealthResult> {
  return health({ env: fake_env(scenario, overrides), home_dir: fakeHomeDir });
}

function toml_string(value: string): string {
  return `"${value.replaceAll("\\", "\\\\")}"`;
}

interface ConfigOptions {
  cli_path?: string | null;
  space_a?: string | null;
  base_b?: string | null;
  cards_table?: string | null;
  state_table?: string | null;
}

/** 写出一份测试配置；字段传 null 表示整行省略。 */
function write_config(options: ConfigOptions = {}): string {
  const cli_path = options.cli_path === undefined ? fakeCli : options.cli_path;
  const space_a = options.space_a === undefined ? SPACE_A : options.space_a;
  const base_b = options.base_b === undefined ? BASE_B : options.base_b;
  const cards = options.cards_table === undefined ? CARDS_TABLE : options.cards_table;
  const state = options.state_table === undefined ? STATE_TABLE : options.state_table;

  const lines = ["[lark]"];
  if (cli_path !== null) {
    lines.push(`cli_path = ${toml_string(cli_path)}`);
  }
  if (space_a !== null) {
    lines.push(`space_a = ${toml_string(space_a)}`);
  }
  if (base_b !== null) {
    lines.push(`base_b = ${toml_string(base_b)}`);
  }
  if (cards !== null) {
    lines.push(`knowledge_cards_table_id = ${toml_string(cards)}`);
  }
  if (state !== null) {
    lines.push(`sync_state_table_id = ${toml_string(state)}`);
  }
  lines.push("", "[retrieval]", "default_top_k = 12", "");

  mkdirSync(homeDir, { recursive: true });
  const config_path = path.join(homeDir, "config.toml");
  writeFileSync(config_path, lines.join("\n"), "utf8");
  return config_path;
}

function create_local_dirs(): void {
  for (const name of ["cache", "index", "logs"]) {
    mkdirSync(path.join(homeDir, name), { recursive: true });
  }
}

function check(result: HealthResult, id: HealthCheckId): HealthCheck {
  const found = result.checks.find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error(`missing check ${id}: ${result.checks.map((entry) => entry.id).join(",")}`);
  }
  return found;
}

function read_calls(log_file: string): Array<{ scenario: string; args: string[] }> {
  return readFileSync(log_file, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as { scenario: string; args: string[] });
}

describe("health", () => {
  test("health passes on fully configured fake environment", async () => {
    create_local_dirs();
    write_config();
    const log_file = path.join(tempRoot, "calls.jsonl");

    const result = await run_health("ok", { FAKE_LOG_FILE: log_file });

    expect(result.ok).toBe(true);
    expect(result.checks.map((entry) => entry.id)).toEqual(CHECK_ORDER);
    expect(check(result, "lark_cli").status).toBe("pass");
    expect(check(result, "lark_cli_version")).toMatchObject({
      status: "pass",
      detail: { version: "1.0.98" },
    });
    expect(check(result, "auth").status).toBe("pass");
    expect(check(result, "config").status).toBe("pass");
    expect(check(result, "space_a_reachable").status).toBe("pass");
    expect(check(result, "base_b_reachable").status).toBe("pass");
    expect(check(result, "local_dirs").status).toBe("pass");
    expect(check(result, "index")).toMatchObject({ status: "warn", detail: { state: "not_built" } });

    const calls = read_calls(log_file);
    expect(calls.map((call) => call.args)).toEqual([
      ["--version"],
      ["auth", "status", "--json"],
      ["wiki", "+node-list", "--space-id", SPACE_A, "--page-size", "1", "--as", "user"],
      ["base", "+table-list", "--base-token", BASE_B],
    ]);
  });

  test("health fails with login hint when auth missing", async () => {
    create_local_dirs();
    write_config();
    const log_file = path.join(tempRoot, "calls.jsonl");

    const result = await run_health("no-auth", { FAKE_LOG_FILE: log_file });

    expect(result.ok).toBe(false);
    const auth = check(result, "auth");
    expect(auth.status).toBe("fail");
    expect(auth.message).toContain("lark-cli auth login");
    for (const id of ["space_a_reachable", "base_b_reachable"] as const) {
      const skipped = check(result, id);
      expect(skipped.status).toBe("warn");
      expect(skipped.message).toContain("已跳过");
    }
    expect(check(result, "config").status).toBe("pass");
    expect(check(result, "local_dirs").status).toBe("pass");
    expect(check(result, "index").status).toBe("warn");
    expect(read_calls(log_file), "reachability probes must be skipped").toHaveLength(2);
  });

  test("health fails when space a unreachable", async () => {
    create_local_dirs();
    write_config();

    const result = await run_health("space-unreachable");

    expect(result.ok).toBe(false);
    expect(check(result, "space_a_reachable")).toMatchObject({
      status: "fail",
      detail: { code: "KB_A_UNREACHABLE" },
    });
    expect(check(result, "base_b_reachable").status).toBe("pass");
  });

  test("health fails when base b unreachable", async () => {
    create_local_dirs();
    write_config();

    const result = await run_health("base-unreachable");

    expect(result.ok).toBe(false);
    expect(check(result, "base_b_reachable")).toMatchObject({
      status: "fail",
      detail: { code: "KB_B_UNREACHABLE" },
    });
    expect(check(result, "space_a_reachable").status).toBe("pass");
  });

  test("health fails when configured base tables are missing", async () => {
    create_local_dirs();
    write_config();

    const result = await run_health("table-missing");

    expect(result.ok).toBe(false);
    const base_b = check(result, "base_b_reachable");
    expect(base_b.status).toBe("fail");
    expect(base_b.detail?.missing_tables).toEqual([STATE_TABLE]);
    expect(base_b.detail?.base_token_prefix).toBe(BASE_B.slice(0, 6));
    expect(JSON.stringify(result), "full base token must not appear").not.toContain(BASE_B);
  });

  test("health fails when config missing and never writes it", async () => {
    const result = await run_health("ok");

    expect(result.ok).toBe(false);
    const config = check(result, "config");
    expect(config.status).toBe("fail");
    expect(config.detail?.code).toBe("CONFIG_MISSING");
    expect(config.detail?.path).toBe(path.join(homeDir, "config.toml"));
    expect(JSON.stringify(config.detail)).toContain("$setup");
    for (const id of ["space_a_reachable", "base_b_reachable"] as const) {
      const skipped = check(result, id);
      expect(skipped.status).toBe("warn");
      expect(skipped.message).toContain("已跳过");
    }
    const local_dirs = check(result, "local_dirs");
    expect(local_dirs.status).toBe("warn");
    expect(local_dirs.message).toContain("$setup");
    expect(check(result, "index")).toMatchObject({
      status: "warn",
      detail: { state: "not_built" },
    });
    expect(existsSync(homeDir), "health must not create the home directory").toBe(false);
  });

  test("health fails when config is invalid and keeps the file untouched", async () => {
    mkdirSync(homeDir, { recursive: true });
    const config_path = path.join(homeDir, "config.toml");
    const broken = '[lark\nspace_a = "space-a-1"\n';
    writeFileSync(config_path, broken, "utf8");

    const result = await run_health("ok");

    expect(result.ok).toBe(false);
    const config = check(result, "config");
    expect(config.status).toBe("fail");
    expect(config.detail?.code).toBe("CONFIG_INVALID");
    expect(config.detail?.path).toBe(config_path);
    expect(readFileSync(config_path, "utf8"), "invalid config must not be rewritten").toBe(broken);
  });

  test("health fails when lark space or base keys are missing", async () => {
    write_config({ space_a: null, base_b: null });

    const result = await run_health("ok");

    expect(result.ok).toBe(false);
    const config = check(result, "config");
    expect(config.status).toBe("fail");
    expect(config.detail?.missing_keys).toEqual(["lark.space_a", "lark.base_b"]);
    for (const id of ["space_a_reachable", "base_b_reachable"] as const) {
      const skipped = check(result, id);
      expect(skipped.status).toBe("warn");
      expect(skipped.message).toContain("已跳过");
    }
  });

  test("health skips cli dependent checks when lark-cli is missing", async () => {
    create_local_dirs();
    write_config({ cli_path: null });
    const env = fake_env("ok");
    delete env.LARK_CLI_PATH;

    const result = await health({ env, home_dir: fakeHomeDir });

    expect(result.ok).toBe(false);
    const lark_cli = check(result, "lark_cli");
    expect(lark_cli.status).toBe("fail");
    expect(lark_cli.detail?.code).toBe("LARK_CLI_NOT_FOUND");
    for (const id of [
      "lark_cli_version",
      "auth",
      "space_a_reachable",
      "base_b_reachable",
    ] as const) {
      const skipped = check(result, id);
      expect(skipped.status).toBe("warn");
      expect(skipped.message).toContain("已跳过");
    }
    expect(check(result, "config").status).toBe("pass");
    expect(check(result, "local_dirs").status).toBe("pass");
    expect(check(result, "index").status).toBe("warn");
  });

  test("health passes base b with a warning when table ids are not configured", async () => {
    create_local_dirs();
    write_config({ cards_table: null, state_table: null });

    const result = await run_health("ok");

    expect(result.ok).toBe(true);
    const base_b = check(result, "base_b_reachable");
    expect(base_b.status).toBe("pass");
    expect(String(base_b.detail?.warning)).toContain("table_id 未配置");
    expect(result.warnings.some((warning) => warning.includes("table_id 未配置"))).toBe(true);
  });

  test("health reports index as not_built in phase 1", async () => {
    create_local_dirs();
    write_config();

    const result = await run_health("ok");

    expect(result.ok).toBe(true);
    const index = check(result, "index");
    expect(index.status).toBe("warn");
    expect(index.detail?.state).toBe("not_built");
    expect(result.warnings).toContain(index.message);
  });
});
