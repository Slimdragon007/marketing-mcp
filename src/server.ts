import { McpServer } from "@modelcontextprotocol/server";
import type { ToolContext } from "./tools/common";
import { registerMetaTools } from "./tools/meta";
import { registerReadTools } from "./tools/read";
import { registerWriteTools } from "./tools/write";

export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "marketing-mcp", version: "0.1.0" });
  registerReadTools(server, ctx);
  registerMetaTools(server, ctx);
  registerWriteTools(server, ctx);
  return server;
}
