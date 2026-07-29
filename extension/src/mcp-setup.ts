// MCP server staging + workspace wiring.
//
// To make a project fully self-contained and portable, the bundled MCP server
// (dist/mcp/index.cjs) is copied INTO the project at .lynx-pdf-studio/mcp.cjs,
// and .mcp.json references it with a RELATIVE path — so the agent map, .mcp.json,
// and the server all live in the project folder and move with it. Written only
// on an explicit action (Initialize Project / Set Up MCP), never on activation.

import * as vscode from "vscode";
import * as path from "node:path";
import { buildMcpJson } from "./mcp-json.js";

/** Where the server lives inside the project, relative to the project root. */
export const PROJECT_SERVER_REL = ".lynx-pdf-studio/mcp.cjs";

/**
 * Copy the bundled MCP server into the project at {@link PROJECT_SERVER_REL}.
 * Returns that relative path, or undefined on failure (best-effort; never
 * throws). Overwrites so an extension update refreshes it on the next setup.
 */
export async function stageMcpServerInProject(
  root: string,
  extensionUri: vscode.Uri,
): Promise<string | undefined> {
  try {
    const src = vscode.Uri.joinPath(extensionUri, "dist", "mcp", "index.cjs");
    const destDir = vscode.Uri.file(path.join(root, ".lynx-pdf-studio"));
    const dest = vscode.Uri.file(path.join(root, ".lynx-pdf-studio", "mcp.cjs"));
    await vscode.workspace.fs.createDirectory(destDir);
    const bytes = await vscode.workspace.fs.readFile(src);
    await vscode.workspace.fs.writeFile(dest, bytes);
    return PROJECT_SERVER_REL;
  } catch {
    return undefined;
  }
}

/**
 * If the project already opted into MCP (a staged server exists), refresh it
 * from the current bundle so an extension update doesn't leave a stale server
 * (e.g. missing newly-added operations). No-op when not set up — it never
 * *creates* the file, so it doesn't litter a workspace on activation. Best
 * effort; only rewrites when the bundle actually differs (avoids churn).
 */
export async function refreshStagedMcpServer(root: string, extensionUri: vscode.Uri): Promise<void> {
  const dest = vscode.Uri.file(path.join(root, ".lynx-pdf-studio", "mcp.cjs"));
  let existing: Uint8Array;
  try {
    existing = await vscode.workspace.fs.readFile(dest); // absent → not set up → skip
  } catch {
    return;
  }
  try {
    const src = vscode.Uri.joinPath(extensionUri, "dist", "mcp", "index.cjs");
    const bytes = await vscode.workspace.fs.readFile(src);
    if (!Buffer.from(existing).equals(Buffer.from(bytes))) {
      await vscode.workspace.fs.writeFile(dest, bytes);
    }
  } catch {
    /* best effort */
  }
}

/**
 * Write (merging, not clobbering) a `.mcp.json` in the project root that wires
 * the `pdf-studio` server via a project-relative path. Preserves any other
 * servers already configured; throws (rather than overwrite) if the existing
 * file is present but unparseable. Returns the .mcp.json path.
 */
export async function writeMcpJson(root: string, relServerPath: string): Promise<string> {
  const file = path.join(root, ".mcp.json");
  const uri = vscode.Uri.file(file);
  let existingText: string | undefined;
  try {
    existingText = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
  } catch {
    existingText = undefined; // absent → create fresh
  }
  const next = buildMcpJson(existingText, relServerPath);
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(next));
  return file;
}
