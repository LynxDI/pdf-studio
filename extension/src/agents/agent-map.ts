// Agent map generation.
//
// Writes CLAUDE.md / AGENTS.md / GEMINI.md (byte-identical) into the workspace
// so any coding agent (Claude Code / Codex / Gemini) auto-loads a description
// of how to edit PDFs *here*: by editing the OpenPDF Workflow file, not the
// binary PDF.
//
// The markdown itself lives in agent-map-content.ts (vscode-free) so build.mjs
// can reuse it to generate the Copilot `chatInstructions` file from one source.

import * as vscode from "vscode";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { buildAgentMap } from "./agent-map-content.js";

export { buildAgentMap };

const FILES = ["CLAUDE.md", "AGENTS.md", "GEMINI.md"];

export interface AgentMapResult {
  written: string[];
}

/**
 * True when `root` is the PDF Studio *development* monorepo (this repo). There
 * the agent map must NOT be generated: it would overwrite the dev-facing
 * CLAUDE.md (the monorepo guide coding agents rely on to build the extension).
 * Detected by the root manifest: name `pdf-studio-monorepo`, or a workspaces
 * list containing core + mcp + extension.
 */
export function isDevMonorepo(root: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      name?: string;
      workspaces?: string[] | { packages?: string[] };
    };
    if (pkg.name === "pdf-studio-monorepo") return true;
    const ws = pkg.workspaces;
    const list = Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : [];
    return ["core", "mcp", "extension"].every((w) => list.includes(w));
  } catch {
    return false;
  }
}

/** Write the agent map to the workspace root (best-effort; never throws out). */
export async function writeAgentMap(root: string, extensionVersion: string, log?: (m: string) => void): Promise<AgentMapResult> {
  if (isDevMonorepo(root)) {
    log?.("[agent-map] skipped: PDF Studio dev monorepo — won't overwrite the monorepo CLAUDE.md.");
    return { written: [] };
  }
  const content = buildAgentMap({ extensionVersion });
  const bytes = new TextEncoder().encode(content);
  const written: string[] = [];
  for (const name of FILES) {
    try {
      await vscode.workspace.fs.writeFile(vscode.Uri.file(path.join(root, name)), bytes);
      written.push(name);
    } catch (err) {
      log?.(`[agent-map] failed to write ${name}: ${(err as Error).message}`);
    }
  }
  return { written };
}
