// Pure `.mcp.json` merging — no vscode/fs, so it's unit-testable. Kept separate
// from mcp-setup.ts (which does the actual file IO) so the merge/clobber logic
// can be exercised in isolation.

/**
 * Merge the `pdf-studio` server into an existing `.mcp.json` body, preserving
 * every other server. `existingText` is the current file contents, or undefined
 * when the file doesn't exist yet.
 *
 * Refuses to clobber: if the file EXISTS but isn't a valid JSON object, throws
 * instead of silently overwriting the user's config (which would drop their
 * other servers). Returns the new file text (trailing newline included).
 */
export function buildMcpJson(existingText: string | undefined, relServerPath: string): string {
  let json: { mcpServers?: Record<string, unknown> } = {};
  if (existingText !== undefined && existingText.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existingText);
    } catch (e) {
      throw new Error(`.mcp.json exists but is not valid JSON (${(e as Error).message}). Fix or remove it, then retry — refusing to overwrite it.`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`.mcp.json exists but is not a JSON object. Fix or remove it, then retry — refusing to overwrite it.`);
    }
    json = parsed as typeof json;
  }
  const servers = json.mcpServers && typeof json.mcpServers === "object" ? json.mcpServers : {};
  json.mcpServers = { ...servers, "pdf-studio": { command: "node", args: [relServerPath.replace(/\\/g, "/")] } };
  return JSON.stringify(json, null, 2) + "\n";
}
