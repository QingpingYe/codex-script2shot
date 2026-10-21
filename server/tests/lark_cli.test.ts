import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Script2ShotConfig } from "../src/config.js";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  get_active_profile,
  get_auth_status,
  get_version,
  probe_capabilities,
  resolve_lark_cli,
  run_cli,
  spawn_target,
} from "../src/lark_cli.js";

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));
const IS_WINDOWS = process.platform === "win32";

let tempRoot = "";

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "script2shot-lark-cli-"));
});

afterEach(() => {
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

/** 隔离环境：清掉可能存在的 LARK_CLI_PATH，避免解析到本机真实 lark-cli。 */
function isolated_env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.LARK_CLI_PATH;
  return { ...env, ...overrides };
}

/** 场景环境：只叠加 FAKE_* 开关；这些用例都直接传入 CLI 路径，不经过 PATH 查找。 */
function scenario_env(scenario: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return isolated_env({ FAKE_SCENARIO: scenario, ...overrides });
}

function config_with_cli_path(cli_path?: string): Script2ShotConfig {
  return {
    lark: {
      ...(cli_path === undefined ? {} : { cli_path }),
      project_roots: [],
    },
    retrieval: { default_top_k: 12 },
  };
}

/** 子进程脚本：写出超过输出上限的字节，600ms 后留下存活标记，然后保持存活。 */
function overflow_script(stream: "stdout" | "stderr", marker: string): string {
  return [
    `process.${stream}.write("x".repeat(${DEFAULT_MAX_OUTPUT_BYTES + 4096}));`,
    `setTimeout(() => { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "alive"); }, 600);`,
    "setTimeout(() => {}, 30000);",
  ].join("\n");
}

describe("lark_cli", () => {
  test("resolver follows env config path common order", () => {
    const env_fake = install_fake_cli(path.join(tempRoot, "env-bin"));
    const config_fake = install_fake_cli(path.join(tempRoot, "config-bin"));
    const path_fake = install_fake_cli(path.join(tempRoot, "path-bin"));
    const home = path.join(tempRoot, "home");
    const common_fake = install_fake_cli(path.join(home, ".lark-cli"));
    const path_dir = path.join(tempRoot, "path-bin");
    const config = config_with_cli_path(config_fake);

    expect(
      resolve_lark_cli(config, {
        env: isolated_env({ LARK_CLI_PATH: env_fake, PATH: path_dir }),
        home_dir: home,
      }),
    ).toEqual({ ok: true, path: env_fake, source: "env" });

    expect(
      resolve_lark_cli(config, {
        env: isolated_env({ PATH: path_dir }),
        home_dir: home,
      }),
    ).toEqual({ ok: true, path: config_fake, source: "config" });

    expect(
      resolve_lark_cli(config_with_cli_path(), {
        env: isolated_env({ PATH: path_dir }),
        home_dir: home,
      }),
    ).toEqual({ ok: true, path: path_fake, source: "path" });

    expect(
      resolve_lark_cli(config_with_cli_path(), {
        env: isolated_env({ PATH: path.join(tempRoot, "empty-path") }),
        home_dir: home,
      }),
    ).toEqual({ ok: true, path: common_fake, source: "common" });
  });

  test("resolver falls back when env path is invalid", () => {
    const missing = path.join(tempRoot, "missing-bin", "lark-cli");
    const config_fake = install_fake_cli(path.join(tempRoot, "config-bin"));
    const path_fake = install_fake_cli(path.join(tempRoot, "path-bin"));
    const home = path.join(tempRoot, "home");
    const env = isolated_env({ LARK_CLI_PATH: missing, PATH: path.join(tempRoot, "path-bin") });

    expect(
      resolve_lark_cli(config_with_cli_path(config_fake), { env, home_dir: home }),
    ).toEqual({ ok: true, path: config_fake, source: "config" });

    expect(
      resolve_lark_cli(config_with_cli_path(missing), { env, home_dir: home }),
    ).toEqual({ ok: true, path: path_fake, source: "path" });
  });

  test("resolver reports LARK_CLI_NOT_FOUND with searched locations", () => {
    const home = path.join(tempRoot, "home");
    const empty_dir = path.join(tempRoot, "empty-path");
    const local_app_data = path.join(tempRoot, "local-app-data");
    mkdirSync(empty_dir, { recursive: true });
    mkdirSync(local_app_data, { recursive: true });

    const result = resolve_lark_cli(config_with_cli_path(), {
      env: isolated_env({ PATH: empty_dir, LOCALAPPDATA: local_app_data }),
      home_dir: home,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("LARK_CLI_NOT_FOUND");
    expect(result.error.message).toContain("lark-cli");

    const searched = result.error.details?.searched;
    expect(Array.isArray(searched)).toBe(true);
    const entries = searched as string[];
    expect(entries.some((entry) => entry.startsWith(empty_dir))).toBe(true);
    expect(entries.some((entry) => entry.startsWith(path.join(home, ".lark-cli")))).toBe(true);
    if (IS_WINDOWS) {
      expect(
        entries.some((entry) => entry.startsWith(path.join(local_app_data, "Programs"))),
      ).toBe(true);
    } else {
      expect(entries.some((entry) => entry.startsWith("/usr/local/bin"))).toBe(true);
    }
  });

  test("version parses lark-cli version output", async () => {
    const cli = install_fake_cli(path.join(tempRoot, "bin"));

    await expect(get_version(cli, { env: scenario_env("ok") })).resolves.toEqual({
      ok: true,
      version: "1.0.98",
      raw: "lark-cli version 1.0.98",
    });
  });

  test("version keeps raw output for older releases", async () => {
    const cli = install_fake_cli(path.join(tempRoot, "bin"));

    await expect(get_version(cli, { env: scenario_env("old-version") })).resolves.toEqual({
      ok: true,
      version: "0.9.0",
      raw: "lark-cli version 0.9.0",
    });
  });

  test("auth status returns identity and user name when logged in", async () => {
    const cli = install_fake_cli(path.join(tempRoot, "bin"));

    await expect(get_auth_status(cli, { env: scenario_env("ok") })).resolves.toEqual({
      ok: true,
      logged_in: true,
      identity: "user",
      user_name: "测试用户",
    });
  });

  test("auth status keeps compatibility with the legacy ok/data shape", async () => {
    const cli = install_fake_cli(path.join(tempRoot, "bin"));

    await expect(get_auth_status(cli, { env: scenario_env("legacy-auth") })).resolves.toEqual({
      ok: true,
      logged_in: true,
      identity: "fake-identity-1",
      user_name: "测试用户",
    });
  });

  test("auth status maps not logged in to AUTH_REQUIRED", async () => {
    const cli = install_fake_cli(path.join(tempRoot, "bin"));

    const result = await get_auth_status(cli, { env: scenario_env("no-auth") });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("AUTH_REQUIRED");
      expect(result.error.details?.user_status).toBe("missing");
      expect(result.error.details?.user_available).toBe(false);
    }
  });

  test("auth status treats an expired token as AUTH_REQUIRED", async () => {
    const cli = install_fake_cli(path.join(tempRoot, "bin"));

    const result = await get_auth_status(cli, { env: scenario_env("auth-expired") });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("AUTH_REQUIRED");
      expect(result.error.details?.token_status).toBe("expired");
    }
  });

  test("auth status treats a legacy ok:false payload as AUTH_REQUIRED", async () => {
    const cli = install_fake_cli(path.join(tempRoot, "bin"));

    const result = await get_auth_status(cli, {
      env: scenario_env("legacy-no-auth", { FAKE_AUTH_EXIT_CODE: "0" }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("AUTH_REQUIRED");
    }
  });

  test("auth status passes --verify and records the invocation", async () => {
    const cli = install_fake_cli(path.join(tempRoot, "bin"));
    const log_file = path.join(tempRoot, "calls.jsonl");

    const result = await get_auth_status(cli, {
      verify: true,
      env: scenario_env("ok", { FAKE_LOG_FILE: log_file }),
    });

    expect(result.ok).toBe(true);
    const calls = readFileSync(log_file, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { args: string[] });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["auth", "status", "--json", "--verify"]);
  });

  test("auth status reports INTERNAL for non-json payloads", async () => {
    const cli = install_fake_cli(path.join(tempRoot, "bin"));

    const result = await get_auth_status(cli, { env: scenario_env("bad-json") });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
      const stderr = String(result.error.details?.stderr ?? "");
      expect(stderr.length).toBeGreaterThan(0);
      expect(stderr.length).toBeLessThanOrEqual(500);
      expect(result.error.details?.stderr_truncated).toBe(true);
    }
  });

  test("active profile reads profile list JSON without switching profiles", async () => {
    const cli = install_fake_cli(path.join(tempRoot, "bin"));
    const log_file = path.join(tempRoot, "calls.jsonl");

    await expect(
      get_active_profile(cli, {
        env: scenario_env("ok", { FAKE_ACTIVE_PROFILE: "profile-2", FAKE_LOG_FILE: log_file }),
      }),
    ).resolves.toEqual({ ok: true, profile: "profile-2" });

    const calls = readFileSync(log_file, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { scenario: string; args: string[] });
    expect(calls).toEqual([{ scenario: "ok", args: ["profile", "list"] }]);
  });

  test("run_cli captures stdout, stderr and exit code", async () => {
    const cli = install_fake_cli(path.join(tempRoot, "bin"));

    const ok_run = await run_cli(cli, ["--version"], { env: scenario_env("ok") });
    expect(ok_run.ok).toBe(true);
    if (ok_run.ok) {
      expect(ok_run.code).toBe(0);
      expect(ok_run.stdout.trim()).toBe("lark-cli version 1.0.98");
      expect(ok_run.stderr).toBe("");
    }

    const failed_run = await run_cli(cli, ["auth", "status", "--json"], {
      env: scenario_env("legacy-no-auth"),
    });
    expect(failed_run.ok).toBe(true);
    if (failed_run.ok) {
      expect(failed_run.code).toBe(1);
      expect(failed_run.stderr).toContain("not logged in");
    }
  });

  test("run_cli reports INTERNAL with truncated stderr when json is required", async () => {
    const cli = install_fake_cli(path.join(tempRoot, "bin"));

    const result = await run_cli(cli, ["auth", "status", "--json"], {
      env: scenario_env("bad-json"),
      expect_json: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
      const stderr = String(result.error.details?.stderr ?? "");
      expect(stderr.length).toBeLessThanOrEqual(500);
      expect(result.error.details?.stderr_truncated).toBe(true);
    }
  });

  test("run_cli reports INTERNAL when the command times out", async () => {
    const result = await run_cli(
      process.execPath,
      ["-e", "setTimeout(() => {}, 5000)"],
      { timeout_ms: 300 },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
      expect(result.error.message).toContain("超时");
    }
  });

  test.each(["stdout", "stderr"] as const)(
    "run_cli terminates the cli and reports the %s stream when output exceeds the cap",
    async (stream) => {
      const marker = path.join(tempRoot, `alive-${stream}.txt`);
      const started_at = Date.now();

      const result = await run_cli(process.execPath, ["-e", overflow_script(stream, marker)], {
        timeout_ms: 2000,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INTERNAL");
        expect(result.error.details?.stream).toBe(stream);
        expect(result.error.details?.bytes_read).toBeGreaterThan(DEFAULT_MAX_OUTPUT_BYTES);
        expect(result.error.details?.limit_bytes).toBe(DEFAULT_MAX_OUTPUT_BYTES);
        expect(result.error.message).toContain(stream);
      }
      expect(Date.now() - started_at, "超限必须立即结算，而不是等到超时").toBeLessThan(1500);

      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(existsSync(marker), "超限后子进程必须被终止").toBe(false);
    },
  );

  test("run_cli honours the injected platform instead of the host platform", async () => {
    const cli = install_fake_cli(path.join(tempRoot, "bin"));
    // 注入另一半平台：Windows 上不再经 cmd.exe 包装（直接 exec .cmd 被拒绝），
    // POSIX 上改走 cmd.exe（不存在）——两条路径都归一化为 INTERNAL。
    const foreign_platform = IS_WINDOWS ? "linux" : "win32";

    const result = await run_cli(cli, ["--version"], {
      env: scenario_env("ok"),
      platform: foreign_platform,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
      expect(result.error.details?.path).toBe(cli);
    }
  });

  test("run_cli reports INTERNAL when the executable path cannot be spawned", async () => {
    const missing = path.join(tempRoot, "missing-bin", "lark-cli");

    const result = await run_cli(missing, ["--version"], {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
      expect(result.error.message).toContain("无法启动");
      expect(result.error.details?.path).toBe(missing);
    }
  });

  test("spawn_target routes .cmd through cmd.exe only on win32", () => {
    const win_target = spawn_target("C:\\tools\\lark-cli.cmd", ["%PATH%"], "win32");
    expect(win_target.command).toBe("cmd.exe");
    expect(win_target.windows_verbatim_arguments).toBe(true);
    expect(win_target.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(win_target.args, "整条命令行作为一个 verbatim 参数").toHaveLength(4);
    expect(win_target.args[3].startsWith('"')).toBe(true);

    expect(spawn_target("/usr/local/bin/lark-cli", ["--version"], "linux")).toEqual({
      command: "/usr/local/bin/lark-cli",
      args: ["--version"],
      windows_verbatim_arguments: false,
    });
  });

  test.skipIf(IS_WINDOWS)("POSIX rejects a cli path without the execute bit", async () => {
    const dir = path.join(tempRoot, "no-exec-bin");
    mkdirSync(dir, { recursive: true });
    const cli = path.join(dir, "lark-cli");
    writeFileSync(cli, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(cli, 0o644);

    const resolved = resolve_lark_cli(config_with_cli_path(cli), {
      env: isolated_env({ PATH: path.join(tempRoot, "empty-path") }),
      home_dir: path.join(tempRoot, "home"),
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error.code).toBe("LARK_CLI_NOT_FOUND");
    }

    const run = await run_cli(cli, ["--version"], {});
    expect(run.ok).toBe(false);
    if (!run.ok) {
      expect(run.error.code).toBe("INTERNAL");
    }
  });

  test.skipIf(!IS_WINDOWS)(
    "cmd.exe wrapper delivers argv unchanged for quoted and meta characters",
    async () => {
      const cli = install_fake_cli(path.join(tempRoot, "fake lark cli 中文 目录"), "fake-lark-cli");
      const log_file = path.join(tempRoot, "argv.jsonl");
      const json_arg = JSON.stringify({
        create_records: [{ fields: { title: '中文 "引号" 与 \\ 反斜杠', path: "a\\b" } }],
      });
      const args = [
        "auth",
        "status",
        "--json",
        "has space",
        "中文 参数",
        "%PATH%",
        "50%",
        "a&b",
        "a|b",
        "<in>",
        "(x)",
        "caret^",
        "semi;",
        'dq"x',
        "trail\\",
        "路径&中文 空格",
        json_arg,
      ];

      const result = await run_cli(cli, args, {
        env: scenario_env("ok", { FAKE_LOG_FILE: log_file }),
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.code).toBe(0);
      }
      const calls = readFileSync(log_file, "utf8")
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as { args: string[] });
      expect(calls).toHaveLength(1);
      expect(calls[0].args).toEqual(args);
    },
  );

  test("probe reports all capabilities of the current cli", async () => {
    const cli = install_fake_cli(path.join(tempRoot, "bin"));

    await expect(probe_capabilities(cli, { env: scenario_env("ok") })).resolves.toEqual({
      wiki_node_list: true,
      docs_fetch: true,
      base_table_create: true,
      base_record_batch_create: true,
      base_record_delete: true,
      base_record_list: true,
      auth_status: true,
    });
  });

  test("probe detects missing subcommand capability", async () => {
    const cli = install_fake_cli(path.join(tempRoot, "bin"));

    const capabilities = await probe_capabilities(cli, { env: scenario_env("missing-capability") });

    expect(capabilities.base_record_batch_create).toBe(false);
    expect(capabilities.base_record_delete).toBe(false);
    expect(capabilities.base_table_create).toBe(true);
    expect(capabilities.base_record_list).toBe(true);
    expect(capabilities.wiki_node_list).toBe(true);
    expect(capabilities.docs_fetch).toBe(true);
    expect(capabilities.auth_status).toBe(true);
  });

  test("spawns with argument array for paths with spaces", async () => {
    const dir = path.join(tempRoot, "fake lark cli 中文 目录");
    const cli = install_fake_cli(dir, "fake-lark-cli");
    const home = path.join(tempRoot, "home");

    expect(
      resolve_lark_cli(config_with_cli_path(), {
        env: isolated_env({ LARK_CLI_PATH: cli, PATH: path.join(tempRoot, "empty-path") }),
        home_dir: home,
      }),
    ).toEqual({ ok: true, path: cli, source: "env" });

    await expect(get_version(cli, { env: scenario_env("ok") })).resolves.toEqual({
      ok: true,
      version: "1.0.98",
      raw: "lark-cli version 1.0.98",
    });
  });
});
