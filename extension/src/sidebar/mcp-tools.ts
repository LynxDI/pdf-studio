// The MCP tool surface, surfaced in the sidebar so users discover how agents
// drive PDF Studio. These are the deterministic OPW helpers exposed by the
// bundled `pdf-studio` MCP server (mcp/dist/index.js, wired via .mcp.json) —
// an MCP-capable coding agent (Claude Code / Codex / Gemini) calls them.
//
// Keep in sync with mcp/src/server.ts when the tool surface changes.

export interface McpToolDoc {
  /** Tool name as registered on the MCP server. */
  name: string;
  /** Codicon id for the row. */
  icon: string;
  /** One-line description shown dimmed next to the name. */
  summary: string;
  /** Call signature. */
  signature: string;
  /** "Ask your agent" example. */
  ask: string;
}

export const MCP_SERVER = {
  id: "pdf-studio",
  label: "pdf-studio",
  transport: "local · stdio",
  command: "node .lynx-pdf-studio/mcp.cjs",
};

export const MCP_TOOLS: McpToolDoc[] = [
  {
    name: "opw_validate",
    icon: "checklist",
    summary: "Structural diagnostics — run after every edit",
    signature: "opw_validate({ opw })",
    ask: "“validate the workflow”",
  },
  {
    name: "opw_compile",
    icon: "terminal",
    summary: "Preview the execution plan + unsatisfied capabilities",
    signature: "opw_compile({ opw })",
    ask: "“show the execution plan”",
  },
  {
    name: "opw_optimize",
    icon: "sparkle",
    summary: "Behavior-preserving rewrites",
    signature: "opw_optimize({ opw })",
    ask: "“optimize the workflow”",
  },
  {
    name: "opw_diff",
    icon: "git-compare",
    summary: "Semantic diff between two revisions",
    signature: "opw_diff({ before, after })",
    ask: "“diff these two workflow revisions”",
  },
  {
    name: "opw_operations",
    icon: "list-unordered",
    summary: "List the operation vocabulary",
    signature: "opw_operations()",
    ask: "“what operations can I use?”",
  },
  {
    name: "opw_scaffold",
    icon: "new-file",
    summary: "Generate a starter workflow",
    signature: "opw_scaffold({ inputs, output, operations? })",
    ask: "“scaffold a workflow that merges these PDFs and watermarks them”",
  },
];

/** Per-tool Markdown doc opened when a tool row is clicked. */
export function renderToolDoc(tool: McpToolDoc): string {
  return `# \`${tool.name}\`  ·  MCP tool

${tool.summary}

**Signature**

\`\`\`
${tool.signature}
\`\`\`

**Ask your agent**

> ${tool.ask}

---

This tool is served by the local **${MCP_SERVER.label}** MCP server
(${MCP_SERVER.transport}). It is deterministic and never renders or writes files
— the extension does the actual rendering locally. See **MCP Tools → How to use**
for how to connect the server to your coding agent.
`;
}

/** Overview Markdown: the whole surface + how to wire the server into an agent. */
export function renderOverviewDoc(): string {
  const rows = MCP_TOOLS.map((t) => `| \`${t.name}\` | ${t.summary} |`).join("\n");
  return `# Lynx PDF Studio — MCP Tools

Lynx PDF Studio ships a local **MCP server** (\`${MCP_SERVER.label}\`) that gives
any MCP-capable coding agent deterministic OpenPDF Workflow (OPW) helpers. The
agent edits your \`.opw.yaml\`; these tools let it validate, plan, optimize, diff,
and scaffold safely. **The MCP server never renders** — the extension renders
locally.

| tool | what it does |
|------|--------------|
${rows}

## Connect it to your agent

- **GitHub Copilot / VS Code agent mode — nothing to do.** The extension registers
  the server with VS Code's own MCP host, so these tools show up in Copilot's agent
  mode automatically once the extension is active (VS Code 1.101+).

For MCP clients that read a project \`.mcp.json\`, run **“Lynx PDF Studio: Set Up MCP
for This Workspace”** (Command Palette, or the **Set up for this workspace** row under
MCP Tools). It writes a \`.mcp.json\` into this folder pointing at the bundled server
(staged in your home dir), e.g.:

\`\`\`json
{
  "mcpServers": {
    "pdf-studio": {
      "command": "node",
      "args": ["${MCP_SERVER.command.replace("node ", "")}"]
    }
  }
}
\`\`\`

- **Claude Code**: picks up the workspace \`.mcp.json\` automatically (approve it
  when prompted). **Initialize Project** writes it for you too.
- **Cursor / Codex / Gemini**: add the same block to their MCP config.

## The loop

1. Edit \`workflow.opw.yaml\` (or ask the agent to).
2. Agent calls **\`opw_validate\`** → fixes every error.
3. (optional) **\`opw_compile\`** to preview the plan.
4. **Render Workflow** (▶) in the sidebar → \`output/*.pdf\`.
`;
}
