import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, test } from "vitest";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const isWindows = process.platform === "win32";
const launcherFileName = isWindows ? "launch_script2shot_mcp.cmd" : "launch_script2shot_mcp";

const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

function launcherCommand(scriptPath: string): { command: string; args: string[] } {
  if (isWindows) {
    return { command: "cmd.exe", args: ["/d", "/c", scriptPath] };
  }
  return { command: "sh", args: [scriptPath] };
}

function runCollecting(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: inheritedEnv, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} ${args.join(" ")} did not exit in time`));
    }, 15000);
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

describe("mcp handshake", () => {
  test("stdio server completes initialize and returns tool list", async () => {
    const { command, args } = launcherCommand(path.join(repoRoot, "scripts", launcherFileName));
    const transport = new StdioClientTransport({
      command,
      args,
      cwd: repoRoot,
      env: inheritedEnv,
      stderr: "pipe",
    });
    const errors: string[] = [];
    transport.stderr?.on("data", (chunk: Buffer) => errors.push(chunk.toString("utf8")));
    const client = new Client({ name: "script2shot-handshake-test", version: "0.0.0" });

    try {
      await client.connect(transport);
      expect(client.getServerVersion()?.name).toBe("script2shot");

      const result = await client.listTools();
      expect(Array.isArray(result.tools)).toBe(true);
      for (const tool of result.tools) {
        expect(typeof tool.name).toBe("string");
        expect(tool.name.length).toBeGreaterThan(0);
        expect(tool.inputSchema.type).toBe("object");
      }
    } finally {
      await client.close();
    }

    expect(errors.join(""), "server stderr should stay empty").toBe("");
  }, 30000);

  test("handshake fails with build hint when dist missing", async () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "script2shot-launcher-"));
    try {
      const scriptsDir = path.join(tempRoot, "scripts");
      mkdirSync(scriptsDir, { recursive: true });
      cpSync(
        path.join(repoRoot, "scripts", launcherFileName),
        path.join(scriptsDir, launcherFileName),
      );

      const { command, args } = launcherCommand(path.join(scriptsDir, launcherFileName));
      const result = await runCollecting(command, args, tempRoot);
      expect(result.code, "launcher should fail when server/dist/server.mjs is missing").not.toBe(0);

      const output = `${result.stdout}\n${result.stderr}`.replaceAll("\\", "/");
      expect(output).toContain("server/dist/server.mjs");
      expect(output).toContain("npm --prefix server run build");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
