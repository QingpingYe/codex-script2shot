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
      expect(toolNames).toContain("read_config");
      expect(toolNames).toContain("write_config");
      expect(toolNames).toContain("init_run");
      expect(toolNames).toContain("read_run");
      expect(toolNames).toContain("update_run_state");
      expect(toolNames).toContain("validate_prompt");
      expect(toolNames).toContain("render_prompt");
      expect(toolNames).toContain("aggregate_knowledge_refs");
      expect(toolNames).toContain("write_warnings");
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

  test("tools/call runs run-directory tools and rejects malformed arguments", async () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "script2shot-tools-run-"));
    const { client, errors } = await connect_server(server_env());

    try {
      const initialized = parse_tool_json(
        await client.callTool({
          name: "init_run",
          arguments: {
            workspace_root: tempRoot,
            input_mode: "single_episode",
            project_id: "demo",
            target_model: "seedance-2.5",
            aspect_ratio: "9:16",
          },
        }),
      );
      const run_id = initialized.run_id as string;
      expect(run_id).toMatch(/^run-\d{8}-\d{6}$/);
      expect(initialized.run_json_path).toBe(
        path.join(tempRoot, ".script2shot", "outputs", run_id, "run.json"),
      );

      const read = parse_tool_json(
        await client.callTool({
          name: "read_run",
          arguments: { workspace_root: tempRoot, run_id },
        }),
      );
      expect(read).toMatchObject({
        run: { run_id, aspect_ratio: "9:16" },
        artifacts: {
          script_breakdown: { exists: false, valid: false },
          shot_planning: { exists: false, valid: false },
          shot_prompting: { exists: false, valid: false },
        },
        warnings: [],
      });

      const updated = parse_tool_json(
        await client.callTool({
          name: "update_run_state",
          arguments: {
            workspace_root: tempRoot,
            run_id,
            stage: "script_breakdown",
            status: "running",
          },
        }),
      );
      expect(updated).toMatchObject({
        run: {
          run_id,
          aspect_ratio: "9:16",
          stages: { script_breakdown: { status: "running" } },
        },
      });

      const unknownKey = parse_tool_json(
        await client.callTool({
          name: "init_run",
          arguments: {
            workspace_root: tempRoot,
            input_mode: "single_episode",
            project_id: "demo",
            target_model: "seedance-2.5",
            unexpected: true,
          },
        }),
      );
      expect(unknownKey).toMatchObject({
        ok: false,
        error: { code: "CONFIG_INVALID", details: { field: "unexpected" } },
      });

      const invalidAspectRatio = parse_tool_json(
        await client.callTool({
          name: "init_run",
          arguments: {
            workspace_root: tempRoot,
            input_mode: "single_episode",
            project_id: "demo",
            target_model: "seedance-2.5",
            aspect_ratio: "2:1",
          },
        }),
      );
      expect(invalidAspectRatio).toMatchObject({
        ok: false,
        error: { code: "CONFIG_INVALID", details: { field: "aspect_ratio" } },
      });

      const missingWorkspaceRoot = parse_tool_json(
        await client.callTool({
          name: "read_run",
          arguments: { run_id },
        }),
      );
      expect(missingWorkspaceRoot).toMatchObject({
        ok: false,
        error: { code: "CONFIG_INVALID", details: { field: "workspace_root" } },
      });

      const invalidStatus = parse_tool_json(
        await client.callTool({
          name: "update_run_state",
          arguments: {
            workspace_root: tempRoot,
            run_id,
            stage: "script_breakdown",
            status: "complete",
          },
        }),
      );
      expect(invalidStatus).toMatchObject({
        ok: false,
        error: { code: "CONFIG_INVALID", details: { field: "status" } },
      });

      expect(errors.join(""), "server stderr should stay empty").toBe("");
    } finally {
      await client.close();
      rmSync(tempRoot, { recursive: true, force: true });
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

  test("tools/call aggregates refs and warnings and rejects malformed arguments", async () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "script2shot-tools-aggregate-"));
    const runDir = path.join(tempRoot, "run");
    mkdirSync(runDir, { recursive: true });
    const runId = "run-20261020-120000";
    const runPath = path.join(runDir, "run.json");
    const scriptAnalysisPath = path.join(runDir, "script_analysis.json");
    const shotPlanPath = path.join(runDir, "shot_plan.json");
    const promptIrPath = path.join(runDir, "prompts.ir.json");
    const knowledgeRefsPath = path.join(runDir, "knowledge_refs.json");
    const warningsPath = path.join(runDir, "warnings.md");

    writeFileSync(
      runPath,
      `${JSON.stringify(
        {
          run_id: runId,
          input_mode: "single_episode",
          project_id: "demo",
          target_model: "seedance-2.5",
          warnings: [],
          stages: {
            script_breakdown: { status: "done", artifact: "script_analysis.json", updated_at: null },
            shot_planning: { status: "done", artifact: "shot_plan.json", updated_at: null },
            shot_prompting: { status: "done", artifact: "prompts.ir.json", updated_at: null },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    cpSync(
      path.join(repoRoot, "tests", "fixtures", "script_analysis.sample.json"),
      scriptAnalysisPath,
    );
    cpSync(path.join(repoRoot, "tests", "fixtures", "shot_plan.sample.json"), shotPlanPath);
    cpSync(
      path.join(repoRoot, "tests", "fixtures", "prompts_ir.sample.json"),
      promptIrPath,
    );

    const { client, errors } = await connect_server(server_env());
    try {
      const aggregated = parse_tool_json(
        await client.callTool({
          name: "aggregate_knowledge_refs",
          arguments: {
            run_id: runId,
            script_analysis_path: scriptAnalysisPath,
            shot_plan_path: shotPlanPath,
            prompt_ir_path: promptIrPath,
            output_path: knowledgeRefsPath,
          },
        }),
      );
      expect(aggregated).toEqual({
        output_path: knowledgeRefsPath,
        counts: {
          script_breakdown: 1,
          shot_planning: 1,
          shot_prompting: 1,
        },
      });
      expect(existsSync(knowledgeRefsPath)).toBe(true);

      const warnings = parse_tool_json(
        await client.callTool({
          name: "write_warnings",
          arguments: {
            run_id: runId,
            run_path: runPath,
            script_analysis_path: scriptAnalysisPath,
            shot_plan_path: shotPlanPath,
            prompt_ir_path: promptIrPath,
            output_path: warningsPath,
          },
        }),
      );
      expect(warnings).toEqual({ output_path: warningsPath, count: 1 });
      expect(readFileSync(warningsPath, "utf8")).toContain("SCENE_TIME_UNKNOWN");

      const aggregateUnknown = parse_tool_json(
        await client.callTool({
          name: "aggregate_knowledge_refs",
          arguments: {
            run_id: runId,
            script_analysis_path: scriptAnalysisPath,
            shot_plan_path: shotPlanPath,
            prompt_ir_path: promptIrPath,
            output_path: knowledgeRefsPath,
            unexpected: true,
          },
        }),
      );
      expect(aggregateUnknown).toMatchObject({
        ok: false,
        error: { code: "CONFIG_INVALID", details: { field: "unexpected" } },
      });

      const warningsBlankRunPath = parse_tool_json(
        await client.callTool({
          name: "write_warnings",
          arguments: {
            run_id: runId,
            run_path: "   ",
            script_analysis_path: scriptAnalysisPath,
            shot_plan_path: shotPlanPath,
            prompt_ir_path: promptIrPath,
            output_path: warningsPath,
          },
        }),
      );
      expect(warningsBlankRunPath).toMatchObject({
        ok: false,
        error: { code: "CONFIG_INVALID", details: { field: "run_path" } },
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
