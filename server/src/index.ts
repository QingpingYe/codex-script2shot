import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { health } from "./tools/health.js";

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
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  if (name === "health") {
    const result = await health();
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
