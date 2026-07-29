// OPW validation — the Validator stage of the compile pipeline.
//
//     Workflow → [Validator] → Optimizer → Execution Plan → Adapter → Output
//
// Produces a flat list of diagnostics (errors + warnings) with stable codes.
// It is a pure function of the workflow object — no filesystem, no adapters —
// so it runs in the editor, the MCP server, and CI identically. Media-existence
// and capability checks live downstream (compile), because they need host/fs
// and adapter context.

import * as nodePath from "node:path";
import type { OpNode, Workflow } from "./model.js";
import { OPW_VERSION } from "./model.js";
import { OPERATIONS, lookupOperation, effectiveParams, type OperationSpec, type ParamSpec } from "./operations.js";
import { checkPageListSyntax, expandPageList, isPageCountRelative, maxNamedPage } from "./pages.js";
import { parseByteSize, templateTokens } from "./template.js";

/** Page-list checks that don't know the real page count expand the list to reason
 *  about it. Past this, refuse to expand — no real document has this many pages,
 *  and the validator must stay cheap enough to run on every edit. */
const MAX_STATIC_PAGE_CHECK = 100_000;

import { resolveVars } from "./vars.js";
import { analyzeWhen, KNOWN_FACTS } from "./when.js";
import { getFormSchema } from "../forms/index.js";

/**
 * True if `p` would escape the workflow directory — an absolute path or a `..`
 * segment. Syntactic (host-independent) check for a fail-fast diagnostic; the
 * executor independently enforces the same rule at read/write time via
 * `confinePath`, so this is defense-in-depth + better UX, not the only guard.
 */
function pathEscapes(p: string): boolean {
  return (
    nodePath.isAbsolute(p) ||
    // Windows drive-absolute (C:\x), drive-RELATIVE (C:x — resolves against the
    // drive's cwd, so still an escape), UNC (\\host), or POSIX root (/x) — flagged
    // regardless of host OS so the diagnostic matches the runtime guard.
    /^([a-zA-Z]:|\\\\|\/)/.test(p) ||
    p.split(/[\\/]/).includes("..")
  );
}

/**
 * Directories a workflow must never write into even though they sit INSIDE the
 * workflow directory, so containment alone does not protect them.
 *
 * Confinement is about the boundary; this is about what lives within it. A
 * workflow is frequently rendered at the root of a repository, which puts
 * `.git/` on the near side of the fence — and a file written there is executed
 * by tools the user runs next, without ever leaving the project:
 *
 *   .git/hooks/pre-commit     runs on the next commit (directly, on Windows)
 *   .git/config               core.fsmonitor / core.pager / core.sshCommand
 *                             are spawned by the next `git status`
 *   .vscode/tasks.json        a task with "runOn": "folderOpen"
 *   .lynx-pdf-studio/mcp.cjs  the MCP server this extension itself launches
 *
 * So `extract_text: { to: ".git/hooks/pre-commit" }` — a perfectly ordinary
 * relative path — was code execution with no traversal at all. Matched on ANY
 * segment, not just the first: a nested repository's `.git` is worth the same
 * protection as the top-level one.
 */
export const PROTECTED_DIRS = [".git", ".hg", ".svn", ".vscode", ".github", ".lynx-pdf-studio"];

/** The protected directory `p` reaches into, if any. */
export function protectedDirIn(p: string): string | undefined {
  return p.split(/[\\/]/).find((seg) => PROTECTED_DIRS.includes(seg.toLowerCase()));
}

/**
 * Params that name a filesystem path, by name rather than by op. Checking these
 * generically is what makes the fail-fast diagnostic match the runtime guard for
 * EVERY operation: the previous per-op list covered four ops, so the ~15 others
 * with a `to` (extract_text, extract_markdown, split_invoices, pdf_to_docx, …)
 * reached `confinePath` and failed mid-render instead of before it.
 *
 * Over-inclusive on purpose. `from` is also an asset name (insert_pages) and a
 * format enum (office_to_pdf), and `file`/`cert` are always paths — but none of
 * those legitimate values can be absolute or contain `..`, so a false positive
 * would require a value that is already broken.
 */
const PATH_PARAMS = new Set([
  "to",
  "from",
  "against",
  "cert",
  "debug_to",
  "fields_file",
  "file",
  "font_file",
  "people",
  "records",
]);

export type Severity = "error" | "warning";

export interface Diagnostic {
  severity: Severity;
  /** Stable machine-readable code, e.g. "unknown_operation". */
  code: string;
  message: string;
  /** Index into `workflow.operations` when the diagnostic is op-scoped. */
  opIndex?: number;
  /** The op name, when applicable. */
  op?: string;
}

const KNOWN_KINDS = new Set(["pdf"]);

/** Ops that CREATE a PDF from a non-PDF source → they must be the first
 *  operation, and expect an input of the matching type (or a param). */
// Derived from the registry (`inputExtensions`) so the vocabulary lives in exactly one
// place — the validator, the executor's mixed-input dispatch and the docs all agree.
const CREATOR_INPUT_EXT: Record<string, string[]> = Object.fromEntries(
  Object.values(OPERATIONS)
    .filter((s) => s.inputExtensions?.length)
    .map((s) => [s.name, s.inputExtensions!]),
);
const CREATOR_OPS = new Set([...Object.keys(CREATOR_INPUT_EXT), "url_to_pdf"]);

/** Check every operation's `when:` guard: it must parse, and each identifier must
 *  be a known document fact or a declared variable (a runtime-only override var is
 *  unknown here, so an unknown identifier is a warning, not an error). */
function validateWhenGuards(wf: Workflow): Diagnostic[] {
  const out: Diagnostic[] = [];
  const known = new Set<string>([...KNOWN_FACTS, ...Object.keys(wf.vars ?? {})]);
  (wf.operations ?? []).forEach((op, i) => {
    if (!op.when) return;
    const a = analyzeWhen(op.when);
    if (a.error) {
      out.push({ severity: "error", code: "when_parse", message: `when: ${a.error}`, opIndex: i, op: op.name });
      return;
    }
    for (const id of a.identifiers) {
      if (!known.has(id)) {
        out.push({
          severity: "warning",
          code: "when_unknown",
          message: `when: references "${id}", not a known fact (${KNOWN_FACTS.join(", ")}) or declared var`,
          opIndex: i,
          op: op.name,
        });
      }
    }
  });
  return out;
}

/** Check the `vars:` block: a mapping of identifier names to scalar values. */
function validateVarsBlock(wf: Workflow): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (wf.vars === undefined) return out;
  if (typeof wf.vars !== "object" || Array.isArray(wf.vars)) {
    out.push({ severity: "error", code: "vars_shape", message: "`vars` must be a mapping of names to scalar values" });
    return out;
  }
  for (const [k, v] of Object.entries(wf.vars)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      out.push({
        severity: "warning",
        code: "vars_name",
        message: `variable name "${k}" is not a valid identifier — it can't be referenced with \${…}`,
      });
    }
    if (!(typeof v === "string" || typeof v === "number" || typeof v === "boolean")) {
      out.push({
        severity: "error",
        code: "vars_scalar",
        message: `variable "${k}" must be a string, number, or boolean (got ${Array.isArray(v) ? "array" : typeof v})`,
      });
    }
  }
  return out;
}

/**
 * Validate a workflow's structure and per-operation parameters. Returns `[]`
 * when the workflow is well-formed. Ordering: top-level issues first, then
 * operations in order.
 */
export function validateWorkflow(wf: Workflow): Diagnostic[] {
  const out: Diagnostic[] = [];

  // The `vars:` block is checked on the AUTHORED workflow; then we resolve
  // `${var}` so every downstream check sees concrete values (a numeric var used
  // in a numeric param must type-check as a number, not the string "${dpi}").
  out.push(...validateVarsBlock(wf));
  const resolved = resolveVars(wf);
  if (wf.vars && resolved.undeclared.length) {
    for (const name of resolved.undeclared) {
      out.push({
        severity: "warning",
        code: "undeclared_var",
        message: `"\${${name}}" is referenced but not declared in vars — left as literal text`,
      });
    }
  }
  wf = resolved.workflow;
  out.push(...validateWhenGuards(wf));

  if (wf.version !== OPW_VERSION) {
    out.push({
      severity: wf.version > OPW_VERSION ? "error" : "warning",
      code: "version_mismatch",
      message: `workflow version ${wf.version}; this build understands version ${OPW_VERSION}`,
    });
  }

  if (!KNOWN_KINDS.has(wf.kind)) {
    out.push({
      severity: "error",
      code: "unknown_kind",
      message: `unknown document kind "${wf.kind}" — only "pdf" is wired today`,
    });
  }

  // `url_to_pdf` sources from a `url` param, so an inputs-less workflow is valid
  // when it's the first operation (it creates the working document).
  const first = wf.operations?.[0];
  const sourcelessFirst = Boolean(first) && lookupOperation(first!.name)?.name === "url_to_pdf";
  if (!sourcelessFirst && (!Array.isArray(wf.inputs) || wf.inputs.length === 0)) {
    out.push({
      severity: "error",
      code: "no_inputs",
      message: "workflow has no inputs; at least one input document is required",
    });
  }

  // A workflow needs a declared destination — `output.file` (one document) OR
  // `output.folder` (many emitted files) — UNLESS an operation emits its own
  // file(s) to a directory/path param (e.g. split_invoices → `to`), in which case
  // it already produces output and a single output.file would be a redundant
  // passthrough.
  const emitsFiles = Array.isArray(wf.operations) && wf.operations.some((o) => lookupOperation(o.name)?.emitsFiles);
  const hasDest = Boolean(wf.output && (wf.output.file || wf.output.folder));
  if (!hasDest && !emitsFiles) {
    out.push({
      severity: "error",
      code: "no_output",
      message: "workflow has no output.file or output.folder",
    });
  }

  // Batch mode: any input with a glob metacharacter (`*`/`?`) runs the workflow once
  // per matched file. Its output must be per-input — `output.folder` OR a templated
  // `output.file` ({stem}/{name}/{ext}/{i}) — else every run overwrites the same path.
  // An op that consumes every input (extract_form) is exempt: a glob feeds ONE run, so
  // there's nothing to make per-input — it already folds many files into one result.
  const foldsInputs =
    Array.isArray(wf.operations) && wf.operations.some((o) => lookupOperation(o.name)?.consumesAllInputs);
  const isBatch =
    !foldsInputs && Array.isArray(wf.inputs) && wf.inputs.some((i) => typeof i === "string" && /[*?]/.test(i));
  const templatedOutput = typeof wf.output?.file === "string" && /\{(stem|name|ext|i)\}/.test(wf.output.file);
  if (isBatch && !wf.output?.folder && !templatedOutput) {
    out.push({
      severity: "error",
      code: "batch_output",
      message: "batch (glob inputs) needs a per-input destination: set output.folder, or template output.file, e.g. output/{stem}.pdf",
    });
  }
  if (isBatch && Array.isArray(wf.operations) && wf.operations.some((o) => lookupOperation(o.name)?.name === "merge")) {
    out.push({
      severity: "warning",
      code: "merge_in_batch",
      message: '"merge" is ignored in batch mode — each matched input runs independently',
    });
  }

  // A folding op (merge/extract_form) reads the workflow's INPUTS, not the working
  // document — so a creator placed before it only composes if its output can be
  // republished per input. `perInputCreator` ops (office_to_pdf, markdown_to_pdf…) are
  // converted once per file first and compose fine. A creator that reads every input at
  // once (images_to_pdf) or none at all (url_to_pdf) cannot be — the folding op would be
  // handed raw, non-PDF bytes and die at render time on a confusing parse error.
  if (foldsInputs && Array.isArray(wf.operations)) {
    const foldAt = wf.operations.findIndex((o) => lookupOperation(o.name)?.consumesAllInputs);
    for (const op of wf.operations.slice(0, Math.max(0, foldAt))) {
      const spec = lookupOperation(op.name);
      if (!spec || !CREATOR_OPS.has(spec.name) || spec.perInputCreator) continue;
      const folder = lookupOperation(wf.operations[foldAt]!.name)!.name;
      out.push({
        severity: "error",
        code: "creator_before_fold",
        message:
          `"${folder}" re-reads the workflow inputs, so "${spec.name}" (which reads every input at once) ` +
          `would be discarded and "${folder}" handed non-PDF bytes — run "${spec.name}" in its own workflow ` +
          `first, then "${folder}" over its output`,
      });
      break;
    }
  }

  // Path safety: input/output/asset paths must stay inside the workflow dir.
  const flagPath = (p: unknown, where: string): void => {
    if (typeof p !== "string" || !p) return;
    if (pathEscapes(p)) {
      out.push({
        severity: "error",
        code: "path_escape",
        message: `${where} "${p}" escapes the workflow directory — use a relative path (no "..", no absolute paths)`,
      });
      return;
    }
    const dir = protectedDirIn(p);
    if (dir) {
      out.push({
        severity: "error",
        code: "path_protected_dir",
        message: `${where} "${p}" writes into "${dir}", which holds files your tools execute — choose a path outside it`,
      });
    }
  };
  if (wf.output?.file) flagPath(wf.output.file, "output.file");
  if (wf.output?.folder) flagPath(wf.output.folder, "output.folder");
  if (Array.isArray(wf.inputs)) for (const i of wf.inputs) flagPath(i, "input");
  if (wf.assets) for (const [name, p] of Object.entries(wf.assets)) flagPath(p, `asset "${name}"`);

  if (!Array.isArray(wf.operations) || wf.operations.length === 0) {
    out.push({
      severity: "warning",
      code: "no_operations",
      message: "workflow has no operations; output would equal the (merged) input",
    });
  }

  // merge sanity: a merge over a single input is a no-op; more than one input
  // with no merge means every op after the first input's pages is ambiguous.
  // `images_to_pdf` is exempt — like merge, it consumes ALL inputs (every image
  // becomes a page), so multiple inputs are expected and unambiguous.
  // Resolve through the registry: `interleave` is merge under another name, and
  // reporting "no merge op" for it would be actively wrong.
  const opNames = wf.operations.map((o) => lookupOperation(o.name)?.name ?? o.name);
  const combinesAllInputs = opNames.includes("merge") || opNames[0] === "images_to_pdf";
  if (wf.inputs.length > 1 && !combinesAllInputs && !isBatch) {
    out.push({
      severity: "warning",
      code: "multiple_inputs_no_merge",
      message: `${wf.inputs.length} inputs but no "merge" op; only the first input is used as the working document`,
    });
  }

  // Creator ops (markdown/html/eml/office/images/url → pdf) build the working
  // document from a NON-PDF source, so they must be the first operation and
  // expect an input of the matching type. Running one mid-pipeline reads the
  // working PDF as if it were markdown/HTML → garbage output.
  wf.operations.forEach((op, i) => {
    if (!CREATOR_OPS.has(lookupOperation(op.name)?.name ?? op.name)) return;
    if (i > 0) {
      out.push({
        severity: "error",
        code: "creator_not_first",
        message: `"${op.name}" converts a non-PDF source into a PDF, so it must be the FIRST operation — it can't run on the PDF produced by earlier ops`,
        opIndex: i,
        op: op.name,
      });
      return;
    }
    const first = Array.isArray(wf.inputs) ? wf.inputs[0] : undefined;
    if (op.name === "url_to_pdf") {
      if (Array.isArray(wf.inputs) && wf.inputs.length > 0) {
        out.push({
          severity: "warning",
          code: "creator_input_mismatch",
          message: `"url_to_pdf" reads a "url" param, not an input file — set inputs: [] and pass { url: ... }`,
          opIndex: i,
          op: op.name,
        });
      }
      return;
    }
    // Canonicalize: the map is keyed by canonical name, but the author may have written
    // an alias (`ebook_to_pdf` for `epub_to_pdf`) — which would silently skip the check.
    const exts = CREATOR_INPUT_EXT[lookupOperation(op.name)?.name ?? op.name];
    if (exts && typeof first === "string" && !exts.some((e) => first.toLowerCase().endsWith(e))) {
      out.push({
        severity: "warning",
        code: "creator_input_mismatch",
        message: `"${op.name}" expects a ${exts.join(" / ")} input, but the first input is "${first}"`,
        opIndex: i,
        op: op.name,
      });
    }
  });

  wf.operations.forEach((op, i) =>
    validateOp(op, i, out, {
      inputs: wf.inputs ?? [],
      // Canonical names: an alias must satisfy an "op X ran before me" check.
      opsBefore: wf.operations.slice(0, i).map((o) => lookupOperation(o.name)?.name ?? o.name),
      allOps: wf.operations,
    }),
  );
  return out;
}

/** What an op needs to know about the workflow around it — some rules are only decidable in
 *  context (create_form needs SOMETHING to have rendered a page before it). */
interface OpContext {
  inputs: string[];
  /** Names of the operations that run before this one. */
  opsBefore: string[];
  /** Every operation in the workflow, canonical-named — for rules about what happens
   *  ANYWHERE in the program rather than strictly before this op. */
  allOps?: OpNode[];
}

function validateOp(op: OpNode, index: number, out: Diagnostic[], ctx?: OpContext): void {
  if (op.name === "(invalid)") {
    out.push({
      severity: "error",
      code: "malformed_operation",
      message: `operation #${index + 1} is not a single-key object`,
      opIndex: index,
    });
    return;
  }
  const spec = lookupOperation(op.name);
  if (!spec) {
    out.push({
      severity: "error",
      code: "unknown_operation",
      message: `unknown operation "${op.name}"`,
      opIndex: index,
      op: op.name,
    });
    return;
  }
  // Validate what will actually RUN: an alias keyword can imply params
  // (`interleave` → merge's `interleave: true`), and compile folds those in the
  // same way. The node keeps the authored name so diagnostics quote the spelling
  // the user wrote.
  const eff: OpNode = { ...op, params: effectiveParams(spec, op.name, op.params) };
  validateParams(eff, index, spec, out);
  validatePageBounds(eff, index, out);
  validateOpSemantics(eff, index, spec, out, ctx);
}

/**
 * Enforce the 1-based page invariant for every op's page params. A `page` / `at`
 * of 0 or a negative, or a `pages` list with such a value, would be used as a
 * page index by an adapter — where a 0 hits the first page and a negative wraps
 * to the last (PyMuPDF), silently editing the wrong page. Catch it up front for
 * all ops (not just delete/extract/reorder).
 */
function validatePageBounds(op: OpNode, index: number, out: Diagnostic[]): void {
  const bad = (name: string, got: unknown) =>
    out.push({
      severity: "error",
      code: "bad_page_number",
      message: `operation "${op.name}" ${name} must be a 1-based page ≥ 1 (got ${JSON.stringify(got)})`,
      opIndex: index,
      op: op.name,
    });
  for (const name of ["page", "at"]) {
    const v = op.params[name];
    if (typeof v === "number" && v < 1) bad(`"${name}"`, v);
  }
  const pages = op.params["pages"];
  if (Array.isArray(pages)) {
    const offender = (pages as unknown[]).find((n) => typeof n === "number" && n < 1);
    if (offender !== undefined) bad(`"pages" entry`, offender);
  }
}

function validateParams(op: OpNode, index: number, spec: OperationSpec, out: Diagnostic[]): void {
  const byName = new Map(spec.params.map((p) => [p.name, p]));
  for (const p of spec.params) {
    if (p.required && !(p.name in op.params)) {
      out.push({
        severity: "error",
        code: "missing_param",
        message: `operation "${op.name}" requires param "${p.name}"`,
        opIndex: index,
        op: op.name,
      });
    }
  }
  for (const [key, value] of Object.entries(op.params)) {
    const p = byName.get(key);
    if (!p) {
      out.push({
        severity: "warning",
        code: "unknown_param",
        message: `operation "${op.name}" has unknown param "${key}"`,
        opIndex: index,
        op: op.name,
      });
      continue;
    }
    checkType(op, index, p, value, out);
  }
}

function checkType(op: OpNode, index: number, p: ParamSpec, value: unknown, out: Diagnostic[]): void {
  const bad = (msg: string): void => {
    out.push({
      severity: "error",
      code: "bad_param_type",
      message: `operation "${op.name}" param "${p.name}" ${msg}`,
      opIndex: index,
      op: op.name,
    });
  };

  switch (p.type) {
    case "string":
      if (typeof value !== "string") return bad("must be a string");
      if (p.enum && !p.enum.includes(value)) return bad(`must be one of ${p.enum.join(", ")}`);
      break;
    case "number":
      if (typeof value !== "number" || Number.isNaN(value)) return bad("must be a number");
      if (p.min !== undefined && value < p.min) return bad(`must be >= ${p.min}`);
      if (p.max !== undefined && value > p.max) return bad(`must be <= ${p.max}`);
      break;
    case "boolean":
      if (typeof value !== "boolean") return bad("must be a boolean");
      break;
    case "number[]":
      if (!Array.isArray(value) || !value.every((v) => typeof v === "number")) {
        return bad("must be an array of numbers");
      }
      break;
    case "pages": {
      const problem = checkPageListSyntax(value);
      if (problem) return bad(problem);
      break;
    }
    case "string[]":
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
        return bad("must be an array of strings");
      }
      break;
    case "object":
      if (!value || typeof value !== "object") return bad("must be an object");
      break;
  }
}

/** Op-specific semantic checks the generic param checker can't express. */
function validateOpSemantics(op: OpNode, index: number, spec: OperationSpec, out: Diagnostic[], ctx?: OpContext): void {
  const err = (code: string, message: string) =>
    out.push({ severity: "error", code, message, opIndex: index, op: op.name });
  const warn = (code: string, message: string) =>
    out.push({ severity: "warning", code, message, opIndex: index, op: op.name });

  // Every path-typed param on every op, checked the same way — see PATH_PARAMS.
  // The executor enforces this again at read/write time via confinePath; this is
  // the fail-fast half, so the error arrives in the editor rather than mid-render.
  for (const [key, value] of Object.entries(op.params)) {
    if (!PATH_PARAMS.has(key) || typeof value !== "string" || !value) continue;
    if (pathEscapes(value)) {
      err(
        "path_escape",
        `${spec.name}.${key} "${value}" escapes the workflow directory — use a relative path (no "..", no absolute paths)`,
      );
      continue;
    }
    const dir = protectedDirIn(value);
    if (dir) {
      err(
        "path_protected_dir",
        `${spec.name}.${key} "${value}" writes into "${dir}", which holds files your tools execute — choose a path outside it`,
      );
    }
  }

  if (spec.name === "rotate_pages") {
    const deg = op.params["degrees"];
    if (typeof deg === "number" && deg % 90 !== 0) {
      err("rotation_not_multiple_of_90", `rotate_pages degrees (${deg}) must be a multiple of 90`);
    }
  }

  if (spec.name === "reorder_pages") {
    const order = op.params["order"];
    if (Array.isArray(order) && checkPageListSyntax(order) === null) {
      // Expand against the largest page the list names: an order that covers its
      // own document is a permutation of 1..N for exactly that N. Bail out on
      // absurd page numbers rather than materializing them — the validator runs
      // on every keystroke, and the adapter re-checks against the real document.
      const named = maxNamedPage(order);
      const expanded = named > MAX_STATIC_PAGE_CHECK ? [] : expandPageList(order, Math.max(named, 1));
      const seen = new Set<number>();
      let duplicate = 0;
      for (const n of expanded) {
        if (seen.has(n)) {
          duplicate = n;
          break;
        }
        seen.add(n);
      }
      if (duplicate) {
        err("duplicate_page", `reorder_pages order repeats page ${duplicate}`);
      } else if (expanded.length > 0 && !isPageCountRelative(order) && seen.size < named) {
        // The order names page `named` but skips something below it, so it cannot
        // be a complete ordering of ANY document — pages would be destroyed.
        const missing: number[] = [];
        for (let p = 1; p <= named && missing.length < 6; p++) if (!seen.has(p)) missing.push(p);
        const shown = missing.slice(0, 5).join(", ") + (missing.length > 5 ? ", …" : "");
        err(
          "incomplete_order",
          `reorder_pages order names page ${named} but omits ${shown} — it must list EVERY page exactly once, ` +
            `and a partial order silently drops the pages it leaves out. ` +
            `To move a few pages use move_pages, to exchange two use swap_pages, to keep a subset use extract_pages.`,
        );
      }
    }
  }

  if (spec.name === "move_pages") {
    const hasAfter = "after" in op.params;
    const hasBefore = "before" in op.params;
    if (hasAfter && hasBefore) {
      err("move_target_ambiguous", "move_pages takes either `after` or `before`, not both");
    } else if (!hasAfter && !hasBefore) {
      err("move_target_missing", "move_pages requires `after` or `before` — the position to move the pages to");
    } else {
      // The destination is numbered in the ORIGINAL document, so it cannot be one
      // of the pages being moved (that position is about to vanish).
      const anchor = Number(hasAfter ? op.params["after"] : op.params["before"]);
      const moved = op.params["pages"];
      const bound = Math.max(maxNamedPage(moved), Number.isInteger(anchor) ? anchor : 0, 1);
      if (Number.isInteger(anchor) && Array.isArray(moved) && checkPageListSyntax(moved) === null && bound <= MAX_STATIC_PAGE_CHECK) {
        const pages = expandPageList(moved, bound);
        if (pages.includes(anchor)) {
          err(
            "move_anchor_in_selection",
            `move_pages ${hasAfter ? "after" : "before"} ${anchor} is itself one of the pages being moved — ` +
              `pick a page that stays put`,
          );
        }
      }
    }
  }

  if (spec.name === "swap_pages") {
    const a = op.params["a"];
    const b = op.params["b"];
    if (typeof a === "number" && typeof b === "number" && a === b) {
      err("swap_same_page", `swap_pages a and b are both page ${a} — swapping a page with itself does nothing`);
    }
  }

  if (spec.name === "watermark") {
    if (!("text" in op.params) && !("image" in op.params)) {
      err("watermark_empty", "watermark requires either `text` or `image`");
    }
  }

  if (spec.name === "title_page") {
    const hasContent = ["title", "subtitle", "author", "image"].some((k) => {
      const v = op.params[k];
      return typeof v === "string" && v.trim().length > 0;
    });
    if (!hasContent) {
      err("title_page_empty", "title_page needs at least one of `title`, `subtitle`, `author` or `image` — for an empty page use insert_blank");
    }
    // The motivating bug in one diagnostic: a cover fixes the THUMBNAIL, metadata fixes the
    // SHELF TITLE. People discover the second half only after sideloading and seeing the
    // filename. Teach it here rather than silently writing /Title on their behalf, which
    // would make two ops fight over the same field.
    const titled = typeof op.params["title"] === "string" && op.params["title"].trim().length > 0;
    const setsMetadata = (ctx?.allOps ?? []).some(
      (o) => lookupOperation(o.name)?.name === "set_metadata" && typeof o.params["title"] === "string",
    );
    if (titled && !setsMetadata) {
      out.push({
        severity: "warning",
        code: "title_page_no_metadata",
        message:
          "the cover page sets a title but the document's Title metadata is not — e-readers and library apps " +
          'take the shelf entry from the metadata, not from page 1. Add: set_metadata: { title: "…", author: "…" }',
        opIndex: index,
        op: op.name,
      });
    }
  }

  if (spec.name === "compress" && "max_size" in op.params && parseByteSize(op.params["max_size"]) === null) {
    err(
      "compress_bad_max_size",
      `compress max_size "${String(op.params["max_size"])}" is not a size — use 4.5MB, 900KB, 4.5MiB, or a number of bytes`,
    );
  }

  if (spec.name === "split") {
    const modes = ["ranges", "every", "max_size"].filter((k) => k in op.params);
    if (modes.length === 0) {
      err("split_underspecified", "split requires `ranges`, `every`, or `max_size`");
    } else if (modes.length > 1) {
      err(
        "split_mode_ambiguous",
        `split takes ONE of \`ranges\`, \`every\` or \`max_size\` — got ${modes.map((m) => `\`${m}\``).join(" and ")}`,
      );
    }
    const every = op.params["every"];
    if (typeof every === "number" && !Number.isInteger(every)) {
      err("split_every_not_integer", `split "every" must be a whole number of pages (got ${every})`);
    }
    if ("max_size" in op.params && parseByteSize(op.params["max_size"]) === null) {
      err(
        "split_bad_max_size",
        `split max_size "${String(op.params["max_size"])}" is not a size — use 5MB, 4.8MB, 500KB, 5MiB, or a number of bytes`,
      );
    }
    const name = op.params["name"];
    if (typeof name === "string") {
      if (/[/\\]/.test(name) || name.includes("..")) {
        err(
          "split_name_path",
          `split name "${name}" must be a filename, not a path — the destination comes from output.folder / output.file`,
        );
      }
      if (/\.pdf$/i.test(name)) {
        warn("split_name_has_ext", `split name "${name}" should omit the .pdf — it is added for you`);
      }
      const known = new Set(["stem", "name", "ext", "i", "start", "end", "n"]);
      const unknown = templateTokens(name).filter((t) => !known.has(t));
      if (unknown.length) {
        warn(
          "split_name_unknown_token",
          `split name uses unknown token${unknown.length > 1 ? "s" : ""} ${unknown.map((t) => `{${t}}`).join(", ")} — ` +
            `available: {stem} {name} {ext} {i} {start} {end} {n} (pad with {i:03})`,
        );
      }
      if (!templateTokens(name).some((t) => t === "i" || t === "start" || t === "end")) {
        warn(
          "split_name_not_unique",
          `split name "${name}" has no per-part token, so every part would want the same filename — ` +
            `add {i} (parts are de-duplicated with a numeric suffix as a fallback)`,
        );
      }
    }
  }

  if (spec.name === "fill_form") {
    const has = (k: string) => k in op.params && op.params[k] != null;
    if (!has("form") && !has("fields") && !has("values")) {
      err("fill_form_underspecified", "fill_form requires `form` (a supported form id), or raw `fields`/`values`");
    }
    const form = op.params["form"];
    if (typeof form === "string" && !getFormSchema(form)) {
      err("fill_form_unknown_form", `unknown form "${form}" — see the form_list MCP tool or the PDF Fill catalog`);
    }
  }

  if (spec.name === "replace_text") {
    // `required: true` catches a MISSING find; an empty one would silently match nothing
    // page after page — an error the user should meet in the editor, not in the render note.
    const find = op.params["find"];
    if (typeof find === "string" && find.length === 0) {
      err("replace_text_empty_find", "replace_text `find` must not be empty");
    }
  }

  if (spec.name === "create_form" && ctx) {
    // create_form works on the RENDERED page, so something must have rendered it. Forgetting
    // the conversion op is the most likely first-use mistake, and the adapter can only catch
    // it at render time — catch it here instead, while they're still editing.
    const firstPdf = (ctx.inputs ?? []).some((i) => typeof i === "string" && /\.pdf$/i.test(i));
    const converterBefore = (ctx.opsBefore ?? []).some((n) => CREATOR_OPS.has(lookupOperation(n)?.name ?? n));
    if (!firstPdf && !converterBefore) {
      err(
        "create_form_no_source",
        `create_form works on a rendered PDF page — put a conversion op (office_to_pdf / ` +
          `markdown_to_pdf / html_to_pdf) before it, or give the workflow a .pdf input`,
      );
    }
  }

  if (spec.name === "create_form") {
    // Reject at validate time anything the backend can't honour, rather than letting it fail
    // mid-render (radio → a bare "bad xref") or, worse, silently do something else.
    const TYPES = ["text", "date", "number", "money", "currency", "phone", "ssn", "zip", "checkbox", "dropdown", "combobox", "listbox", "signature"];
    const FONTS = ["Helv", "TiRo", "Cour", "ZaDb"];
    const cfg = op.params["fields"];
    if (cfg && typeof cfg === "object") {
      for (const [key, raw] of Object.entries(cfg as Record<string, unknown>)) {
        if (!/^[A-Za-z0-9_]{1,24}$/.test(key)) {
          err(
            "create_form_bad_key",
            `create_form field "${key}": a tag key must be 1-24 chars of A-Z a-z 0-9 _ — no dots ` +
              `(AcroForm reads "." as a field-name separator), and a long key gets clipped in a narrow column`,
          );
          continue;
        }
        const f = (typeof raw === "string" ? { type: raw } : (raw ?? {})) as Record<string, unknown>;
        const t = String(f["type"] ?? "text");
        if (t === "radio") {
          err("create_form_radio", `create_form "${key}": radio groups aren't supported yet — use a dropdown, or one checkbox per option`);
        } else if (!TYPES.includes(t)) {
          err("create_form_bad_type", `create_form "${key}": unknown type "${t}" — use one of ${TYPES.join(", ")}`);
        }
        if ((t === "dropdown" || t === "combobox" || t === "listbox") && !Array.isArray(f["choices"])) {
          err("create_form_no_choices", `create_form "${key}": type "${t}" needs a \`choices\` list`);
        }
        if ("export_value" in f) {
          err(
            "create_form_export_value",
            `create_form "${key}": export_value isn't supported — a created checkbox is always on-state "Yes"`,
          );
        }
      }
    }
    const style = op.params["style"];
    if (style && typeof style === "object") {
      const font = (style as Record<string, unknown>)["font"];
      if (typeof font === "string" && !FONTS.includes(font)) {
        err(
          "create_form_bad_font",
          `create_form style.font "${font}" isn't available in a PDF form — use one of ${FONTS.join(", ")} ` +
            `(anything else is silently replaced with Helvetica)`,
        );
      }
    }
    const tag = op.params["tag"];
    if (typeof tag === "string" && !tag.includes("key")) {
      err("create_form_bad_tag", `create_form.tag "${tag}" must contain the literal token \`key\`, e.g. "[[key]]"`);
    }
  }

  // auto_redact and highlight share one matcher (literal text / regex / PII preset),
  // so they share its rules — only the diagnostic code names differ.
  if (spec.name === "auto_redact" || spec.name === "highlight") {
    const warn = (code: string, message: string) =>
      out.push({ severity: "warning", code, message, opIndex: index, op: op.name });
    const has = (k: string) => k in op.params && op.params[k] != null;
    if (!has("text") && !has("regex") && !has("patterns")) {
      err(`${spec.name}_no_matcher`, `${spec.name} requires at least one of \`text\`, \`regex\`, or \`patterns\``);
    }
    const patterns = op.params["patterns"];
    if (Array.isArray(patterns)) {
      const unknown = (patterns as unknown[]).filter(
        (p) => typeof p === "string" && !REDACT_PRESETS.includes(p.toLowerCase()),
      );
      if (unknown.length) {
        warn(
          `${spec.name}_unknown_preset`,
          `${spec.name} has unknown pattern preset(s): ${unknown.join(", ")} (known: ${REDACT_PRESETS.join(", ")})`,
        );
      }
    }
  }
}

/** Named PII presets recognized by auto_redact and highlight (mirrors the sidecar's _REDACT_PRESETS). */
const REDACT_PRESETS = ["ssn", "email", "phone", "credit_card", "ein", "ipv4", "iban"];

/** Convenience: does this diagnostic list contain any error? */
export function hasErrors(diags: Diagnostic[]): boolean {
  return diags.some((d) => d.severity === "error");
}
