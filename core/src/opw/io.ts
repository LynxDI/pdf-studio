// OPW parsing & serialization.
//
// The on-disk form is YAML-first (JSON is a subset, so both parse). Operations
// are authored as single-key objects — `- delete_pages: { pages: [10, 11] }` —
// and normalized to `{ name, params }` for the rest of the pipeline. On
// serialize we re-emit the single-key form so a hand-edited or agent-edited
// file stays idiomatic.
//
// Unknown top-level keys survive a parse → serialize round-trip (stored on
// `workflow.extra`) so a forward-compatible field written by a newer client is
// not silently dropped by an older one.

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { OPW_VERSION, type OpNode, type OutputSpec, type Workflow } from "./model.js";

/** Thrown when the input is not valid YAML/JSON or not a workflow object. */
export class OpwParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpwParseError";
  }
}

const KNOWN_TOP_LEVEL = new Set([
  "version",
  "kind",
  "inputs",
  "vars",
  "assets",
  "operations",
  "output",
  "document", // legacy: v0.9 draft nested inputs under `document.input`
]);

/**
 * Parse OPW text (YAML or JSON) into a {@link Workflow}. Tolerant of the two
 * documented shapes: the flat form (`inputs:` at top level) and the v0.9-draft
 * form (`document: { input: [...] }`). Throws {@link OpwParseError} only on
 * structural failure — semantic problems are the validator's job.
 */
export function parseWorkflow(text: string): Workflow {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new OpwParseError(`invalid YAML/JSON: ${(err as Error).message}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new OpwParseError("workflow must be a YAML/JSON object at the top level");
  }
  const obj = raw as Record<string, unknown>;

  // inputs: flat `inputs` or legacy `document.input`.
  let inputs: string[] = [];
  if (Array.isArray(obj["inputs"])) {
    inputs = (obj["inputs"] as unknown[]).map(String);
  } else if (
    obj["document"] &&
    typeof obj["document"] === "object" &&
    Array.isArray((obj["document"] as Record<string, unknown>)["input"])
  ) {
    inputs = ((obj["document"] as Record<string, unknown>)["input"] as unknown[]).map(String);
  }

  const operations = normalizeOperations(obj["operations"]);
  const output = normalizeOutput(obj["output"]);
  const assets = normalizeAssets(obj["assets"]);
  const vars = normalizeVars(obj["vars"]);

  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!KNOWN_TOP_LEVEL.has(k)) extra[k] = v;
  }

  const wf: Workflow = {
    version: typeof obj["version"] === "number" ? (obj["version"] as number) : OPW_VERSION,
    kind: typeof obj["kind"] === "string" ? (obj["kind"] as string) : "pdf",
    inputs,
    ...(vars ? { vars } : {}),
    operations,
    ...(output ? { output } : {}),
    ...(assets ? { assets } : {}),
    ...(Object.keys(extra).length ? { extra } : {}),
  };
  return wf;
}

/** Read the `vars:` block. Entries are kept as-is (including any non-scalar, cast
 *  to the scalar type) so the validator can flag a non-scalar; resolveVars only
 *  substitutes scalar values. An empty/absent block yields undefined. */
function normalizeVars(raw: unknown): Record<string, string | number | boolean> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (!entries.length) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of entries) out[k] = v as string | number | boolean;
  return out;
}

function normalizeAssets(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = String(v);
  return out;
}

function normalizeOutput(raw: unknown): OutputSpec | undefined {
  if (raw == null) return undefined; // omitted entirely — legal when an op emits its own files
  if (typeof raw === "string") return { file: raw };
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    const file = typeof o["file"] === "string" ? (o["file"] as string) : undefined;
    const folder = typeof o["folder"] === "string" ? (o["folder"] as string) : undefined;
    return { ...o, ...(file !== undefined ? { file } : {}), ...(folder !== undefined ? { folder } : {}) } as OutputSpec;
  }
  return { file: "" }; // malformed (number/array) → empty file so the validator flags it
}

/**
 * Normalize the `operations` array. Each item is a single-key object mapping an
 * op name to its params (`{}` allowed for no-param ops). A bare string item
 * (e.g. `- merge`) is accepted as `{ merge: {} }`.
 */
export function normalizeOperations(raw: unknown): OpNode[] {
  if (!Array.isArray(raw)) return [];
  const out: OpNode[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      out.push({ name: item, params: {} });
      continue;
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const rec = item as Record<string, unknown>;
      // `when` is a reserved SIBLING key (a per-op guard), not an operation — pull
      // it out before resolving which remaining key names the operation.
      const when = typeof rec["when"] === "string" ? (rec["when"] as string) : undefined;
      const guard = when ? { when } : {};
      const entries = Object.entries(rec).filter(([k]) => k !== "when");
      // Support both { name, params } and single-key { <op>: params } forms.
      if (entries.length === 2 && typeof rec["name"] === "string" && "params" in rec) {
        const p = rec["params"];
        out.push({
          name: String(rec["name"]),
          params: p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {},
          ...guard,
        });
        continue;
      }
      if (entries.length >= 1) {
        const [name, params] = entries[0] as [string, unknown];
        out.push({
          name,
          params:
            params && typeof params === "object" && !Array.isArray(params)
              ? (params as Record<string, unknown>)
              : params === null || params === undefined
                ? {}
                : { value: params },
          ...guard,
        });
        continue;
      }
    }
    // Unrecognized item shape: keep a placeholder so validation can flag it.
    out.push({ name: "(invalid)", params: {} });
  }
  return out;
}

/**
 * Serialize a {@link Workflow} back to YAML in the idiomatic single-key op
 * form. Deterministic key order (version, kind, inputs, assets, operations,
 * output) so diffs stay small.
 */
export function serializeWorkflow(wf: Workflow): string {
  const doc: Record<string, unknown> = {
    version: wf.version,
    kind: wf.kind,
    inputs: wf.inputs,
  };
  if (wf.vars && Object.keys(wf.vars).length) doc["vars"] = wf.vars;
  if (wf.assets && Object.keys(wf.assets).length) doc["assets"] = wf.assets;
  doc["operations"] = wf.operations.map((op) => ({
    [op.name]: op.params,
    ...(op.when ? { when: op.when } : {}),
  }));
  if (wf.output) doc["output"] = wf.output;
  if (wf.extra) for (const [k, v] of Object.entries(wf.extra)) doc[k] = v;
  return stringifyYaml(doc, { indent: 2, lineWidth: 0 });
}

/**
 * Serialize an operation's params object to a single-line, flow-style YAML
 * string — e.g. `{ pages: [ 2, 5 ], title: "0xFF0000" }` — for embedding as
 * `- <op>: <params>`. Delegates quoting to the YAML library, so any value that
 * would otherwise resolve to a non-string (numbers, `0x…`/`0o…`, `.inf`/`.nan`,
 * `true`/`false`/`null`, `${ENV}` refs, …) is quoted correctly, while safe
 * plain scalars (paths, enum keywords, multi-word text) stay unquoted. Returns
 * `{}` for an empty object.
 */
export function serializeFlowParams(params: Record<string, unknown>): string {
  return stringifyYaml(params, { collectionStyle: "flow", lineWidth: 0 }).trim();
}

/**
 * Parse a user-supplied YAML/JSON value fragment (an object `{ … }` or array
 * `[ … ]`) into a JS value. Throws on malformed input — callers validate and
 * re-prompt. Used by the guided parameter builder for `object`-typed params.
 */
export function parseFlowValue(text: string): unknown {
  return parseYaml(text);
}

/** Convenience: serialize to pretty JSON (JSON is a valid OPW form too). */
export function serializeWorkflowJson(wf: Workflow): string {
  const doc: Record<string, unknown> = {
    version: wf.version,
    kind: wf.kind,
    inputs: wf.inputs,
    ...(wf.vars ? { vars: wf.vars } : {}),
    ...(wf.assets ? { assets: wf.assets } : {}),
    operations: wf.operations.map((op) => ({ [op.name]: op.params, ...(op.when ? { when: op.when } : {}) })),
    ...(wf.output ? { output: wf.output } : {}),
    ...(wf.extra ?? {}),
  };
  return JSON.stringify(doc, null, 2);
}
