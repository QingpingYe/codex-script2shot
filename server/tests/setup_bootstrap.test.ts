import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

let tempRoot = "";

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "script2shot-bootstrap-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

/** 全假依赖：记录调用，任何真实子进程 / 网络都不会发生。 */
function fake_deps(overrides: Partial<FakeDeps> = {}): { deps: FakeDeps; calls: FakeCalls } {
  const calls: FakeCalls = { run: [], fetch_json: [], fetch_bytes: [], extract: [] };
  const deps: FakeDeps = {
    run: async (command, args) => {
      calls.run.push([command, ...args]);
      return { code: 0, stdout: "v26.8.2\n", stderr: "" };
    },
    fetch_json: async (url) => {
      calls.fetch_json.push(url);
      return { ok: true };
    },
    fetch_bytes: async (url) => {
      calls.fetch_bytes.push(url);
      return new Uint8Array();
    },
    extract: async (archivePath, format, destination) => {
      calls.extract.push([archivePath, format, destination]);
      return { ok: true };
    },
    now: () => 1760000000000,
    ...overrides,
  };
  return { deps, calls };
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
});

/** Windows 不能直接 spawn .cmd，必须经 cmd.exe（与启动器测试同一口径）。 */
function launcher_command(script_path: string, extra: string[]): { command: string; args: string[] } {
  if (isWindows) {
    return { command: "cmd.exe", args: ["/d", "/c", script_path, ...extra] };
  }
  return { command: "sh", args: [script_path, ...extra] };
}
