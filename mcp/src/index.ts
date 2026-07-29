#!/usr/bin/env node
// @pdf-studio/mcp — stdio entry point.
//
// Wired via .mcp.json as a local stdio MCP server (`node mcp/dist/index.js`), so
// any MCP-capable coding agent in the workspace gets the OPW helper tools.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";

async function main(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio transport keeps the process alive; log to stderr so stdout stays a
  // clean JSON-RPC channel.
  process.stderr.write("pdf-studio MCP server ready (stdio)\n");
}

main().catch((err) => {
  process.stderr.write(`pdf-studio MCP fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
