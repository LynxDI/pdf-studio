// Human-facing Markdown documentation for the operation vocabulary, rendered
// purely from the registry (OPERATIONS) + OP_DOCS + OP_CATEGORIES. Lives in core
// (no vscode/host deps — just strings) so the extension's sidebar "Documentation"
// node and the committed docs/operations.md share one source of truth.

import { OPERATIONS, type OperationSpec } from "./operations.js";
import { OP_DOCS, OP_CATEGORIES, SEARCH_KEYWORDS, type OpDoc } from "./op-docs.js";

type OpDocRecipes = OpDoc["recipes"];

/**
 * The lowercase haystack the Operations panel filters an operation against: its name (with
 * and without underscores), aliases, search synonyms, description, params and category.
 *
 * Lives here rather than in the webview so the vocabulary is testable and shared — a search
 * that can only match words the description happens to use makes `office_to_pdf` unreachable
 * by "powerpoint". Callers match however they like (the panel ANDs whitespace-separated
 * substrings); this only decides WHAT is searchable.
 */
export function opSearchIndex(op: string): string {
  const spec = OPERATIONS[op];
  if (!spec) return "";
  const doc = OP_DOCS[op];
  const parts = [
    op,
    op.replace(/_/g, ""),
    ...(spec.aliases ?? []),
    ...(SEARCH_KEYWORDS[op] ?? []),
    doc?.usage ?? spec.summary,
    spec.params.map((p) => p.name).join(" "),
    OP_CATEGORIES.find((c) => c.ops.includes(op))?.title ?? "",
  ];
  return parts.join(" ").toLowerCase().replace(/\s+/g, " ").trim();
}
import { formCategories, formFillExampleYaml } from "../forms/index.js";

function paramsTable(spec: OperationSpec): string {
  if (spec.params.length === 0) return "_This operation takes no parameters._";
  const rows = spec.params.map((p) => {
    const type = p.enum ? p.enum.map((e) => `\`${e}\``).join(" \\| ") : `\`${p.type}\``;
    const bounds = [p.min != null ? `min ${p.min}` : "", p.max != null ? `max ${p.max}` : ""].filter(Boolean).join(", ");
    return `| \`${p.name}\` | ${type} | ${p.required ? "**yes**" : "no"} | ${p.description}${bounds ? ` _(${bounds})_` : ""} |`;
  });
  return ["| Param | Type | Required | Description |", "|---|---|---|---|", ...rows].join("\n");
}

/** Build a complete, copy-pasteable OPW workflow that runs `op` — the input
 *  documents, the operation with realistic params, and the output file. */
export function buildExampleWorkflow(op: string): string {
  const doc = OP_DOCS[op];
  const params = doc?.example ?? "{}";
  const inputs = doc?.inputs;
  const inputsBlock =
    inputs && inputs.length > 0
      ? "inputs:\n" + inputs.map((i) => `  - ${i}`).join("\n")
      : inputs && inputs.length === 0
        ? "inputs: []"
        : "inputs:\n  - input.pdf";
  // Some ops only work downstream of another (create_form needs a converter to have rendered
  // the template first). An example that can't be pasted and run is worse than no example.
  const ops = [
    ...(doc?.before ?? []).map((b) => `  - ${b}`),
    `  - ${op}: ${params}`,
    ...(doc?.after ?? []).map((a) => `  - ${a}`),
  ];

  const output = doc?.output ?? "output/result.pdf";
  // Ops that emit their own files declare a `folder:` destination; single-document ops declare
  // a `file:`. An op that writes to its own `to` param needs no output block at all.
  const outputKey = OPERATIONS[op]?.emitsFiles ? "folder" : "file";
  const outputBlock = doc?.noOutput ? [] : ["output:", `  ${outputKey}: ${output}`];
  return ["version: 1", "kind: pdf", inputsBlock, "operations:", ...ops, ...outputBlock].join("\n");
}

/** Extra copy-pasteable workflows for ops whose real use is a recipe, not one line.
 *  `heading` varies by host: the standalone op page nests under its own H2, the
 *  combined reference nests under each op's H3. */
function recipeSections(recipes: OpDocRecipes, heading: string): string[] {
  if (!recipes?.length) return [];
  const out = [`${heading.slice(1)} More workflows`, ""];
  for (const r of recipes) {
    out.push(`${heading} ${r.title}`, "", r.description, "", "```yaml", r.yaml, "```", "");
  }
  return out;
}

/** A plain-English "ask your AI agent" block. Every operation can be added to a workflow or
 *  spun into a new one by an AI coding agent editing the `.opw.yaml`, so show the user how to
 *  ask. The action phrase is derived from the op's own summary. */
function aiPromptSection(op: string, spec: OperationSpec): string[] {
  const summary = (spec.summary || op).replace(/\s*\.\s*$/, "");
  // Lowercase the leading word so it reads as "…that stamps…"; leave acronyms ("OCR …") alone.
  const action = /^[A-Z][a-z]/.test(summary) ? summary[0]!.toLowerCase() + summary.slice(1) : summary;
  return [
    "## ✨ Ask an AI agent to build this",
    "",
    "You don't have to write YAML by hand. Tell your AI coding agent (Claude Code, Cursor, Copilot, …)",
    "what you want in plain English and it edits your `.opw.yaml` for you:",
    "",
    `> **Add to a workflow —** _"Add a \`${op}\` step that ${action}."_`,
    ">",
    `> **New workflow —** _"Create a workflow that ${action}."_`,
    "",
    `The agent reads the same operation registry as this page, so it already knows \`${op}\` and its parameters — plain English is enough. (Set up the MCP server from the Operations panel so the agent can validate as it edits.)`,
    "",
  ];
}

/** A full documentation page for a single operation. */
export function renderOpDoc(op: string): string {
  const spec = OPERATIONS[op];
  const doc = OP_DOCS[op];
  if (!spec) return `# ${op}\n\n_Unknown operation._`;
  return [
    `# \`${op}\``,
    "",
    doc?.usage ?? spec.summary,
    "",
    ...(spec.aliases?.length
      ? [`_Also written as ${spec.aliases.map((a) => `\`${a}\``).join(", ")}._`, ""]
      : []),
    "## Parameters",
    "",
    paramsTable(spec),
    "",
    "## Example workflow",
    "",
    "```yaml",
    buildExampleWorkflow(op),
    "```",
    "",
    ...(doc?.result ? [`**Result:** ${doc.result}`, ""] : []),
    ...recipeSections(doc?.recipes, "###"),
    ...aiPromptSection(op, spec),
    ...(op === "fill_form" ? perFormExamples() : []),
    "> Save as `workflow.opw.yaml` and Render, or add just this operation via the sidebar object tree / **Add Operation…**. In the Operations panel, ⧉ copies this example to your clipboard.",
    "",
    `_Capability: \`${spec.capability}\` · applies to: ${spec.kinds.join(", ")}_`,
  ].join("\n");
}

/** A copy-paste `fill_form` workflow for every supported form, grouped by category.
 *  Driven by the form registry, so a new form pack appears here automatically. */
function perFormExamples(): string[] {
  const out: string[] = ["## Example workflow for each form", ""];
  for (const cat of formCategories()) {
    for (const f of cat.forms) {
      out.push(`### ${f.title} — \`${f.id}\`${f.revision ? `@${f.revision}` : ""} · ${cat.title}${f.partial ? " · partial" : ""}`, "", "```yaml", formFillExampleYaml(f), "```", "");
    }
  }
  return out;
}

/** The full operations reference (all categories, all ops). */
export function renderOpReference(): string {
  const total = Object.keys(OPERATIONS).length;
  const lines = [
    "# Lynx PDF Studio — Operations Reference",
    "",
    `**${total} operations.** A workflow (\`workflow.opw.yaml\`) lists \`inputs\`, an ordered \`operations:\` program, and an \`output\`. Each operation below is one entry in that list.`,
    "",
    "## Contents",
    "",
    ...OP_CATEGORIES.map((c) => `- ${c.title}`),
    "",
  ];
  for (const cat of OP_CATEGORIES) {
    lines.push(`## ${cat.title}`, "");
    for (const op of cat.ops) {
      const spec = OPERATIONS[op];
      const doc = OP_DOCS[op];
      if (!spec) continue;
      const params = spec.params.map((p) => `\`${p.name}${p.required ? "*" : ""}\``).join(", ") || "—";
      const inputs = doc?.inputs
        ? doc.inputs.length
          ? doc.inputs.join(", ")
          : "(none — sourced from params)"
        : "input.pdf";
      lines.push(
        `### \`${op}\``,
        "",
        doc?.usage ?? spec.summary,
        "",
        `- **params:** ${params}`,
        // Aliases are real spellings a user may search for or type; without this the
        // only place they exist is the registry.
        ...(spec.aliases?.length
          ? [`- **also written as:** ${spec.aliases.map((a) => `\`${a}\``).join(", ")}`]
          : []),
        `- **inputs:** ${inputs} → **output:** \`${doc?.output ?? "output/result.pdf"}\``,
        `- **operation:** \`${op}: ${doc?.example ?? "{}"}\``,
        ...(doc?.result ? [`- **result:** ${doc.result}`] : []),
        "",
        // Ops are H3 here, so the recipe block nests one deeper than on the standalone page.
        ...recipeSections(doc?.recipes, "#####"),
      );
    }
  }
  lines.push("_* = required parameter._");
  return lines.join("\n");
}
