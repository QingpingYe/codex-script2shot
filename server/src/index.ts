import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { health } from "./tools/health.js";
import { init_knowledge_b, type InitKnowledgeBInput } from "./tools/init_knowledge_b.js";
import { write_config, type WriteConfigInput } from "./tools/write_config.js";

const server = new Server(
  { name: "script2shot", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

const TOOLS = [
  {
    name: "health",
    description: "只读检查：lark-cli 路径与版本、登录状态、知识库 A/B 可达性、本地目录与索引状态。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "write_config",
    description:
      "dry-run 预览或写入 ~/.codex-script2shot/config.toml，并按需创建本地目录；返回的 diff 中 base_b 已掩码。",
    inputSchema: {
      type: "object",
      properties: {
        config: {
          type: "object",
          description:
            "完整配置：{ lark: { cli_path, profile, space_a, base_b, knowledge_cards_table_id, sync_state_table_id, project_roots: [{ node_token, project_id }] }, retrieval: { default_top_k } }；缺省字段使用插件默认知识库配置（server/src/setup_defaults.ts）。",
        },
        create_local_dirs: {
          type: "boolean",
          description: "缺省 true：写入时创建本地 cache、index、logs 目录。",
        },
        dry_run: {
          type: "boolean",
          description: "缺省 true：只返回 diff 与将要创建的目录，不写任何文件、不建目录。",
        },
      },
      required: ["config"],
      additionalProperties: false,
    },
  },
  {
    name: "init_knowledge_b",
    description:
      "创建或校验知识库 B 的 KnowledgeCards 与 SyncState 两张数据表（按固定表名解析 table_id），" +
      "报告字段漂移；dry_run 缺省 true，只有 dry_run=false 且校验通过后才把 table_id 写回本地配置。",
    inputSchema: {
      type: "object",
      properties: {
        dry_run: {
          type: "boolean",
          description: "缺省 true：只读取并校验，不建表、不写配置。",
        },
      },
      additionalProperties: false,
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  if (name === "health") {
    const result = await health();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
  if (name === "write_config") {
    const result = write_config(
      (request.params.arguments ?? {}) as unknown as WriteConfigInput,
    );
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
  if (name === "init_knowledge_b") {
    const result = await init_knowledge_b(
      (request.params.arguments ?? {}) as unknown as InitKnowledgeBInput,
    );
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
  throw new McpError(ErrorCode.MethodNotFound, `未知工具：${name}`);
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error("script2shot MCP Server 启动失败:", error);
  process.exit(1);
});
