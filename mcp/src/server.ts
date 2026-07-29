// PDF Studio MCP server — the OpenPDF Workflow (OPW) tool surface.
//
// These tools are deterministic, side-effect-free helpers over OPW text: they
// parse, validate, optimize, compile-to-plan, diff, list the vocabulary, and
// scaffold. They do NOT render PDFs or touch the filesystem — heavy execution
// runs locally in the VS Code extension (or `pdf-studio run`). The split is
// deliberate: the MCP is the agent's reasoning surface, the local worker does
// the compute.
//
// The intended agent loop:
//   1. read workflow.opw.yaml
//   2. edit it (add/remove/reorder operations)
//   3. call opw_validate → fix every error
//   4. (optional) opw_compile to preview the execution plan
//   5. let the extension render it

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  parseWorkflow,
  serializeWorkflow,
  validateWorkflow,
  optimizeWorkflow,
  compileWorkflow,
  describePlan,
  diffWorkflows,
  capabilityRegistry,
  OPERATIONS,
  lookupOperation,
  OP_DOCS,
  OPW_VERSION,
  VERSION as CORE_VERSION,
  listForms,
  getFormSchema,
  formCategories,
  renderFormDoc,
  blankPeople,
} from "@pdf-studio/core";

export const MCP_SERVER_VERSION = "0.1.0";

const MAX_OPW_BYTES = 1 * 1024 * 1024;

const INSTRUCTIONS = `PDF Studio MCP — helpers for authoring OpenPDF Workflow (OPW) files.

OPW is a deterministic document-transformation DSL: a workflow lists input
documents and an ordered program of operations (merge, delete_pages, rotate,
watermark, set_metadata, …) that render to an output PDF. The OPW file is the
source of truth; the PDF is a build artifact. Prefer editing the .opw.yaml over
touching the PDF directly.

Pipeline: OPW → Validator → Optimizer → Execution Plan → Renderer Adapter → PDF.

Output is either a single file (\`output: { file: out.pdf }\`) or a directory
(\`output: { folder: out/dir }\`) for operations that emit many files (e.g.
split_invoices → one PDF per invoice). \`output\` may be omitted when an operation
already emits its own files. Pages are 1-based.

Batch: a glob in \`inputs\` (\`invoices/*.pdf\`, \`**\`) runs the whole workflow once per
matched file. The output must be per-input — an \`output.folder\` or a templated
\`output.file\` ({stem}/{name}/{ext}/{i}). Glob expansion is filesystem-dependent, so
opw_compile/opw_validate see the glob literally (they don't expand it). EXCEPTION —
merge a whole folder: \`merge\` (and \`extract_form\`) instead fold ALL matched files into
ONE run, in sorted filename order. So \`inputs: [docs/*.pdf]\` + \`merge\` → a single
combined PDF with a plain \`output.file\`; to control order, name files so they sort
(01-…, 02-…) or list them explicitly.

Variables & conditionals: declare \`vars: { name: value }\` (scalars) and reference them as
\`\${name}\` in params and output paths — a whole-value \`"\${n}"\` keeps the number type; quote
every \`\${...}\` (an unquoted \`\${\` is a YAML flow-map). An op can carry a \`when:\` guard
(sibling key) that runs it only if a predicate is true over document facts (\`pages\`,
\`pdf_version\`, \`encrypted\`, \`tagged\`, \`size_kb\`, plus \`has_text\`/\`has_images\` with the
Python backend) and vars — e.g. \`when: "has_text == false"\` to skip OCR when a text layer
already exists. Vars are file-local (never read the environment).

Redact/hide info: \`auto_redact\` permanently DELETES matched content. Match by literal
\`text: ["…"]\` (add \`ignore_case: true\` / \`whole_word: true\`), named PII \`patterns:
["ssn","email","phone","credit_card","ein","ipv4","iban"]\`, and/or custom \`regex\`.
The render note reports any rule that matched nothing — verify. Set \`preview: true\`
first for a dry run (writes a report of what WOULD be redacted, applies nothing). Add
\`rasterize: true\` (+ optional \`dpi\`) to flatten the whole document to an image-only
PDF so nothing hidden (text layer, metadata, off-page content) survives — the safest
output to share. \`redact { page, rects, rasterize: true }\` hides regions by coordinate.

Mark text (don't delete it): \`highlight\` takes the SAME matcher as auto_redact (\`text\`,
\`patterns\`, \`regex\`, \`ignore_case\`, \`whole_word\`, \`preview\`) but marks each hit instead —
\`style: highlight|underline|strikeout|squiggly|box\`, plus \`color\`, \`pages\` and a \`note\`
popup. Reach for it whenever the ask is "highlight/flag/mark/call out" rather than "hide".
The marks are real annotations (\`extract_annotations\` reads them back, \`remove_annotations\`
clears them); \`flatten: true\` bakes them in permanently.

compare_pdfs: add \`side_by_side: true\` for one shareable diff.pdf; \`tolerance\` (0-255)
ignores rendering noise. translate: add \`layout: true\` to render a translated PDF that
keeps the original layout (in place) instead of Markdown.

Fill PDF forms: \`fill_form { form, people, person }\` fills a known form (passport, tax,
…) from a shared \`people.yaml\` records file — one record per person, linked by
\`relations\`, choose whose info with \`person\`. Discover forms with \`form_list\`, a form's
fields with \`form_fields\`, and a starter records file with \`form_people\`. \`values\` sets
form-specific keys; \`signature\`+\`flatten\` produce a locked final; \`preview: true\` writes
a dry-run report. Prefer \`people\`+\`person\` over inline \`values\` so PII stays out of the file.

Tools:
  - opw_operations  list the OPW operation vocabulary + capabilities.
  - opw_validate    structural diagnostics on an OPW file. Run after every edit.
  - opw_optimize    behavior-preserving rewrites (returns the optimized OPW).
  - opw_compile     compile to an execution plan (shows which backend runs each
                    op, and which ops need a backend that isn't installed).
  - opw_diff        semantic diff between two OPW revisions.
  - opw_scaffold    generate a starter OPW file.
  - form_list       list supported fillable forms by category.
  - form_fields     one form's fillable fields + a copy-paste workflow.
  - form_people     a starter people.yaml records file (PII, gitignored).
  - form_scaffold   generate a ready fill_form workflow from a form + records.

These tools never render or write files. The VS Code extension executes the
workflow locally (pdf-lib bundled; PyMuPDF/pikepdf/qpdf optional).`;

const opwArg = z
  .string()
  .max(MAX_OPW_BYTES, `OPW text exceeds ${MAX_OPW_BYTES} bytes`)
  .describe("Full OpenPDF Workflow (OPW) file content as YAML or JSON text.");

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "pdf-studio", version: MCP_SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.tool(
    "opw_operations",
    "List the OpenPDF Workflow operation vocabulary: each operation, the capability it needs, the document kinds it applies to, and its parameters.",
    {},
    async () => {
      const lines: string[] = [`# OPW operations (schema v${OPW_VERSION}, core ${CORE_VERSION})`, ""];
      for (const spec of Object.values(OPERATIONS)) {
        const params = spec.params
          .map((p) => `${p.name}${p.required ? "*" : ""}:${p.type}${p.enum ? `(${p.enum.join("|")})` : ""}`)
          .join(", ");
        const doc = OP_DOCS[spec.name];
        lines.push(`- ${spec.name} — ${spec.summary}`);
        if (doc) lines.push(`    usage: ${doc.usage}`);
        lines.push(`    capability: ${spec.capability} · kinds: ${spec.kinds.join("/")}${params ? ` · params: ${params}` : ""}`);
        if (doc) lines.push(`    example: { ${spec.name}: ${doc.example} }`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.tool(
    "opw_validate",
    "Validate OPW text and return structural diagnostics (errors + warnings) with stable codes. Run after every edit; fix all errors before rendering.",
    { opw: opwArg },
    async ({ opw }) => {
      try {
        const wf = parseWorkflow(opw);
        const diags = validateWorkflow(wf);
        if (diags.length === 0) {
          return { content: [{ type: "text", text: "✓ valid — no diagnostics." }] };
        }
        const text = diags
          .map((d) => `${d.severity === "error" ? "✗" : "⚠"} [${d.code}] ${d.message}${d.opIndex !== undefined ? ` (op #${d.opIndex + 1})` : ""}`)
          .join("\n");
        const errs = diags.filter((d) => d.severity === "error").length;
        return { content: [{ type: "text", text: `${errs} error(s), ${diags.length - errs} warning(s):\n${text}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `parse error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    "opw_optimize",
    "Apply behavior-preserving rewrites (drop no-op merge, coalesce metadata, single trailing compress) and return the optimized OPW plus the list of rewrites.",
    { opw: opwArg },
    async ({ opw }) => {
      try {
        const { workflow, rewrites } = optimizeWorkflow(parseWorkflow(opw));
        const summary = rewrites.length
          ? rewrites.map((r) => `- [${r.code}] ${r.message}`).join("\n")
          : "(no rewrites — already optimal)";
        return {
          content: [
            { type: "text", text: `## Rewrites\n${summary}\n\n## Optimized OPW\n\`\`\`yaml\n${serializeWorkflow(workflow)}\`\`\`` },
          ],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `parse error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    "opw_compile",
    "Compile OPW to an execution plan: the ordered steps, which renderer backend runs each, and any operations whose capability no installed backend provides (e.g. OCR without PyMuPDF). Does not render.",
    { opw: opwArg },
    async ({ opw }) => {
      try {
        const wf = parseWorkflow(opw);
        const { workflow } = optimizeWorkflow(wf);
        const plan = compileWorkflow(workflow, { registry: capabilityRegistry() });
        return { content: [{ type: "text", text: "```\n" + describePlan(plan) + "\n```" }] };
      } catch (err) {
        return { content: [{ type: "text", text: `parse error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    "opw_diff",
    "Semantic diff between two OPW revisions (before → after): added / removed / changed operations, inputs, and output.",
    { before: opwArg, after: opwArg },
    async ({ before, after }) => {
      try {
        const changes = diffWorkflows(parseWorkflow(before), parseWorkflow(after));
        const text = changes.length
          ? changes.map((c) => `${symbol(c.kind)} ${c.message}`).join("\n")
          : "(no differences)";
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return { content: [{ type: "text", text: `parse error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    "opw_scaffold",
    "Generate a starter OPW file for the given inputs and output. A good first draft an agent can then edit. If any requested operation emits its own files (e.g. split_invoices), the output is scaffolded as a folder.",
    {
      inputs: z.array(z.string().min(1)).min(1).describe("Relative paths of input documents."),
      output: z.string().min(1).describe("Relative output path — a file (output/final.pdf) or, for file-emitting ops, a folder (output/invoices)."),
      operations: z
        .array(z.string())
        .optional()
        .describe('Optional operation keywords to include as stubs, e.g. ["merge", "watermark"] or ["split_invoices"].'),
    },
    async ({ inputs, output, operations }) => {
      // Keep aliases: they live in OP_ALIASES, not OPERATIONS, so an `Object.hasOwn`
      // check would silently drop `interleave`/`metadata`/… from the scaffold.
      const ops = (operations ?? (inputs.length > 1 ? ["merge"] : [])).filter((o) => lookupOperation(o));
      // If an op emits its own files, the output is a directory (no passthrough).
      const emitsFiles = ops.some((o) => lookupOperation(o)?.emitsFiles);
      const wf = parseWorkflow(
        JSON.stringify({
          version: OPW_VERSION,
          kind: "pdf",
          inputs,
          operations: ops.map((o) => ({ [o]: {} })),
          output: emitsFiles ? { folder: output } : { file: output },
        }),
      );
      return { content: [{ type: "text", text: "```yaml\n" + serializeWorkflow(wf) + "```" }] };
    },
  );

  // --- PDF form filling (form_*) ------------------------------------------------
  server.tool(
    "form_list",
    "List the supported fillable PDF forms (passport, tax, …), grouped by category. Use this to discover which forms fill_form knows, then form_fields for one form's schema.",
    { category: z.string().optional().describe("Filter to one category, e.g. Tax or Passport.") },
    async ({ category }) => {
      const cats = formCategories().filter((c) => !category || c.title.toLowerCase() === category.toLowerCase());
      const lines: string[] = ["# Supported forms", ""];
      for (const c of cats) {
        lines.push(`## ${c.title}`);
        for (const f of c.forms) {
          lines.push(`- \`${f.id}\`${f.revision ? `@${f.revision}` : ""} — ${f.title} (${f.issuer || "—"}${f.partial ? ", partial" : ""}) · ${f.fields.length} fields`);
        }
        lines.push("");
      }
      if (cats.length === 0) lines.push("(no forms match)");
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.tool(
    "form_fields",
    "Show a form's fillable fields (friendly keys, types, options, roles) plus a copy-paste .opw.yaml. Call before fill_form so you know what values to collect from the user.",
    { form: z.string().describe("A form id from form_list, e.g. ds11 or f1040.") },
    async ({ form }) => {
      const schema = getFormSchema(form);
      if (!schema) return { content: [{ type: "text", text: `Unknown form "${form}". Call form_list to see available forms.` }], isError: true };
      return { content: [{ type: "text", text: renderFormDoc(schema) }] };
    },
  );

  server.tool(
    "form_people",
    "Return a starter people.yaml — the local, private records file (many persons, linked by relations) that fill_form draws values from. Help the user fill it in, then reference it as `people:` + `person:`.",
    {},
    async () => ({ content: [{ type: "text", text: "```yaml\n" + blankPeople() + "```\n\nKeep this file LOCAL — it holds PII. The extension's **Init People** command creates it already git-ignored; if you write it by hand, add `people.yaml` (and `*.people.yaml`) to your `.gitignore` yourself. One `people.yaml` fills every form." }] }),
  );

  server.tool(
    "form_scaffold",
    "Generate a ready-to-render fill_form workflow for a known form, drawing values from a people.yaml record. Prefer `people`+`person` over inline `values` so PII stays out of the workflow file.",
    {
      form: z.string().describe("A form id from form_list, e.g. ds11."),
      input: z.string().describe("Relative path to the blank form PDF, e.g. input/ds11.pdf."),
      people: z.string().optional().describe("Path to the people.yaml records file (or a records/ dir)."),
      person: z.string().optional().describe("Which person id fills the primary role."),
      roles: z.record(z.string(), z.string()).optional().describe("Optional role → person-id map, e.g. { spouse: bob }."),
      values: z.record(z.string(), z.any()).optional().describe("Optional explicit field values (form-specific keys)."),
      flatten: z.boolean().optional().describe("Bake into a locked, print-ready final PDF."),
    },
    async ({ form, input, people, person, roles, values, flatten }) => {
      const schema = getFormSchema(form);
      if (!schema) return { content: [{ type: "text", text: `Unknown form "${form}". Call form_list.` }], isError: true };
      const params: Record<string, unknown> = { form };
      if (people) params["people"] = people;
      if (person) params["person"] = person;
      if (roles) params["roles"] = roles;
      if (values) params["values"] = values;
      if (flatten) params["flatten"] = true;
      const wf = parseWorkflow(
        JSON.stringify({
          version: OPW_VERSION,
          kind: "pdf",
          inputs: [input],
          operations: [{ fill_form: params }],
          output: { file: `output/${schema.id}-filled.pdf` },
        }),
      );
      const known = new Set(schema.fields.map((f) => f.key));
      const unknown = Object.keys(values ?? {}).filter((k) => !known.has(k));
      const note = unknown.length ? `\n\n> Note: unknown field key(s) for ${schema.id}: ${unknown.join(", ")} — see form_fields.` : "";
      return { content: [{ type: "text", text: "```yaml\n" + serializeWorkflow(wf) + "```" + note }] };
    },
  );

  return server;
}

function symbol(kind: string): string {
  return kind === "added" ? "+" : kind === "removed" ? "-" : "~";
}
