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
   * `write_config` 与 `init_knowledge_b` 属于 setup 流程，`validate_stage_artifact`
   * 是阶段产物校验入口，`validate_prompt` 是 PromptIR 硬规则校验入口，
   * `render_prompt` 是提示词渲染入口，
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
    "validate_stage_artifact",
    "validate_prompt",
    "render_prompt",
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
