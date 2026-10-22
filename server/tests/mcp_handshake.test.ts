import { spawn } from "node:child_process";
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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, test } from "vitest";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixturesDir = fileURLToPath(new URL("./fixtures", import.meta.url));
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

function install_fake_cli(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const wrapperName = isWindows ? "lark-cli.cmd" : "lark-cli";
  cpSync(
    path.join(fixturesDir, isWindows ? "fake-lark-cli.cmd" : "fake-lark-cli"),
    path.join(dir, wrapperName),
  );
  cpSync(path.join(fixturesDir, "fake-lark-cli.mjs"), path.join(dir, "lark-cli.mjs"));
  const wrapperPath = path.join(dir, wrapperName);
  if (!isWindows) {
    chmodSync(wrapperPath, 0o755);
  }
  return wrapperPath;
}

function server_env(overrides: Record<string, string> = {}): Record<string, string> {
  return { ...inheritedEnv, ...overrides };
}

async function connect_server(
  env: Record<string, string>,
): Promise<{ client: Client; errors: string[] }> {
  const { command, args } = launcherCommand(path.join(repoRoot, "scripts", launcherFileName));
  const transport = new StdioClientTransport({
    command,
    args,
    cwd: repoRoot,
    env,
    stderr: "pipe",
  });
  const errors: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => errors.push(chunk.toString("utf8")));
  const client = new Client({ name: "script2shot-tools-call-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, errors };
}

function parse_tool_json(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  const text = content?.find((entry) => entry.type === "text" && typeof entry.text === "string")?.text;
  if (text === undefined) {
    throw new Error(`tool result is missing text content: ${JSON.stringify(result)}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function write_health_config(home: string): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    path.join(home, "config.toml"),
    [
      "[lark]",
      'profile = "default"',
      'space_a = "space-a-1"',
      'base_b = "basetoken-b-123456789"',
      'knowledge_cards_table_id = "tbl_cards"',
      'sync_state_table_id = "tbl_state"',
      "",
      "[retrieval]",
      "default_top_k = 12",
      "",
    ].join("\n"),
    "utf8",
  );
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
      const toolNames = result.tools.map((tool) => tool.name);
      expect(toolNames).toContain("health");
      expect(toolNames).toContain("write_config");
      expect(toolNames).toContain("validate_prompt");
      expect(toolNames).toContain("render_prompt");
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

  test("tools/call writes config once", async () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "script2shot-tools-write-"));
    const home = path.join(tempRoot, "home");
    const { client, errors } = await connect_server(server_env({ SCRIPT2SHOT_HOME: home }));

    try {
      const result = await client.callTool({
        name: "write_config",
        arguments: {
          config: {
            lark: { space_a: "space-a-1", base_b: "basetoken-b-123456789" },
            retrieval: { default_top_k: 12 },
          },
          create_local_dirs: false,
          dry_run: false,
        },
      });
      const payload = parse_tool_json(result);

      expect(payload).toMatchObject({ dry_run: false, written: true });
      expect(existsSync(path.join(home, "config.toml"))).toBe(true);
      expect(errors.join(""), "server stderr should stay empty").toBe("");
    } finally {
      await client.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 30000);

  test("tools/call rejects a string dry_run flag", async () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "script2shot-tools-invalid-"));
    const home = path.join(tempRoot, "home");
    const { client } = await connect_server(server_env({ SCRIPT2SHOT_HOME: home }));

    try {
      const result = await client.callTool({
        name: "write_config",
        arguments: {
          config: {
            lark: { space_a: "space-a-1", base_b: "basetoken-b-123456789" },
          },
          dry_run: "false",
        },
      });
      const payload = parse_tool_json(result);

      expect(payload).toMatchObject({
        ok: false,
        error: { code: "CONFIG_INVALID", details: { field: "dry_run" } },
      });
      expect(existsSync(home), "invalid input must not create anything").toBe(false);
    } finally {
      await client.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 30000);

  test("tools/call validates stage artifacts and rejects malformed arguments", async () => {
    const { client, errors } = await connect_server(server_env());

    try {
      const artifact_path = path.join(repoRoot, "tests", "fixtures", "script_analysis.sample.json");
      const valid = parse_tool_json(
        await client.callTool({
          name: "validate_stage_artifact",
          arguments: { stage: "script_breakdown", path: artifact_path },
        }),
      );
      expect(valid).toEqual({ ok: true, errors: [] });

      const unknownKey = parse_tool_json(
        await client.callTool({
          name: "validate_stage_artifact",
          arguments: {
            stage: "script_breakdown",
            path: artifact_path,
            unexpected: true,
          },
        }),
      );
      expect(unknownKey).toMatchObject({
        ok: false,
        error: { code: "CONFIG_INVALID", details: { field: "unexpected" } },
      });

      const unknownStage = parse_tool_json(
        await client.callTool({
          name: "validate_stage_artifact",
          arguments: { stage: "unknown_stage", path: artifact_path },
        }),
      );
      expect(unknownStage).toMatchObject({
        ok: false,
        error: { code: "CONFIG_INVALID", details: { field: "stage" } },
      });

      const emptyPath = parse_tool_json(
        await client.callTool({
          name: "validate_stage_artifact",
          arguments: { stage: "script_breakdown", path: "   " },
        }),
      );
      expect(emptyPath).toMatchObject({
        ok: false,
        error: { code: "CONFIG_INVALID", details: { field: "path" } },
      });

      expect(errors.join(""), "server stderr should stay empty").toBe("");
    } finally {
      await client.close();
    }
  }, 30000);

  test("tools/call validates prompt ir and rejects malformed arguments", async () => {
    const { client, errors } = await connect_server(server_env());

    try {
      const prompt_ir_path = path.join(repoRoot, "tests", "fixtures", "prompts_ir.sample.json");
      const valid = parse_tool_json(
        await client.callTool({
          name: "validate_prompt",
          arguments: { prompt_ir_path },
        }),
      );
      expect(valid).toEqual({ ok: true, errors: [] });

      const unknownKey = parse_tool_json(
        await client.callTool({
          name: "validate_prompt",
          arguments: { prompt_ir_path, unexpected: true },
        }),
      );
      expect(unknownKey).toMatchObject({
        ok: false,
        error: { code: "CONFIG_INVALID", details: { field: "unexpected" } },
      });

      const emptyPath = parse_tool_json(
        await client.callTool({
          name: "validate_prompt",
          arguments: { prompt_ir_path: "   " },
        }),
      );
      expect(emptyPath).toMatchObject({
        ok: false,
        error: { code: "CONFIG_INVALID", details: { field: "prompt_ir_path" } },
      });

      expect(errors.join(""), "server stderr should stay empty").toBe("");
    } finally {
      await client.close();
    }
  }, 30000);

  test("tools/call renders prompt ir and rejects malformed arguments", async () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "script2shot-tools-render-"));
    const { client, errors } = await connect_server(
      server_env({ SCRIPT2SHOT_HOME: path.join(tempRoot, "home") }),
    );

    try {
      const prompt_ir_path = path.join(
        repoRoot,
        "tests",
        "fixtures",
        "prompts",
        "seedance-2.5.ir.json",
      );
      const output_path = path.join(tempRoot, "prompts.seedance-2.5.md");
      const rendered = parse_tool_json(
        await client.callTool({
          name: "render_prompt",
          arguments: { prompt_ir_path, output_path },
        }),
      );

      expect(rendered).toEqual({ ok: true, output_path });
      expect(readFileSync(output_path, "utf8")).toBe(
        readFileSync(
          path.join(repoRoot, "tests", "fixtures", "prompts", "seedance-2.5.golden.md"),
          "utf8",
        ),
      );

      const unknownKey = parse_tool_json(
        await client.callTool({
          name: "render_prompt",
          arguments: { prompt_ir_path, output_path, unexpected: true },
        }),
      );
      expect(unknownKey).toMatchObject({
        ok: false,
        error: { code: "CONFIG_INVALID", details: { field: "unexpected" } },
      });

      const blankOutput = parse_tool_json(
        await client.callTool({
          name: "render_prompt",
          arguments: { prompt_ir_path, output_path: "   " },
        }),
      );
      expect(blankOutput).toMatchObject({
        ok: false,
        error: { code: "CONFIG_INVALID", details: { field: "output_path" } },
      });

      const nonStringPromptIr = parse_tool_json(
        await client.callTool({
          name: "render_prompt",
          arguments: { prompt_ir_path: 42, output_path },
        }),
      );
      expect(nonStringPromptIr).toMatchObject({
        ok: false,
        error: { code: "CONFIG_INVALID", details: { field: "prompt_ir_path" } },
      });

      expect(errors.join(""), "server stderr should stay empty").toBe("");
    } finally {
      await client.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 30000);

  test("tools/call runs health with the configured fake CLI", async () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "script2shot-tools-health-"));
    const home = path.join(tempRoot, "home");
    const fakeCli = install_fake_cli(path.join(tempRoot, "bin"));
    write_health_config(home);
    for (const name of ["cache", "index", "logs"]) {
      mkdirSync(path.join(home, name), { recursive: true });
    }

    const { client } = await connect_server(
      server_env({
        SCRIPT2SHOT_HOME: home,
        LARK_CLI_PATH: fakeCli,
        FAKE_SCENARIO: "ok",
        FAKE_ACTIVE_PROFILE: "default",
      }),
    );

    try {
      const result = await client.callTool({ name: "health", arguments: {} });
      const payload = parse_tool_json(result);
      const checks = payload.checks as Array<{ id: string; status: string }>;

      expect(payload.ok).toBe(true);
      expect(checks.find((check) => check.id === "auth")).toMatchObject({ status: "pass" });
      expect(checks.find((check) => check.id === "config")).toMatchObject({ status: "pass" });
      expect(checks.find((check) => check.id === "base_b_reachable")).toMatchObject({
        status: "pass",
      });
    } finally {
      await client.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
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
