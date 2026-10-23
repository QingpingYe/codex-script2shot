import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const scriptPath = path.join(repoRoot, "scripts", "setup_bootstrap.mjs");
const isWindows = process.platform === "win32";

const EXPECTED_CHECK_IDS = [
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

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface FakeDeps {
  run: (command: string, args: string[], options?: Record<string, unknown>) => Promise<RunResult>;
  fetch_json: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  fetch_bytes: (url: string, options?: Record<string, unknown>) => Promise<Uint8Array>;
  extract: (
    archivePath: string,
    format: string,
    destination: string,
  ) => Promise<Record<string, unknown>>;
  can_write: (target: string) => boolean;
  mcp_session: (call: McpSessionCall) => Promise<McpSessionResult>;
  remove_file: (target: string) => void;
  now: () => number;
}

interface McpSessionCall {
  node_path: string;
  server_path: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout_ms?: number;
  requests: Array<{ method: string; params?: unknown }>;
}

type McpSessionResult =
  | { ok: true; results: Array<Record<string, unknown>> }
  | { ok: false; error: { code: string; message: string } };

interface FakeCalls {
  run: string[][];
  run_options: Array<Record<string, unknown> | undefined>;
  fetch_json: string[];
  fetch_bytes: string[];
  extract: string[][];
  mcp_session: McpSessionCall[];
}

interface FakeBehavior {
  run?: (
    command: string,
    args: string[],
    options?: { env?: NodeJS.ProcessEnv; cwd?: string; [key: string]: unknown },
  ) => RunResult | Promise<RunResult>;
  fetch_json?: (url: string) => unknown | Promise<unknown>;
  fetch_bytes?: (url: string) => Uint8Array | Promise<Uint8Array>;
  extract?: (
    archivePath: string,
    format: string,
    destination: string,
  ) => unknown | Promise<unknown>;
  can_write?: (target: string) => boolean;
  mcp_session?: (call: McpSessionCall) => McpSessionResult | Promise<McpSessionResult>;
  remove_file?: (target: string) => void;
}

let tempRoot = "";

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "script2shot-bootstrap-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

/**
 * 全假依赖：记录调用，任何真实子进程 / 网络都不会发生。
 * `behavior` 只替换动作本身，调用记录始终保留。
 */
function fake_deps(behavior: FakeBehavior = {}): { deps: FakeDeps; calls: FakeCalls } {
  const calls: FakeCalls = {
    run: [],
    run_options: [],
    fetch_json: [],
    fetch_bytes: [],
    extract: [],
    mcp_session: [],
  };
  const deps: FakeDeps = {
    run: async (command, args, options) => {
      calls.run.push([command, ...args]);
      calls.run_options.push(options);
      return await (behavior.run?.(command, args, options) ?? {
        code: 0,
        stdout: "v26.8.2\n",
        stderr: "",
      });
    },
    fetch_json: async (url) => {
      calls.fetch_json.push(url);
      return await (behavior.fetch_json?.(url) ?? { ok: true });
    },
    fetch_bytes: async (url) => {
      calls.fetch_bytes.push(url);
      return await (behavior.fetch_bytes?.(url) ?? new Uint8Array());
    },
    extract: async (archivePath, format, destination) => {
      calls.extract.push([archivePath, format, destination]);
      return (await (behavior.extract?.(archivePath, format, destination) ?? { ok: true })) as Record<
        string,
        unknown
      >;
    },
    can_write: (target) => behavior.can_write?.(target) ?? existsSync(target),
    mcp_session: async (call) => {
      calls.mcp_session.push(call);
      return await (behavior.mcp_session?.(call) ?? {
        ok: true,
        results: call.requests.map(() => ({ tools: [] })),
      });
    },
    remove_file: (target) => {
      if (behavior.remove_file !== undefined) {
        behavior.remove_file(target);
        return;
      }
      rmSync(target, { force: true });
    },
    now: () => 1760000000000,
  };
  return { deps, calls };
}

/** Node 归档名（与官方分发目录一致）。 */
function archive_name_for(platform: string, arch: string, version: string): string {
  const tag = `node-${version}-${platform}-${arch}`;
  if (platform === "win") {
    return `${tag}.zip`;
  }
  return platform === "linux" ? `${tag}.tar.xz` : `${tag}.tar.gz`;
}

function extracted_node_relative(platform: string): string {
  return platform === "win" ? "node.exe" : path.join("bin", "node");
}

function extracted_npm_relative(platform: string): string {
  return platform === "win" ? "npm.cmd" : path.join("bin", "npm");
}

/** 安装 fake lark-cli（与其它测试同一 fixture）。 */
function install_fake_cli(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const fixtures = path.join(repoRoot, "server", "tests", "fixtures");
  const wrapper_name = isWindows ? "lark-cli.cmd" : "lark-cli";
  cpSync(
    path.join(fixtures, isWindows ? "fake-lark-cli.cmd" : "fake-lark-cli"),
    path.join(dir, wrapper_name),
  );
  cpSync(path.join(fixtures, "fake-lark-cli.mjs"), path.join(dir, "lark-cli.mjs"));
  const wrapper_path = path.join(dir, wrapper_name);
  if (!isWindows) {
    chmodSync(wrapper_path, 0o755);
  }
  return wrapper_path;
}

function collect_io(): { io: { stdout: (text: string) => void; stderr: (text: string) => void }; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { stdout: (text: string) => stdout.push(text), stderr: (text: string) => stderr.push(text) },
    stdout,
    stderr,
  };
}

function run_collecting(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} ${args.join(" ")} did not exit in time`));
    }, 30000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

describe("setup_bootstrap", () => {
  test("doctor reports capabilities and the fixed check ids", async () => {
    const home = path.join(tempRoot, "home");
    mkdirSync(home, { recursive: true });
    const { deps } = fake_deps();
    const { doctor } = await import("../../scripts/setup_bootstrap.mjs");

    const result = await doctor({ home_dir: home, env: {}, deps });

    expect(result.ok).toBe(true);
    expect(result.checks.map((entry: { id: string }) => entry.id)).toEqual(EXPECTED_CHECK_IDS);
    expect(Object.keys(result.capabilities).sort()).toEqual([
      "can_build",
      "can_reach_network",
      "can_write_home",
      "can_write_plugin_dir",
    ]);
    for (const value of Object.values(result.capabilities)) {
      expect(typeof value).toBe("boolean");
    }
    expect(Array.isArray(result.next_actions)).toBe(true);
  });

  test("run_cli prints doctor JSON to stdout and exits 0", async () => {
    const home = path.join(tempRoot, "home");
    mkdirSync(home, { recursive: true });
    const { deps } = fake_deps();
    const { run_cli } = await import("../../scripts/setup_bootstrap.mjs");
    const { io, stdout } = collect_io();

    const code = await run_cli(["doctor"], { home_dir: home, env: {}, deps, io });

    expect(code).toBe(0);
    const payload = JSON.parse(stdout.join(""));
    expect(payload.ok).toBe(true);
    expect(payload.checks.length).toBeGreaterThan(0);
  });

  test("run_cli reports unknown subcommands as USAGE_ERROR with exit code 1", async () => {
    const { deps } = fake_deps();
    const { run_cli } = await import("../../scripts/setup_bootstrap.mjs");
    const { io, stdout } = collect_io();

    const code = await run_cli(["nope"], { env: {}, deps, io });

    expect(code).toBe(1);
    const payload = JSON.parse(stdout.join(""));
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe("USAGE_ERROR");
  });

  test("doctor uses the injected deps instead of real subprocesses or network", async () => {
    const home = path.join(tempRoot, "home");
    mkdirSync(home, { recursive: true });
    const { deps, calls } = fake_deps();
    const { doctor } = await import("../../scripts/setup_bootstrap.mjs");

    const result = await doctor({ home_dir: home, env: {}, deps });

    expect(result.ok).toBe(true);
    expect(calls.run[0]).toEqual(["node", "--version"]);
    expect(calls.run).toHaveLength(2);
    expect(calls.fetch_json).toHaveLength(1);
    expect(calls.fetch_bytes).toEqual([]);
    expect(calls.extract).toEqual([]);
  });

  test("wrapper scripts forward arguments and print USAGE_ERROR JSON", async () => {
    const { command, args } = launcher_command(
      path.join(repoRoot, "scripts", isWindows ? "setup_bootstrap.cmd" : "setup_bootstrap"),
      ["nope"],
    );

    const result = await run_collecting(command, args, repoRoot);

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stdout);
    expect(payload.error.code).toBe("USAGE_ERROR");
  });

  test("ensure-runtime reuses a system node and never downloads", async () => {
    const home = path.join(tempRoot, "home");
    mkdirSync(home, { recursive: true });
    const { deps, calls } = fake_deps();
    const { ensure_runtime } = await import("../../scripts/setup_bootstrap.mjs");

    const result = await ensure_runtime({ home_dir: home, env: {}, deps });

    expect(result.ok).toBe(true);
    expect(result.source).toBe("system");
    expect(result.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(result.node_path).toBe("node");
    expect(result.npm_path).toBe("npm");
    expect(calls.fetch_bytes, "系统 node 满足要求时不得下载归档").toEqual([]);
    expect(calls.fetch_json, "系统 node 满足要求时不得读取 index.json").toEqual([]);
  });

  test("ensure-runtime downloads, verifies and unpacks the newest LTS node", async () => {
    const home = path.join(tempRoot, "home");
    const version = "v24.5.0";
    const platform = process.platform === "win32" ? "win" : process.platform === "darwin" ? "darwin" : "linux";
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const archive_name = archive_name_for(platform, arch, version);
    const archive_bytes = new TextEncoder().encode("fake-node-archive");
    const sha256 = createHash("sha256").update(archive_bytes).digest("hex");
    const top_dir = `node-${version}-${platform}-${arch}`;

    const { deps, calls } = fake_deps({
      run: async () => ({ code: 1, stdout: "", stderr: "not found" }),
      fetch_json: async () => [
        { version: "v22.14.0", lts: "Jod" },
        { version: "v24.5.0", lts: "Krypton" },
        { version: "v25.0.0", lts: false },
      ],
      fetch_bytes: async (url) =>
        url.endsWith("SHASUMS256.txt")
          ? new TextEncoder().encode(`${sha256}  ${archive_name}\n`)
          : archive_bytes,
      extract: async (_archivePath, _format, destination) => {
        const node_dir = path.join(destination, top_dir);
        mkdirSync(path.dirname(path.join(node_dir, extracted_node_relative(platform))), {
          recursive: true,
        });
        writeFileSync(path.join(node_dir, extracted_node_relative(platform)), "node", "utf8");
        writeFileSync(path.join(node_dir, extracted_npm_relative(platform)), "npm", "utf8");
        return { ok: true };
      },
    });
    const { ensure_runtime } = await import("../../scripts/setup_bootstrap.mjs");

    const result = await ensure_runtime({ home_dir: home, env: {}, deps });

    expect(result.ok).toBe(true);
    expect(result.source).toBe("private");
    expect(result.version).toBe("24.5.0");
    expect(result.archive_url).toContain(`https://nodejs.org/dist/${version}/${archive_name}`);
    expect(result.checksum_source).toBe(`https://nodejs.org/dist/${version}/SHASUMS256.txt`);
    expect(result.node_path).toBe(
      path.join(home, ".codex-script2shot", "runtime", `node-v${result.version}`, top_dir, extracted_node_relative(platform)),
    );
    expect(result.npm_path).toBe(
      path.join(home, ".codex-script2shot", "runtime", `node-v${result.version}`, top_dir, extracted_npm_relative(platform)),
    );
    expect(existsSync(result.node_path)).toBe(true);
    expect(existsSync(result.npm_path)).toBe(true);
    expect(calls.fetch_bytes).toHaveLength(2);
  });

  test("ensure-runtime aborts on a checksum mismatch without landing a runtime", async () => {
    const home = path.join(tempRoot, "home");
    const { deps } = fake_deps({
      run: async () => ({ code: 1, stdout: "", stderr: "not found" }),
      fetch_json: async () => [{ version: "v24.5.0", lts: "Krypton" }],
      fetch_bytes: async (url) =>
        url.endsWith("SHASUMS256.txt")
          ? new TextEncoder().encode(`${"0".repeat(64)}  ${archive_name_for("win", "x64", "v24.5.0")}\n`)
          : new TextEncoder().encode("fake-node-archive"),
    });
    const { ensure_runtime } = await import("../../scripts/setup_bootstrap.mjs");

    const result = await ensure_runtime({ home_dir: home, env: {}, deps });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("NODE_CHECKSUM_MISMATCH");
    expect(existsSync(path.join(home, ".codex-script2shot", "runtime"))).toBe(false);
  });

  test("ensure-runtime reports unsupported platforms as NPM_UNAVAILABLE", async () => {
    const home = path.join(tempRoot, "home");
    const { deps } = fake_deps({
      run: async () => ({ code: 1, stdout: "", stderr: "not found" }),
      fetch_json: async () => [{ version: "v24.5.0", lts: "Krypton" }],
    });
    const { ensure_runtime } = await import("../../scripts/setup_bootstrap.mjs");

    const result = await ensure_runtime({
      home_dir: home,
      env: {},
      deps,
      platform: "aix",
      arch: "ppc64",
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("NPM_UNAVAILABLE");
  });

  test("install-cli reuses a private cli at or above the minimum version", async () => {
    const home = path.join(tempRoot, "home");
    const cli_path = private_cli_path(home);
    mkdirSync(path.dirname(cli_path), { recursive: true });
    writeFileSync(cli_path, "fake", "utf8");
    const { deps, calls } = fake_deps({
      run: async (_command, args) =>
        args[0] === "--version"
          ? { code: 0, stdout: "lark-cli version 1.0.98\n", stderr: "" }
          : { code: 0, stdout: "", stderr: "" },
    });
    const { install_cli } = await import("../../scripts/setup_bootstrap.mjs");

    const result = await install_cli({ home_dir: home, env: {}, deps });

    expect(result.ok).toBe(true);
    expect(result.source).toBe("reuse");
    expect(result.cli_path).toBe(cli_path);
    expect(result.version).toBe("1.0.98");
    expect(
      calls.run.map((entry) => entry.join(" ")).join(" | "),
      "复用路径不得触发 npm 安装",
    ).not.toContain("install");
  });

  test("install-cli falls back to the packaged installer when the binary is missing", async () => {
    const home = path.join(tempRoot, "home");
    const cli_path = private_cli_path(home);
    const { deps, calls } = fake_deps({
      run: async (command, args, options) => {
        const line = [command, ...args].join(" ");
        if (line.includes("install.js")) {
          expect(options?.env?.LARK_CLI_RUN).toBe("1");
          mkdirSync(path.dirname(cli_path), { recursive: true });
          writeFileSync(cli_path, "fake", "utf8");
          return { code: 0, stdout: "", stderr: "" };
        }
        if (line.includes("@larksuite/cli@1.0.98")) {
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "not found" };
      },
    });
    const { install_cli } = await import("../../scripts/setup_bootstrap.mjs");

    const result = await install_cli({ home_dir: home, env: {}, deps });

    expect(result.ok).toBe(true);
    expect(result.source).toBe("package-installer");
    expect(result.cli_path).toBe(cli_path);
    const installer_calls = calls.run.filter((entry) =>
      entry.some((part) => part.includes("install.js")),
    );
    expect(installer_calls).toHaveLength(1);
    expect(installer_calls[0][1]).toBe(private_install_script(home));
  });

  test("install-cli reports NPM_INSTALL_FAILED when npm and the installer both fail", async () => {
    const home = path.join(tempRoot, "home");
    const { deps } = fake_deps({
      run: async () => ({ code: 1, stdout: "", stderr: "boom" }),
    });
    const { install_cli } = await import("../../scripts/setup_bootstrap.mjs");

    const result = await install_cli({ home_dir: home, env: {}, deps });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("NPM_INSTALL_FAILED");
  });

  test("install-cli upgrades a private cli below the minimum version", async () => {
    const home = path.join(tempRoot, "home");
    const cli_path = private_cli_path(home);
    const prefix = path.join(home, ".codex-script2shot", "cli");
    mkdirSync(path.dirname(cli_path), { recursive: true });
    writeFileSync(cli_path, "old", "utf8");
    let installed = false;
    const { deps, calls } = fake_deps({
      run: async (command, args) => {
        const line = [command, ...args].join(" ");
        if (args[0] === "--version") {
          return {
            code: 0,
            stdout: installed ? "lark-cli version 1.0.98\n" : "lark-cli version 1.0.97\n",
            stderr: "",
          };
        }
        if (line.includes("@larksuite/cli@1.0.98")) {
          installed = true;
          writeFileSync(cli_path, "new", "utf8");
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "" };
      },
    });
    const { install_cli } = await import("../../scripts/setup_bootstrap.mjs");

    const result = await install_cli({ home_dir: home, env: {}, deps });

    expect(result.ok).toBe(true);
    expect(result.source).toBe("npm-prefix");
    expect(result.version).toBe("1.0.98");
    expect(result.cli_path).toBe(cli_path);
    const install_line = calls.run
      .map((entry) => entry.join(" "))
      .find((line) => line.includes("@larksuite/cli@1.0.98"));
    expect(install_line).toContain("--prefix");
    expect(install_line).toContain(prefix);
  });

  test("build-server stops with PLUGIN_DIR_READONLY before running npm", async () => {
    const home = path.join(tempRoot, "home");
    const plugin_root = path.join(tempRoot, "plugin");
    mkdirSync(path.join(plugin_root, "server"), { recursive: true });
    const { deps, calls } = fake_deps({ can_write: () => false });
    const { build_server } = await import("../../scripts/setup_bootstrap.mjs");

    const result = await build_server({ home_dir: home, env: {}, deps, plugin_root });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("PLUGIN_DIR_READONLY");
    expect(calls.run, "权限预检失败时不得启动 npm").toEqual([]);
  });

  test("build-server classifies npm failures", async () => {
    const home = path.join(tempRoot, "home");
    const plugin_root = path.join(tempRoot, "plugin");
    mkdirSync(path.join(plugin_root, "server"), { recursive: true });
    const { build_server } = await import("../../scripts/setup_bootstrap.mjs");

    const cases: Array<[string, string]> = [
      ["npm error code EPERM\nnpm error syscall mkdir", "NEEDS_ESCALATION"],
      ["npm error code EACCES\nnpm error path /x", "NEEDS_ESCALATION"],
      ["npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org", "NETWORK_BLOCKED"],
      ["npm error code EAI_AGAIN\ngetaddrinfo", "NETWORK_BLOCKED"],
      ["npm error code ERESOLVE\nunable to resolve dependency tree", "NPM_SOURCE_FAILED"],
      ["npm error 404 Not Found - GET https://registry.npmjs.org/esbuild", "NPM_SOURCE_FAILED"],
    ];

    for (const [stderr, expected] of cases) {
      const { deps } = fake_deps({
        run: async () => ({ code: 1, stdout: "", stderr }),
      });
      const result = await build_server({ home_dir: home, env: {}, deps, plugin_root });
      expect(result.ok).toBe(false);
      expect(result.error.code, stderr).toBe(expected);
    }
  });

  test("build-server reports BUILD_TOOL_BLOCKED when the builder or dist is missing", async () => {
    const home = path.join(tempRoot, "home");
    const plugin_root = path.join(tempRoot, "plugin");
    mkdirSync(path.join(plugin_root, "server"), { recursive: true });
    const { deps } = fake_deps({
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
    });
    const { build_server } = await import("../../scripts/setup_bootstrap.mjs");

    const result = await build_server({ home_dir: home, env: {}, deps, plugin_root });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("BUILD_TOOL_BLOCKED");
  });

  test("build-server builds, checks the builder and completes the tools/list handshake", async () => {
    const home = path.join(tempRoot, "home");
    const plugin_root = path.join(tempRoot, "plugin");
    const server_dir = path.join(plugin_root, "server");
    const dist_path = path.join(server_dir, "dist", "server.mjs");
    const esbuild_path = esbuild_binary_path(server_dir);
    mkdirSync(server_dir, { recursive: true });

    const { deps, calls } = fake_deps({
      run: async (command, args) => {
        const line = [command, ...args].join(" ");
        if (line.includes("run build")) {
          mkdirSync(path.dirname(dist_path), { recursive: true });
          writeFileSync(dist_path, "// minimal server", "utf8");
          mkdirSync(path.dirname(esbuild_path), { recursive: true });
          writeFileSync(esbuild_path, "binary", "utf8");
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      mcp_session: async () => ({
        ok: true,
        results: [{ tools: [{ name: "health" }, { name: "read_config" }] }],
      }),
    });
    const { build_server } = await import("../../scripts/setup_bootstrap.mjs");

    const result = await build_server({ home_dir: home, env: {}, deps, plugin_root });

    expect(result.ok).toBe(true);
    expect(result.dist_path).toBe(dist_path);
    expect(result.tools_count).toBe(2);
    expect(calls.run_options.some((options) => options?.cwd === server_dir)).toBe(true);
    expect(calls.mcp_session).toHaveLength(1);
    expect(calls.mcp_session[0]).toMatchObject({
      server_path: dist_path,
      requests: [{ method: "tools/list", params: {} }],
    });
  });

  test(
    "build-server completes a real initialize + tools/list handshake against the built dist",
    async () => {
      const { build_server, create_default_deps } = await import("../../scripts/setup_bootstrap.mjs");
      const real_deps = create_default_deps();
      const { deps } = fake_deps({
        // npm ci / npm run build 空跑：直接复用 pretest 已经构建好的 dist。
        run: async () => ({ code: 0, stdout: "", stderr: "" }),
      });

      const result = await build_server({
        plugin_root: repoRoot,
        env: process.env,
        deps: { ...deps, mcp_session: real_deps.mcp_session },
      });

      expect(result.ok).toBe(true);
      expect(result.tools_count).toBeGreaterThan(0);
    },
    30000,
  );

  test("ensure-app reuses an existing appId without running config init", async () => {
    const home = path.join(tempRoot, "home");
    const { deps, calls } = fake_deps({
      run: async (_command, args) =>
        args[0] === "config" && args[1] === "show"
          ? {
              code: 0,
              stdout: JSON.stringify({
                appId: "cli_app_existing",
                appSecret: "SENSITIVE-APP-SECRET",
              }),
              stderr: "config path: C:\\Users\\demo\\.lark-cli\\config.json\n",
            }
          : { code: 0, stdout: "", stderr: "" },
    });
    const { ensure_app } = await import("../../scripts/setup_bootstrap.mjs");

    const result = await ensure_app({ home_dir: home, env: {}, deps, cli_path: "lark-cli" });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("reused");
    expect(result.app_id).toBe("cli_app_existing");
    expect(
      calls.run.map((entry) => entry.join(" ")).join(" | "),
      "有 appId 时不得触发应用创建",
    ).not.toContain("config init");
    expect(JSON.stringify(result)).not.toContain("SENSITIVE-APP-SECRET");
  });

  test("ensure-app reports APP_NOT_CONFIGURED when config show has no appId", async () => {
    const home = path.join(tempRoot, "home");
    const { deps } = fake_deps({
      run: async () => ({ code: 0, stdout: '{"appSecret":"x"}', stderr: "path\n" }),
    });
    const { ensure_app } = await import("../../scripts/setup_bootstrap.mjs");

    const result = await ensure_app({ home_dir: home, env: {}, deps, cli_path: "lark-cli" });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("APP_NOT_CONFIGURED");
    expect(result.error.next_actions.join(" ")).toContain("同意");
  });

  test("ensure-app asks for explicit consent when the cli refuses in an agent context", async () => {
    const home = path.join(tempRoot, "home");
    const { deps } = fake_deps({
      run: async (_command, args) => {
        const line = args.join(" ");
        if (line.startsWith("config show")) {
          return { code: 0, stdout: "{}", stderr: "" };
        }
        if (line.startsWith("config init")) {
          return {
            code: 1,
            stdout: "",
            stderr:
              "error: running inside an agent context; app registration is disabled. " +
              "use `lark-cli config bind` or run `config init --new --force-init` after user consent.\n",
          };
        }
        return { code: 1, stdout: "", stderr: "" };
      },
    });
    const { ensure_app } = await import("../../scripts/setup_bootstrap.mjs");

    const result = await ensure_app({
      home_dir: home,
      env: {},
      deps,
      cli_path: "lark-cli",
      create: true,
      io: { stdout: () => {}, stderr: () => {} },
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("APP_REGISTRATION_PENDING");
    expect(result.error.next_actions.join(" ")).toContain("--force");
  });

  test("ensure-app forwards progress without leaking appSecret while creating an app", async () => {
    const home = path.join(tempRoot, "home");
    const forwarded: string[] = [];
    let show_count = 0;
    const { deps } = fake_deps({
      run: async (_command, args) => {
        const line = args.join(" ");
        if (line.startsWith("config show")) {
          show_count += 1;
          return show_count === 1
            ? { code: 0, stdout: "{}", stderr: "config path\n" }
            : { code: 0, stdout: '{"appId":"cli_app_created"}', stderr: "config path\n" };
        }
        if (line.startsWith("config init")) {
          return {
            code: 0,
            stdout: "",
            stderr:
              "请访问 https://accounts.feishu.cn/app/create?xx=1 完成授权\n" +
              'debug: {"appSecret":"SENSITIVE-APP-SECRET"}\n',
          };
        }
        return { code: 1, stdout: "", stderr: "" };
      },
    });
    const { ensure_app } = await import("../../scripts/setup_bootstrap.mjs");

    const result = await ensure_app({
      home_dir: home,
      env: {},
      deps,
      cli_path: "lark-cli",
      create: true,
      io: { stdout: () => {}, stderr: (text: string) => forwarded.push(text) },
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("created");
    expect(result.app_id).toBe("cli_app_created");
    expect(forwarded.join("")).toContain("https://accounts.feishu.cn/app/create");
    expect(forwarded.join("")).not.toContain("SENSITIVE-APP-SECRET");
    expect(JSON.stringify(result)).not.toContain("SENSITIVE-APP-SECRET");
  });

  test("auth-login starts a device flow for the wiki/base/docs/drive domains", async () => {
    const home = path.join(tempRoot, "home");
    const { deps, calls } = fake_deps({
      run: async (_command, args) => {
        const line = args.join(" ");
        if (line.startsWith("auth status")) {
          return {
            code: 0,
            stdout: JSON.stringify({
              identities: { user: { status: "missing", available: false } },
            }),
            stderr: "",
          };
        }
        if (line.startsWith("auth login")) {
          return {
            code: 0,
            stdout: JSON.stringify({
              verification_url: "https://accounts.feishu.cn/device",
              user_code: "ABCD-1234",
              device_code: "device-1",
            }),
            stderr: "",
          };
        }
        return { code: 1, stdout: "", stderr: "" };
      },
    });
    const { auth_login } = await import("../../scripts/setup_bootstrap.mjs");

    const result = await auth_login({ home_dir: home, env: {}, deps, cli_path: "lark-cli" });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("pending_human");
    expect(result.verification_url).toBe("https://accounts.feishu.cn/device");
    expect(result.user_code).toBe("ABCD-1234");
    const login_call = calls.run.find((entry) => entry.join(" ").includes("auth login"));
    expect(login_call).toBeDefined();
    expect(login_call?.join(" ")).toContain("--no-wait");
    expect(login_call?.join(" ")).toContain("--domain");
    expect(login_call?.join(" ")).toContain("wiki,base,docs,drive");
  });

  test("auth-login confirms ready identities after a device code continuation", async () => {
    const home = path.join(tempRoot, "home");
    const { deps } = fake_deps({
      run: async (_command, args) => {
        const line = args.join(" ");
        if (line.startsWith("auth status")) {
          return {
            code: 0,
            stdout: JSON.stringify({
              identities: { user: { status: "ready", available: true } },
            }),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const { auth_login } = await import("../../scripts/setup_bootstrap.mjs");

    const result = await auth_login({
      home_dir: home,
      env: {},
      deps,
      cli_path: "lark-cli",
      device_code: "device-1",
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("ready");
  });

  test("auth-login ignores a non-zero login exit code and trusts the identity recheck", async () => {
    const home = path.join(tempRoot, "home");
    const { deps } = fake_deps({
      run: async (_command, args) => {
        const line = args.join(" ");
        if (line.startsWith("auth login")) {
          return { code: 3, stdout: "", stderr: "some domains were skipped\n" };
        }
        if (line.startsWith("auth status")) {
          return {
            code: 0,
            stdout: JSON.stringify({
              identities: { bot: { status: "ready" }, user: { status: "ready", available: true } },
            }),
            stderr: "",
          };
        }
        return { code: 1, stdout: "", stderr: "" };
      },
    });
    const { auth_login } = await import("../../scripts/setup_bootstrap.mjs");

    const result = await auth_login({
      home_dir: home,
      env: {},
      deps,
      cli_path: "lark-cli",
      device_code: "device-9",
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("ready");
  });

  test("auth-login treats a verified needs_refresh identity as ready", async () => {
    const home = path.join(tempRoot, "home");
    const { deps, calls } = fake_deps({
      run: async (_command, args) => {
        const line = args.join(" ");
        if (line.startsWith("auth status")) {
          const verified = line.includes("--verify");
          return {
            code: 0,
            stdout: JSON.stringify({
              identities: {
                user: {
                  status: "needs_refresh",
                  available: true,
                  ...(verified ? { verified: true } : {}),
                },
              },
            }),
            stderr: "",
          };
        }
        return { code: 1, stdout: "", stderr: "" };
      },
    });
    const { auth_login } = await import("../../scripts/setup_bootstrap.mjs");

    const result = await auth_login({ home_dir: home, env: {}, deps, cli_path: "lark-cli" });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("ready");
    const status_calls = calls.run.filter((entry) => entry.join(" ").includes("auth status"));
    expect(status_calls).toHaveLength(2);
    expect(status_calls[1].join(" ")).toContain("--verify");
    expect(
      calls.run.some((entry) => entry.join(" ").includes("auth login")),
      "可用会话不得重新发起设备授权",
    ).toBe(false);
  });

  test("auth-login reports AUTH_LOGIN_PENDING while the device flow is unfinished", async () => {
    const home = path.join(tempRoot, "home");
    const { deps } = fake_deps({
      run: async (_command, args) => {
        const line = args.join(" ");
        if (line.startsWith("auth status")) {
          return {
            code: 0,
            stdout: JSON.stringify({
              identities: { user: { status: "pending", available: false } },
            }),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const { auth_login } = await import("../../scripts/setup_bootstrap.mjs");

    const result = await auth_login({
      home_dir: home,
      env: {},
      deps,
      cli_path: "lark-cli",
      device_code: "device-1",
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("AUTH_LOGIN_PENDING");
  });

  test("run_cli maps AUTH_LOGIN_PENDING to exit code 2", async () => {
    const home = path.join(tempRoot, "home");
    const { deps } = fake_deps({
      run: async (_command, args) => {
        const line = args.join(" ");
        if (line.startsWith("auth status")) {
          return {
            code: 0,
            stdout: JSON.stringify({
              identities: { user: { status: "pending", available: false } },
            }),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const { run_cli } = await import("../../scripts/setup_bootstrap.mjs");
    const { io } = collect_io();

    const code = await run_cli(["auth-login", "--device-code", "device-1"], {
      home_dir: home,
      env: {},
      deps,
      io,
      cli_path: "lark-cli",
    });

    expect(code).toBe(2);
  });

  test("auth-login fails when the user identity is missing", async () => {
    const home = path.join(tempRoot, "home");
    const { deps } = fake_deps({
      run: async (_command, args) => {
        const line = args.join(" ");
        if (line.startsWith("auth status")) {
          return {
            code: 0,
            stdout: JSON.stringify({
              identities: { bot: { status: "ready" }, user: { status: "missing" } },
            }),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const { auth_login } = await import("../../scripts/setup_bootstrap.mjs");

    const result = await auth_login({
      home_dir: home,
      env: {},
      deps,
      cli_path: "lark-cli",
      device_code: "device-x",
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("AUTH_LOGIN_FAILED");
  });

  test("resolve-profile requires exactly one active profile", async () => {
    const home = path.join(tempRoot, "home");
    const ambiguous = fake_deps({
      run: async () => ({
        code: 0,
        stdout: JSON.stringify([
          { name: "cli_a", active: true },
          { name: "cli_b", active: true },
        ]),
        stderr: "",
      }),
    });
    const { resolve_profile } = await import("../../scripts/setup_bootstrap.mjs");

    const failed = await resolve_profile({
      home_dir: home,
      env: {},
      deps: ambiguous.deps,
      cli_path: "lark-cli",
    });
    expect(failed.ok).toBe(false);
    expect(failed.error.code).toBe("PROFILE_AMBIGUOUS");

    const unique = fake_deps({
      run: async () => ({
        code: 0,
        stdout: JSON.stringify([
          { name: "cli_a", active: false },
          { name: "cli_active", active: true },
        ]),
        stderr: "",
      }),
    });
    const succeeded = await resolve_profile({
      home_dir: home,
      env: {},
      deps: unique.deps,
      cli_path: "lark-cli",
    });
    expect(succeeded).toEqual({ ok: true, profile: "cli_active" });
  });

  test(
    "call-tool returns the raw health result over the real stdio bridge",
    async () => {
      const home = path.join(tempRoot, "home");
      mkdirSync(home, { recursive: true });
      const fake_cli = install_fake_cli(path.join(tempRoot, "bin"));
      const { call_tool } = await import("../../scripts/setup_bootstrap.mjs");

      const result = await call_tool(
        "health",
        {
          pending_config: {
            lark: {
              cli_path: fake_cli,
              profile: "default",
              space_a: "space-a-1",
              base_b: "basetoken-b-123456789",
            },
          },
        },
        {
          env: {
            ...process.env,
            SCRIPT2SHOT_HOME: home,
            FAKE_SCENARIO: "ok",
            FAKE_ACTIVE_PROFILE: "default",
          },
          home_dir: home,
          plugin_root: repoRoot,
        },
      );

      expect(result.config_source).toBe("pending");
      expect(Array.isArray(result.checks)).toBe(true);
    },
    30000,
  );

  test("call-tool keeps sensitive input off stdout, stderr and disk", async () => {
    const home = path.join(tempRoot, "home");
    const sensitive = "SENSITIVE-TOKEN-1";
    const { deps, calls } = fake_deps({
      mcp_session: async () => ({
        ok: true,
        results: [
          { content: [{ type: "text", text: JSON.stringify({ ok: true, config_source: "pending" }) }] },
        ],
      }),
    });
    const { call_tool } = await import("../../scripts/setup_bootstrap.mjs");
    const forwarded: string[] = [];

    const result = await call_tool(
      "write_config",
      { config: { lark: { profile: "profile-1", base_b: sensitive } } },
      {
        home_dir: home,
        env: {},
        deps,
        plugin_root: repoRoot,
        io: { stdout: () => {}, stderr: (text: string) => forwarded.push(text) },
      },
    );

    expect(result.ok).toBe(true);
    expect(calls.mcp_session).toHaveLength(1);
    expect(calls.mcp_session[0].requests[0]).toMatchObject({
      method: "tools/call",
      params: { name: "write_config" },
    });
    expect(JSON.stringify(result)).not.toContain(sensitive);
    expect(forwarded.join("")).not.toContain(sensitive);
    expect(
      existsSync(path.join(home, ".codex-script2shot", "tmp")),
      "stdin 路径不得在私有临时目录落盘",
    ).toBe(false);
  });

  test("call-tool consumes and deletes a private --input file", async () => {
    const home = path.join(tempRoot, "home");
    const tmp_dir = path.join(home, ".codex-script2shot", "tmp");
    mkdirSync(tmp_dir, { recursive: true });
    const input_file = path.join(tmp_dir, "input.json");
    writeFileSync(input_file, JSON.stringify({ pending_config: {} }), "utf8");
    const { deps } = fake_deps({
      mcp_session: async () => ({
        ok: true,
        results: [
          { content: [{ type: "text", text: JSON.stringify({ ok: true, config_source: "pending" }) }] },
        ],
      }),
    });
    const { call_tool } = await import("../../scripts/setup_bootstrap.mjs");

    const result = await call_tool("health", undefined, {
      home_dir: home,
      env: {},
      deps,
      plugin_root: repoRoot,
      input_file,
    });

    expect(result.config_source).toBe("pending");
    expect(existsSync(input_file), "--input 文件必须在调用后被删除").toBe(false);
  });

  test("call-tool rejects --input files outside the private tmp dir", async () => {
    const home = path.join(tempRoot, "home");
    mkdirSync(home, { recursive: true });
    const outside = path.join(tempRoot, "outside.json");
    writeFileSync(outside, "{}", "utf8");
    const { deps } = fake_deps();
    const { call_tool } = await import("../../scripts/setup_bootstrap.mjs");

    const result = await call_tool("health", undefined, {
      home_dir: home,
      env: {},
      deps,
      plugin_root: repoRoot,
      input_file: outside,
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("USAGE_ERROR");
    expect(existsSync(outside)).toBe(true);
  });

  test("call-tool surfaces a structured warning when temp cleanup fails", async () => {
    const home = path.join(tempRoot, "home");
    const tmp_dir = path.join(home, ".codex-script2shot", "tmp");
    mkdirSync(tmp_dir, { recursive: true });
    const input_file = path.join(tmp_dir, "input.json");
    writeFileSync(input_file, JSON.stringify({ pending_config: {} }), "utf8");
    const { deps } = fake_deps({
      remove_file: () => {
        throw new Error("EBUSY");
      },
      mcp_session: async () => ({
        ok: true,
        results: [
          { content: [{ type: "text", text: JSON.stringify({ ok: true, config_source: "pending" }) }] },
        ],
      }),
    });
    const { call_tool } = await import("../../scripts/setup_bootstrap.mjs");

    const result = await call_tool("health", undefined, {
      home_dir: home,
      env: {},
      deps,
      plugin_root: repoRoot,
      input_file,
    });

    expect(result.config_source).toBe("pending");
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "INPUT_TEMP_CLEANUP_FAILED" }),
    );
    expect(JSON.stringify(result)).not.toContain("EBUSY");
  });

  test("run_cli call-tool exits 0 for tool payloads without an ok flag", async () => {
    const home = path.join(tempRoot, "home");
    const { deps } = fake_deps({
      mcp_session: async () => ({
        ok: true,
        results: [
          {
            content: [
              {
                type: "text",
                text: JSON.stringify({ exists: false, path: "config.toml", warnings: [] }),
              },
            ],
          },
        ],
      }),
    });
    const { run_cli } = await import("../../scripts/setup_bootstrap.mjs");
    const { io, stdout } = collect_io();

    const code = await run_cli(["call-tool", "read_config"], {
      home_dir: home,
      env: {},
      deps,
      io,
      plugin_root: repoRoot,
      read_stdin: async () => "{}",
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ exists: false });
  });

  test(
    "call-tool does not hang when stdin is an open pipe with no data",
    async () => {
      const home = path.join(tempRoot, "home");
      mkdirSync(home, { recursive: true });
      const child = spawn(process.execPath, [scriptPath, "call-tool", "read_config"], {
        cwd: repoRoot,
        env: { ...process.env, SCRIPT2SHOT_HOME: home },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));

      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("call-tool hung on an open empty stdin pipe"));
        }, 10000);
        child.on("close", (exit) => {
          clearTimeout(timer);
          resolve(exit);
        });
      });
      child.stdin.destroy();

      expect(code).toBe(0);
      expect(JSON.parse(Buffer.concat(stdout).toString("utf8"))).toMatchObject({ exists: false });
    },
    30000,
  );
});

/** esbuild 平台包里的二进制路径（宿主策略拦截 postinstall 时它不会存在）。 */
function esbuild_binary_path(server_dir: string): string {
  if (isWindows) {
    const platform = process.arch === "arm64" ? "win32-arm64" : "win32-x64";
    return path.join(server_dir, "node_modules", "@esbuild", platform, "esbuild.exe");
  }
  const platform =
    process.platform === "darwin"
      ? process.arch === "arm64"
        ? "darwin-arm64"
        : "darwin-x64"
      : process.arch === "arm64"
        ? "linux-arm64"
        : "linux-x64";
  return path.join(server_dir, "node_modules", "@esbuild", platform, "bin", "esbuild");
}

/** 私有 prefix 里的 lark-cli 路径（架构 §5.2 的固定布局）。 */
function private_cli_path(home: string): string {
  return path.join(
    home,
    ".codex-script2shot",
    "cli",
    "node_modules",
    "@larksuite",
    "cli",
    "bin",
    isWindows ? "lark-cli.exe" : "lark-cli",
  );
}

function private_install_script(home: string): string {
  return path.join(
    home,
    ".codex-script2shot",
    "cli",
    "node_modules",
    "@larksuite",
    "cli",
    "scripts",
    "install.js",
  );
}

/** Windows 不能直接 spawn .cmd，必须经 cmd.exe（与启动器测试同一口径）。 */
function launcher_command(script_path: string, extra: string[]): { command: string; args: string[] } {
  if (isWindows) {
    return { command: "cmd.exe", args: ["/d", "/c", script_path, ...extra] };
  }
  return { command: "sh", args: [script_path, ...extra] };
}
