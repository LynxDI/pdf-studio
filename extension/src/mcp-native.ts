// Native VS Code MCP registration.
//
// Surfaces the bundled `pdf-studio` MCP server to VS Code's OWN MCP host — the
// one GitHub Copilot's agent mode uses — via the finalized
// `lm.registerMcpServerDefinitionProvider` API (VS Code 1.101+). This is the
// counterpart to the Claude-Code-style `.mcp.json` we write in mcp-setup.ts:
//   - `.mcp.json` (project root, `mcpServers` key) → Claude Code / Cursor.
//   - this provider → GitHub Copilot / VS Code agent mode, ZERO config.
// The two don't overlap: VS Code Copilot doesn't read the root `.mcp.json`, and
// Claude Code doesn't see this provider — so a user gets our tools in whichever
// agent they use, without hand-wiring.
//
// The server (dist/mcp/index.cjs) is cwd-independent — its tools take the OPW
// text as arguments and never touch the filesystem — so we point VS Code
// straight at the extension's bundled copy; no per-project staging needed.
//
// Typed against a minimal local shim (not @types/vscode) + runtime feature-
// detected, so it compiles under our pinned `engines.vscode` floor and simply
// no-ops on VS Code builds that predate the API (or on non-VS Code MCP clients).

import * as vscode from "vscode";

/** The subset of `vscode.McpStdioServerDefinition` we construct. */
type McpStdioCtor = new (
  label: string,
  command: string,
  args?: string[],
  env?: Record<string, string>,
  version?: string,
) => unknown;

/** The subset of `vscode.lm` we call, present only on VS Code 1.101+. */
interface LmWithMcp {
  registerMcpServerDefinitionProvider?(
    id: string,
    provider: { provideMcpServerDefinitions(): unknown[] | Thenable<unknown[]> },
  ): vscode.Disposable;
}

// Must match the `id` of the contributes.mcpServerDefinitionProviders entry in
// package.json — VS Code binds the two by this string.
const PROVIDER_ID = "pdf-studio";

/**
 * Register the bundled MCP server with VS Code's native MCP host. Best-effort:
 * on older VS Code (API absent) it logs and returns without throwing. Safe to
 * call unconditionally from activate().
 */
export function registerNativeMcpProvider(
  context: vscode.ExtensionContext,
  version: string,
  log?: (m: string) => void,
): void {
  const lm = vscode.lm as unknown as LmWithMcp | undefined;
  const McpStdioServerDefinition = (
    vscode as unknown as { McpStdioServerDefinition?: McpStdioCtor }
  ).McpStdioServerDefinition;

  if (typeof lm?.registerMcpServerDefinitionProvider !== "function" || !McpStdioServerDefinition) {
    log?.(
      "[mcp] native VS Code MCP API unavailable (needs VS Code 1.101+); " +
        "Copilot users can still wire the server via 'Set Up MCP' (.mcp.json).",
    );
    return;
  }

  const serverPath = vscode.Uri.joinPath(context.extensionUri, "dist", "mcp", "index.cjs").fsPath;

  try {
    context.subscriptions.push(
      lm.registerMcpServerDefinitionProvider(PROVIDER_ID, {
        provideMcpServerDefinitions() {
          // `version` is passed through so a VS Code extension update (new ops)
          // prompts VS Code to restart the server rather than reuse a stale one.
          return [new McpStdioServerDefinition("Lynx PDF Studio", "node", [serverPath], {}, version)];
        },
      }),
    );
    log?.(`[mcp] registered native VS Code MCP server provider '${PROVIDER_ID}' → ${serverPath}`);
  } catch (err) {
    log?.(`[mcp] native MCP provider registration failed: ${(err as Error).message}`);
  }
}
