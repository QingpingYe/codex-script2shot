import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, test } from "vitest";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const skillsRoot = path.join(repoRoot, "skills");
const isWindows = process.platform === "win32";
const launcherFileName = isWindows ? "launch_script2shot_mcp.cmd" : "launch_script2shot_mcp";

const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  ),
);

function listSkillFiles(): { skillDir: string; skillFile: string }[] {
  if (!existsSync(skillsRoot)) {
    return [];
  }
  return readdirSync(skillsRoot)
    .filter((entry) => statSync(path.join(skillsRoot, entry)).isDirectory())
    .map((entry) => ({ skillDir: entry, skillFile: path.join(skillsRoot, entry, "SKILL.md") }))
    .filter((entry) => existsSync(entry.skillFile));
}

function parseFrontmatter(markdown: string): Record<string, string> | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(markdown);
  if (!match) {
    return undefined;
  }
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (field) {
      fields[field[1]] = field[2].trim().replace(/^"([\s\S]*)"$/, "$1").replace(/^'([\s\S]*)'$/, "$1");
    }
  }
  return fields;
}

describe("skills contract", () => {
  const skillFiles = listSkillFiles();

  test.skipIf(skillFiles.length === 0)(
    "every skill has matching name and non-empty description",
    () => {
      for (const { skillDir, skillFile } of skillFiles) {
        const fields = parseFrontmatter(readFileSync(skillFile, "utf8"));
        expect(fields, `${skillDir}/SKILL.md should start with YAML frontmatter`).toBeDefined();
        expect(fields?.name, `${skillDir}/SKILL.md name should match its directory`).toBe(skillDir);
        expect((fields?.description ?? "").trim().length, `${skillDir}/SKILL.md description should be non-empty`).toBeGreaterThan(0);
      }
    },
  );
});

/**
 * setup 技能契约（架构 §9.1）：技能只做编排与翻译，确定性步骤交给
 * `scripts/setup_bootstrap.mjs`；不得把命令转交给用户。
 */
describe("setup skill content contract", () => {
  const setupSkillPath = path.join(skillsRoot, "setup", "SKILL.md");
  const SETUP_SUBCOMMANDS = [
    "setup_bootstrap",
    "doctor",
    "ensure-runtime",
    "install-cli",
    "build-server",
    "ensure-app",
    "auth-login",
    "profile",
    "call-tool",
  ];

  test("setup skill references every bootstrap subcommand", () => {
    const markdown = readFileSync(setupSkillPath, "utf8");

    for (const name of SETUP_SUBCOMMANDS) {
      expect(markdown, `setup SKILL.md 应引用 ${name}`).toContain(name);
    }
  });

  test("setup skill states the three human action classes", () => {
    const markdown = readFileSync(setupSkillPath, "utf8");

    expect(markdown).toContain("浏览器");
    expect(markdown).toContain("写入确认");
    expect(markdown).toContain("授权");
  });

  test("setup skill documents the write_config input shape", () => {
    const markdown = readFileSync(setupSkillPath, "utf8");

    expect(markdown).toContain("{ config: { lark, retrieval }");
  });

  test("setup skill never hands terminal commands to the user", () => {
    const markdown = readFileSync(setupSkillPath, "utf8");

    expect(markdown).not.toMatch(/请用户运行|请你在终端|自己去终端/);
    expect(markdown, "不得出现 profile 切换命令").not.toMatch(/profile use/);
  });
});

describe("shot-prompting skill content contract", () => {
  // B4：事件脚本化与长镜头阶段化是 shot-prompting 的写作规则。阶段化阈值只以规则
  // 文件字段名引用，具体数值留在 rules/models/<model>.json 的 prompt_guidance 里，
  // Skill 全文不允许出现写死的秒数阈值。
  const skillPath = path.join(skillsRoot, "shot-prompting", "SKILL.md");

  test("shot prompting skill documents staged event scripting without hardcoded thresholds", () => {
    const markdown = readFileSync(skillPath, "utf8");

    expect(markdown).toContain("## 事件脚本化");
    expect(markdown).toContain("prompt_guidance.long_shot_staging_threshold_sec");
    expect(markdown).not.toMatch(/15\s*秒|30\s*秒/);
  });

  // B5：负面约束策略与渲染前自检是 shot-prompting 的两组写作规则。模型化的负面措辞
  // 只以规则文件的 `prompt_guidance.negative` 字段名引用，Skill 不复制具体句式；自检
  // 是 LLM 语义核对，确定性的硬规则校验仍由 `validate_prompt` 承担。
  test("shot prompting skill documents negative constraint policy and pre-render checklist", () => {
    const markdown = readFileSync(skillPath, "utf8");

    expect(markdown).toContain("## 负面约束策略");
    expect(markdown).toContain("## 渲染前自检");
    expect(markdown).toContain("prompt_guidance.negative");
    expect(markdown).toContain("不替代 `validate_prompt`");
  });
});


describe("shortdrama v2 skill content contract", () => {
  const read = (name: string) => readFileSync(path.join(skillsRoot, name, "SKILL.md"), "utf8");

  test("entry documents references, display preference and versioned hashes", () => {
    const markdown = read("script2shot");
    for (const token of ["input_references", "display_timeline", "run_context_hash", "content_hash", "ARTIFACT_VERSION_UNSUPPORTED", "【生成目标】", "【保持一致】"]) {
      expect(markdown).toContain(token);
    }
  });

  test("entry requires asking for missing required run inputs", () => {
    const markdown = read("script2shot");
    for (const token of ["必填", "先向用户确认", "不得自行假设", "`target_model`", "`aspect_ratio`"]) {
      expect(markdown).toContain(token);
    }
  });

  test("breakdown documents entities, placeholders and processes", () => {
    const markdown = read("script-breakdown");
    for (const token of ["entities[]", "reference_assets[]", "processes[]", "placeholder", "input_hashes.run_context"]) {
      expect(markdown).toContain(token);
    }
  });

  test("planning documents clips, internal seconds and continuity", () => {
    const markdown = read("shot-planning");
    for (const token of ["clip", "shots[]", "start_sec", "end_sec", "split_reason", "AudioCue", "source_action_unit_ids"]) {
      expect(markdown).toContain(token);
    }
  });

  test("prompting removes one-shot-per-prompt rules and documents five modules", () => {
    const markdown = read("shot-prompting");
    for (const token of ["【生成目标】", "【参考素材职责】", "【主体与关系】", "【事件脚本】", "【保持一致】", "display_timeline", "dialogue_segment_id"]) {
      expect(markdown).toContain(token);
    }
    expect(markdown).not.toContain("一个镜头一段");
    expect(markdown).not.toContain("禁止自建秒数");
  });
});
function launcherCommand(scriptPath: string): { command: string; args: string[] } {
  if (isWindows) {
    return { command: "cmd.exe", args: ["/d", "/c", scriptPath] };
  }
  return { command: "sh", args: [scriptPath] };
}

async function connect_server(
  env_overrides: Record<string, string> = {},
): Promise<{ client: Client; errors: string[] }> {
  const { command, args } = launcherCommand(path.join(repoRoot, "scripts", launcherFileName));
  const transport = new StdioClientTransport({
    command,
    args,
    cwd: repoRoot,
    env: { ...inheritedEnv, ...env_overrides },
    stderr: "pipe",
  });
  const errors: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => errors.push(chunk.toString("utf8")));
  const client = new Client({ name: "script2shot-skills-contract-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, errors };
}

function parse_tool_json(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  const text = content?.find(
    (entry) => entry.type === "text" && typeof entry.text === "string",
  )?.text;
  if (text === undefined) {
    throw new Error(`tool result is missing text content: ${JSON.stringify(result)}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

describe("knowledge-sync mcp tools contract", () => {
  /**
   * tools/list 回归清单：名单里的 `health` 与七个同步工具
   * （scan/read/plan/fetch/replace/update/delete）是 knowledge-sync 直接消费的；
   * `write_config` 与 `init_knowledge_b` 属于 setup 流程，
   * `init_run` / `read_run` / `update_run_state` 是入口运行目录状态入口，
   * `validate_stage_artifact` 是阶段产物校验入口，
   * `validate_prompt` 是 PromptIR 硬规则校验入口，
   * `render_prompt` 是提示词渲染入口，
   * `aggregate_knowledge_refs` / `write_warnings` 是运行产物聚合入口，
   * 一并纳入额外回归覆盖。
   */
  const requiredToolNames = [
    "health",
    "write_config",
    "init_knowledge_b",
    "scan_knowledge_a",
    "read_sync_state",
    "build_sync_plan",
    "fetch_knowledge_a_doc",
    "replace_doc_cards",
    "update_doc_sync_state",
    "delete_doc_cards",
    "init_run",
    "read_run",
    "update_run_state",
    "validate_stage_artifact",
    "validate_prompt",
    "render_prompt",
    "aggregate_knowledge_refs",
    "write_warnings",
  ];

  test("tools/list exposes the tools consumed by knowledge-sync plus the setup tools", async () => {
    const { client, errors } = await connect_server();
    try {
      const result = await client.listTools();
      const toolsByName = new Map(result.tools.map((tool) => [tool.name, tool]));

      for (const name of requiredToolNames) {
        expect(toolsByName.has(name), `tools/list 应包含工具 ${name}`).toBe(true);
        const schema = toolsByName.get(name)?.inputSchema as
          | { additionalProperties?: unknown }
          | undefined;
        expect(
          schema?.additionalProperties,
          `工具 ${name} 的 inputSchema 应声明 additionalProperties: false`,
        ).toBe(false);
      }
      expect(errors.join(""), "server stderr should stay empty").toBe("");
    } finally {
      await client.close();
    }
  }, 30000);

  test("tools/list advertises the setup-facing config fields", async () => {
    const { client, errors } = await connect_server();
    try {
      const result = await client.listTools();
      const toolsByName = new Map(result.tools.map((tool) => [tool.name, tool]));

      const write_schema = toolsByName.get("write_config")?.inputSchema as
        | { properties?: Record<string, unknown> }
        | undefined;
      expect(
        write_schema?.properties?.preserve_existing,
        "write_config 必须在 schema 里公布 preserve_existing",
      ).toMatchObject({ type: "boolean" });

      for (const name of ["health", "init_knowledge_b"] as const) {
        const schema = toolsByName.get(name)?.inputSchema as
          | { properties?: Record<string, unknown> }
          | undefined;
        expect(schema?.properties?.pending_config, `${name} 必须公布 pending_config`).toMatchObject({
          type: "object",
        });
      }

      expect(errors.join(""), "server stderr should stay empty").toBe("");
    } finally {
      await client.close();
    }
  }, 30000);

  test("update_run_state advertises warning details and the non-empty artifact constraint", async () => {
    const { client, errors } = await connect_server();
    try {
      const result = await client.listTools();
      const tool = result.tools.find((entry) => entry.name === "update_run_state");
      expect(tool, "tools/list 应包含 update_run_state").toBeDefined();

      // R22：run.json 的 warning.details（如 RUN_STATE_RECONCILED.conflicts[]）已受
      // run.schema 支持，广告 schema 必须同步，否则调用方按广告 schema 组包会被误导。
      const schema = tool?.inputSchema as {
        properties?: Record<string, unknown>;
      };
      const warnings = schema.properties?.warnings as
        | {
            items?: {
              additionalProperties?: unknown;
              properties?: Record<string, unknown>;
              required?: string[];
            };
          }
        | undefined;
      expect(
        warnings?.items?.additionalProperties,
        "warnings 条目应继续拒绝未知字段",
      ).toBe(false);
      expect(warnings?.items?.properties?.details).toMatchObject({ type: "object" });
      expect(warnings?.items?.required ?? []).not.toContain("details");

      // 空字符串 artifact 由工具层拒绝；广告 schema 与 run.schema 一样用 anyOf 表达。
      const artifact = schema.properties?.artifact as Record<string, unknown> | undefined;
      expect(artifact?.anyOf).toEqual([
        { type: "string", minLength: 1 },
        { type: "null" },
      ]);

      expect(errors.join(""), "server stderr should stay empty").toBe("");
    } finally {
      await client.close();
    }
  }, 30000);

  test("build_sync_plan round-trips through stdio and rejects malformed arguments", async () => {
    const { client, errors } = await connect_server();
    try {
      const plan = parse_tool_json(
        await client.callTool({
          name: "build_sync_plan",
          arguments: {
            nodes: [
              {
                node_token: "nod-new",
                obj_token: "doc-new",
                title: "新增文档",
                path: "通用知识/拆镜方法/新增文档",
                obj_edit_time: "1760000000",
              },
            ],
            sync_records: [],
          },
        }),
      );
      expect(plan).toMatchObject({
        to_add: [{ source_doc_token: "doc-new", title: "新增文档" }],
        to_update: [],
        to_move: [],
        to_delete: [],
        unchanged: [],
        warnings: [],
      });

      const invalid = parse_tool_json(
        await client.callTool({
          name: "build_sync_plan",
          arguments: { nodes: "not-an-array", sync_records: [] },
        }),
      );
      expect(invalid).toMatchObject({
        ok: false,
        error: { code: "CONFIG_INVALID", details: { field: "nodes" } },
      });
      expect(errors.join(""), "server stderr should stay empty").toBe("");
    } finally {
      await client.close();
    }
  }, 30000);

  test("aggregation tools reject malformed arguments during dispatch", async () => {
    const { client, errors } = await connect_server();
    try {
      const aggregateUnknown = parse_tool_json(
        await client.callTool({
          name: "aggregate_knowledge_refs",
          arguments: {
            run_id: "run-20261020-120000",
            script_analysis_path: "script_analysis.json",
            shot_plan_path: "shot_plan.json",
            prompt_ir_path: "prompts.ir.json",
            output_path: "knowledge_refs.json",
            unexpected: true,
          },
        }),
      );
      expect(aggregateUnknown).toMatchObject({
        ok: false,
        error: { code: "CONFIG_INVALID", details: { field: "unexpected" } },
      });

      const warningsBlankPath = parse_tool_json(
        await client.callTool({
          name: "write_warnings",
          arguments: {
            run_id: "run-20261020-120000",
            run_path: "   ",
            script_analysis_path: "script_analysis.json",
            shot_plan_path: "shot_plan.json",
            prompt_ir_path: "prompts.ir.json",
            output_path: "warnings.md",
          },
        }),
      );
      expect(warningsBlankPath).toMatchObject({
        ok: false,
        error: { code: "CONFIG_INVALID", details: { field: "run_path" } },
      });
      expect(errors.join(""), "server stderr should stay empty").toBe("");
    } finally {
      await client.close();
    }
  }, 30000);

  test("rejects unknown parameters before any lark-cli child process can run", async () => {
    // 指向不存在的 CLI：若分发没有在参数校验阶段 fail-closed，scan_knowledge_a 会
    // 报 LARK_CLI_NOT_FOUND，而不是下面的 CONFIG_INVALID。
    const bogus_cli = path.join(repoRoot, "server", "tests", "fixtures", "lark-cli-does-not-exist");
    const { client, errors } = await connect_server({ LARK_CLI_PATH: bogus_cli });
    try {
      const result = parse_tool_json(
        await client.callTool({
          name: "scan_knowledge_a",
          arguments: { unexpected: true },
        }),
      );

      expect(result).toMatchObject({
        ok: false,
        error: { code: "CONFIG_INVALID", details: { field: "unexpected" } },
      });
      expect(errors.join(""), "server stderr should stay empty").toBe("");
    } finally {
      await client.close();
    }
  }, 30000);
});
