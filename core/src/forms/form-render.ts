// renderFormDoc — a Markdown doc for a form: metadata, the friendly field table, and
// a copy-paste-ready .opw.yaml the user pastes into a new workflow (or the agent edits).
// Pure; reused by the extension's "PDF Fill" catalog webview and available to agents.

import type { FormField, FormSchema } from "./types.js";

function optionsCol(f: FormField): string {
  if (f.options) return Object.keys(f.options).join(" / ");
  if (f.choices) return f.choices.slice(0, 8).join(" / ");
  if (f.type === "date") return "YYYY-MM-DD";
  return "";
}

export function renderFormDoc(schema: FormSchema): string {
  const lines: string[] = [];
  const rev = schema.revision ? ` · rev ${schema.revision}` : "";
  const partial = schema.partial ? " · **partial mapping** (verify before filing)" : "";
  lines.push(`# ${schema.title}`, "");
  lines.push(`\`${schema.id}\` · ${schema.issuer || "—"} · ${schema.category}${rev}${partial}`, "");
  if (schema.roles?.length) lines.push(`**Roles:** ${schema.roles.join(", ")} — fill from your records via \`person\` + \`relations\` (or an explicit \`roles:\` map).`, "");

  lines.push("## Fields", "", "| key | label | type | required | options |", "|---|---|---|---|---|");
  for (const f of schema.fields) {
    if (f.type === "repeat") {
      const subs = (f.fields_repeat ?? []).map((s) => s.key).join(", ");
      lines.push(`| ${f.key} | ${f.label} | repeat×${f.max ?? "?"} (${f.role ?? "list"}) | | ${subs} |`);
    } else {
      lines.push(`| ${f.key} | ${f.label} | ${f.type} | ${f.required ? "yes" : ""} | ${optionsCol(f)} |`);
    }
  }
  lines.push("");

  lines.push("## Copy-paste workflow", "", "```yaml", formFillExampleYaml(schema), "```", "");
  lines.push("_Tip: run with `preview: true` first for a dry-run report of what will be filled._");
  return lines.join("\n");
}

/** A copy-paste `fill_form` workflow (YAML, no fences) for one form. When the pack
 *  ships a fully-worked `example` (mock person, all data inline), render that
 *  self-contained workflow; otherwise fall back to the generic `people.yaml` +
 *  placeholder version so the user knows which form-specific fields to set. */
export function formFillExampleYaml(schema: FormSchema): string {
  if (schema.example?.values) return filledExampleYaml(schema);
  const explicit = schema.fields.filter((f) => f.type !== "repeat" && !f.from && !f.template);
  const lines = [
    "version: 1", "kind: pdf",
    "inputs:", `  - input/${schema.id}.pdf`,
    "operations:", "  - fill_form:", `      form: ${schema.id}`, "      people: people.yaml", "      person: me",
  ];
  if (explicit.length) {
    lines.push("      values:");
    for (const f of explicit) lines.push(`        ${f.key}: ""        # ${f.label}${f.options ? ` (${Object.keys(f.options).join(" / ")})` : ""}`);
  }
  lines.push("      # flatten: true      # lock a print-ready final PDF");
  lines.push("output:", `  file: output/${schema.id}-filled.pdf`);
  return lines.join("\n");
}

/** Render a pack's fully-worked mock-up: all values inline (unquoted, in schema field
 *  order, each annotated with its label/options), optional flatten + page-drop. */
function filledExampleYaml(schema: FormSchema): string {
  const ex = schema.example!;
  const vals = ex.values ?? {};
  const labelOf = new Map(schema.fields.map((f) => [f.key, f]));
  const lines: string[] = [];
  if (ex.intro) for (const l of ex.intro.split("\n")) lines.push(`# ${l}`);
  lines.push(
    "version: 1", "kind: pdf",
    "inputs:", `  - input/${schema.id}.pdf`,
    "operations:", "  - fill_form:", `      form: ${schema.id}`, "      values:",
  );
  // Emit in schema field order (keeps related fields grouped), then any extra keys.
  const emitted = new Set<string>();
  const emit = (key: string) => {
    if (emitted.has(key) || !(key in vals)) return;
    emitted.add(key);
    const f = labelOf.get(key);
    const opts = f?.options ? ` (${Object.keys(f.options).join(" / ")})` : "";
    const note = f ? `        # ${f.label}${opts}` : "";
    lines.push(`        ${key}: ${vals[key]}${note}`);
  };
  for (const f of schema.fields) emit(f.key);
  for (const key of Object.keys(vals)) emit(key);
  if (ex.flatten) lines.push("      flatten: true      # bake a locked, print-ready final (also fixes XFA viewers showing spaces as \"&\")");
  if (ex.keepPages?.length) {
    if (ex.keepPagesNote) lines.push(`  # ${ex.keepPagesNote}`);
    lines.push("  - extract_pages:", `      pages: [${ex.keepPages.join(", ")}]`);
  }
  lines.push("output:", `  file: output/${schema.id}-filled.pdf`);
  return lines.join("\n");
}
