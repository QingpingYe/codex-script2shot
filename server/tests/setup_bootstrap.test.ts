import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  now: () => number;
}

interface FakeCalls {
  run: string[][];
  fetch_json: string[];
  fetch_bytes: string[];
  extract: string[][];
}

interface FakeBehavior {
  run?: (command: string, args: string[]) => RunResult | Promise<RunResult>;
  fetch_json?: (url: string) => unknown | Promise<unknown>;
  fetch_bytes?: (url: string) => Uint8Array | Promise<Uint8Array>;
  extract?: (
    archivePath: string,
    format: string,
    destination: string,
  ) => unknown | Promise<unknown>;
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
  const calls: FakeCalls = { run: [], fetch_json: [], fetch_bytes: [], extract: [] };
  const deps: FakeDeps = {
    run: async (command, args) => {
      calls.run.push([command, ...args]);
      return await (behavior.run?.(command, args) ?? {
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
      return await (behavior.extract?.(archivePath, format, destination) ?? { ok: true });
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
});

/** Windows 不能直接 spawn .cmd，必须经 cmd.exe（与启动器测试同一口径）。 */
function launcher_command(script_path: string, extra: string[]): { command: string; args: string[] } {
  if (isWindows) {
    return { command: "cmd.exe", args: ["/d", "/c", script_path, ...extra] };
  }
  return { command: "sh", args: [script_path, ...extra] };
}
