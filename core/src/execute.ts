// The workflow executor — the whole OPW pipeline, end to end.
//
//     OPW text
//       │  parseWorkflow
//       ▼
//     Workflow ──► Validator ──► Optimizer ──► compileWorkflow ──► ExecutionPlan
//                                                                      │
//                                                    for each step: registry
//                                                    resolves an adapter, which
//                                                    transforms ctx.current
//                                                      │
//                                                      ▼
//                                                   Output PDF (+ artifacts)
//
// Filesystem access is injected (HostFs) so the same executor runs in the
// extension (node fs), in tests (in-memory), and — with a remote fs — in a
// future cloud runner. Core stays free of vscode and, optionally, of node:fs.

import * as nodePath from "node:path";
import { readFile, writeFile, mkdir, rename, rm, readdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { Workflow } from "./opw/model.js";
import { parseWorkflow } from "./opw/io.js";
import { validateWorkflow, hasErrors, protectedDirIn, type Diagnostic } from "./opw/validate.js";
import { optimizeWorkflow, type Rewrite } from "./opw/optimize.js";
import { compileWorkflow, type ExecutionPlan } from "./opw/compile.js";
import { resolveVars, SECRET_PARAMS, type VarValue } from "./opw/vars.js";
import { evaluateWhen, analyzeWhen, RICH_FACTS, type WhenScope } from "./opw/when.js";
import { lookupOperation, creatorForExtension } from "./opw/operations.js";
import { renderTemplate } from "./opw/template.js";
import { PDFDocument, PDFName } from "pdf-lib";
import { AdapterRegistry, type ExecContext, type EmittedArtifact } from "./adapters/adapter.js";
import { PdfLibAdapter } from "./adapters/pdflib/index.js";
import { ValidationError } from "./errors.js";

/** Minimal filesystem the executor needs. Paths are workflow-relative. */
export interface HostFs {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  /** List a directory (relative to baseDir). Required only for batch (glob inputs);
   *  a missing directory should resolve to `[]`. */
  list?(dir: string): Promise<{ name: string; dir: boolean }[]>;
}

export interface RunWorkflowOptions {
  /** Directory the workflow file lives in; input/output/asset paths resolve against it. */
  baseDir: string;
  /** Filesystem implementation (defaults to node fs rooted at baseDir). */
  fs?: HostFs;
  /** Adapter registry (defaults to the bundled pdf-lib adapter only). */
  registry?: AdapterRegistry;
  /** Skip the optimizer pass (useful for exact-plan debugging). */
  noOptimize?: boolean;
  /** Runtime overrides for the workflow's declared `vars` — these win over the
   *  file's defaults, so one workflow renders many jobs. Scalars only; never the
   *  environment. */
  vars?: Record<string, VarValue>;
  /** Per-step log callback. */
  onStep?: (step: { index: number; op: string; note?: string }) => void;
  /** Batch progress: fired once per matched input (0-based `i` of `total`). */
  onBatchItem?: (i: number, total: number, input: string) => void;
}

export interface RunWorkflowResult {
  diagnostics: Diagnostic[];
  rewrites: Rewrite[];
  plan: ExecutionPlan;
  /** First output path written (workflow-relative), or null when nothing was produced.
   *  For a batch this is the first successful output; see {@link outputs}/{@link batch}. */
  output: string | null;
  /** Every output path written (one per input in batch mode; `[output]` otherwise). */
  outputs: string[];
  /** Extra artifacts written (split files, extracted text/images). */
  artifacts: string[];
  notes: string[];
  /** Per-input record when the workflow ran in batch mode (glob inputs); absent otherwise.
   *  `incomplete` marks a resumable partial (a remote op hit its soft deadline) — not a
   *  failure; re-running continues from the persistent cache. */
  batch?: { input: string; output?: string; error?: string; incomplete?: boolean }[];
}

/** The default registry: just the bundled, always-available pdf-lib backend. */
export function defaultRegistry(): AdapterRegistry {
  return new AdapterRegistry([new PdfLibAdapter()]);
}

/**
 * Run a workflow from its parsed form. Throws {@link ValidationError} if the
 * workflow has validation errors (call {@link validateWorkflow} first to show
 * them without throwing).
 */
export async function runWorkflow(wf: Workflow, opts: RunWorkflowOptions): Promise<RunWorkflowResult> {
  const fs = opts.fs ?? nodeFs(opts.baseDir);
  const registry = opts.registry ?? defaultRegistry();
  await registry.refreshAvailability();

  // Resolve `${var}` from the workflow's vars (+ runtime overrides) before anything
  // else, so validate/optimize/compile/execute all see concrete values. Declared
  // vars win; `${ENV}` refs left in password params are handled later by substituteEnv.
  wf = resolveVars(wf, opts.vars).workflow;

  const diagnostics = validateWorkflow(wf);
  if (hasErrors(diagnostics)) {
    throw new ValidationError(
      "workflow has validation errors; fix them before running",
      diagnostics.filter((d) => d.severity === "error").map((d) => d.code),
    );
  }

  const { workflow: optimized, rewrites } = opts.noOptimize
    ? { workflow: wf, rewrites: [] as Rewrite[] }
    : optimizeWorkflow(wf);

  const plan = compileWorkflow(optimized, { registry });

  // Assets are shared across every input — load once.
  const assets: Record<string, Uint8Array> = {};
  if (optimized.assets) {
    for (const [name, rel] of Object.entries(optimized.assets)) {
      try {
        assets[name] = await fs.readFile(rel);
      } catch {
        /* missing asset surfaces later when an op needs it */
      }
    }
  }

  // Does an operation emit its own files (split_invoices/extract_*/…)? In batch,
  // route such outputs into a per-input subfolder to avoid basename collisions.
  const emitsFiles = plan.steps.some((s) => lookupOperation(s.op)?.emitsFiles);

  // Scope for `when:` guards: declared vars + runtime overrides as identifiers
  // (document facts are added per-input inside runOnce). Fact names are reserved and
  // win over a same-named var.
  const varScope: WhenScope = {};
  for (const [k, v] of Object.entries(optimized.vars ?? {})) if (isWhenScalar(v)) varScope[k] = v;
  for (const [k, v] of Object.entries(opts.vars ?? {})) if (isWhenScalar(v)) varScope[k] = v;

  // An op that reads every input together (extract_form → one table over many forms)
  // must NOT be batched: batch runs the plan once per file, which would hand it a
  // single document each time. Expand the globs into one run's inputs instead.
  if (plan.steps.some((s) => lookupOperation(s.op)?.consumesAllInputs) && optimized.inputs.some(isGlob)) {
    const all: string[] = [];
    for (const inp of optimized.inputs) all.push(...(isGlob(inp) ? await expandGlob(fs, inp) : [inp]));
    const files = Array.from(new Set(all)).sort();
    if (files.length === 0) throw new Error(`no files matched: ${optimized.inputs.filter(isGlob).join(", ")}`);
    const r = await runOnce(plan, registry, fs, files, assets,
      { file: optimized.output?.file, folder: optimized.output?.folder }, optimized.kind, varScope, opts.onStep);
    return { diagnostics, rewrites, plan, output: r.output, outputs: r.output ? [r.output] : [], artifacts: r.artifacts, notes: r.notes };
  }

  // ---- Single run (no glob inputs): today's behavior ----
  if (!optimized.inputs.some(isGlob)) {
    const r = await runOnce(plan, registry, fs, optimized.inputs, assets,
      { file: optimized.output?.file, folder: optimized.output?.folder }, optimized.kind, varScope, opts.onStep);
    return { diagnostics, rewrites, plan, output: r.output, outputs: r.output ? [r.output] : [], artifacts: r.artifacts, notes: r.notes };
  }

  // ---- Batch (glob inputs): run once per matched file → per-input output ----
  const matched: string[] = [];
  for (const inp of optimized.inputs) {
    if (isGlob(inp)) matched.push(...(await expandGlob(fs, inp)));
    else matched.push(inp);
  }
  const files = Array.from(new Set(matched)).sort();
  if (files.length === 0) {
    throw new Error(`no files matched: ${optimized.inputs.filter(isGlob).join(", ")}`);
  }

  const outFile = optimized.output?.file;
  const outFolder = optimized.output?.folder;
  const outExt = outFile ? nodePath.extname(outFile) || ".pdf" : ".pdf";
  const outputs: string[] = [];
  const artifacts: string[] = [];
  const notes: string[] = [];
  const batch: NonNullable<RunWorkflowResult["batch"]> = [];

  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    opts.onBatchItem?.(i, files.length, f);
    const stem = nodePath.basename(f).replace(/\.[^.]*$/, "");
    let target: { file?: string; folder?: string };
    if (outFolder) {
      const base = outFolder.replace(/\/+$/, "");
      target = emitsFiles ? { folder: `${base}/${stem}` } : { file: `${base}/${stem}${outExt}` };
    } else {
      // validate.ts guarantees a template token when there's no folder
      target = { file: applyBatchTemplate(outFile ?? `output/{stem}.pdf`, f, i) };
    }
    try {
      const r = await runOnce(plan, registry, fs, [f], assets, target, optimized.kind, varScope, opts.onStep);
      if (r.output) outputs.push(r.output);
      artifacts.push(...r.artifacts);
      notes.push(...r.notes);
      if (r.incomplete) notes.push(`incomplete ${f} — re-run to resume from cache`);
      batch.push({ input: f, output: r.output ?? undefined, ...(r.incomplete ? { incomplete: true } : {}) });
    } catch (e) {
      const msg = (e as Error).message;
      notes.push(`failed ${f}: ${msg}`);
      batch.push({ input: f, error: msg });
    }
  }

  return { diagnostics, rewrites, plan, output: outputs[0] ?? null, outputs, artifacts, notes, batch };
}

/** Scalar guard for a `when:`/vars value. */
function isWhenScalar(v: unknown): v is WhenScope[string] {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/** Compute the `when:` document facts from the input bytes — all cheap and bundled
 *  (no Python). `has_text`/`has_images` are a planned follow-up. */
async function computeFacts(bytes: Uint8Array): Promise<WhenScope> {
  const facts: WhenScope = { size_kb: Math.round((bytes.length / 1024) * 10) / 10 };
  const head = new TextDecoder("latin1").decode(bytes.slice(0, 24));
  const m = /%PDF-(\d+\.\d+)/.exec(head);
  facts["pdf_version"] = m ? Number(m[1]) : 0;
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    facts["pages"] = doc.getPageCount();
    facts["encrypted"] = doc.isEncrypted;
    facts["tagged"] = doc.catalog.get(PDFName.of("StructTreeRoot")) != null;
  } catch {
    facts["pages"] = 0;
    facts["encrypted"] = false;
    facts["tagged"] = false;
  }
  return facts;
}

/** Run the compiled plan once over `inputPaths`, writing to `target`. */
async function runOnce(
  plan: ExecutionPlan,
  registry: AdapterRegistry,
  fs: HostFs,
  inputPaths: string[],
  assets: Record<string, Uint8Array>,
  target: { file?: string; folder?: string },
  kind: Workflow["kind"],
  varScope: WhenScope,
  onStep?: RunWorkflowOptions["onStep"],
): Promise<{ output: string | null; artifacts: string[]; notes: string[]; incomplete: boolean }> {
  const inputs: Uint8Array[] = [];
  for (const rel of inputPaths) inputs.push(await fs.readFile(rel));

  const ctx: ExecContext = { kind, inputs, inputPaths, assets, current: inputs[0] ?? null, artifacts: [] };
  const notes: string[] = [];
  let incomplete = false;

  // ---- Per-input creators, ahead of a folding op ----------------------------------
  // `decks/*.pptx` → office_to_pdf → merge folds every deck into ONE run, but a creator
  // converts only the working document (inputs[0]) and a folding op like merge re-reads
  // the RAW inputs — so merge would be handed .pptx bytes. Convert every input first and
  // republish them as the run's inputs; merge then sees PDFs. Runs BEFORE the `when:`
  // snapshot so document facts are read from the converted PDF, not the source file.
  const done = new Set<number>();
  const foldIndex = plan.steps.find((s) => lookupOperation(s.op)?.consumesAllInputs)?.index;
  if (foldIndex !== undefined && ctx.inputs.length > 1) {
    for (const step of plan.steps) {
      if (step.index >= foldIndex || !step.adapter) continue;
      if (!lookupOperation(step.op)?.perInputCreator) continue;
      const adapter = registry.all().find((a) => a.id === step.adapter)!;
      const params = substituteEnv(step.params);
      const converted: Uint8Array[] = [];
      for (let i = 0; i < ctx.inputs.length; i++) {
        const one: ExecContext = {
          ...ctx,
          inputs: [ctx.inputs[i]!],
          inputPaths: [ctx.inputPaths[i]!],
          current: ctx.inputs[i]!,
          artifacts: [],
        };
        const r = await adapter.apply(one, { ...step, params });
        if (r.artifacts) ctx.artifacts.push(...r.artifacts);
        converted.push(r.current ?? ctx.inputs[i]!);
      }
      ctx.inputs = converted;
      ctx.current = converted[0] ?? null;
      done.add(step.index);
      const note = `${step.op}: converted ${converted.length} input(s)`;
      notes.push(note);
      onStep?.({ index: step.index, op: step.op, note });
    }

    // ---- Mixed input types: convert whatever is still not a PDF --------------------
    // "Merge these": a few PDFs, a Word file, some photos. Every non-PDF is routed to the
    // operation that claims its extension (registry `inputExtensions`) and converted in
    // place, so merge receives a uniform set of PDFs. Only for `merge`, and only for
    // inputs that AREN'T already PDFs — so this can never change a working workflow: a
    // non-PDF here is a guaranteed "No PDF header found" failure today.
    const foldStep = plan.steps.find((s) => s.index === foldIndex)!;
    if (foldStep.op === "merge" && foldStep.params["convert"] !== false) {
      const converted: Uint8Array[] = [...ctx.inputs];
      const usedOps = new Map<string, number>();
      for (let i = 0; i < converted.length; i++) {
        if (isPdfBytes(converted[i]!)) continue;
        const rel = ctx.inputPaths[i] ?? `input ${i + 1}`;
        const ext = nodePath.extname(rel).toLowerCase();
        const creator = creatorForExtension(ext);
        if (!creator) {
          throw new Error(
            `merge: "${rel}" is not a PDF and no operation converts "${ext || "(no extension)"}" — ` +
              `remove it, convert it first, or set merge: { convert: false } to require PDFs`,
          );
        }
        const adapter = registry.resolve(kind, creator.capability);
        if (!adapter) {
          throw new Error(
            `merge: "${rel}" needs "${creator.name}" to become a PDF, but no available backend provides ` +
              `capability "${creator.capability}" — see the Dependencies view`,
          );
        }
        // office_to_pdf keys its LibreOffice filter off `from`; take it from the extension.
        const params = creator.name === "office_to_pdf" ? { from: ext.replace(/^\./, "") } : {};
        const one: ExecContext = {
          ...ctx,
          inputs: [converted[i]!],
          inputPaths: [rel],
          current: converted[i]!,
          artifacts: [],
        };
        const r = await adapter.apply(one, {
          index: foldStep.index, op: creator.name, capability: creator.capability, params, adapter: adapter.id,
        });
        if (r.artifacts) ctx.artifacts.push(...r.artifacts);
        converted[i] = r.current ?? converted[i]!;
        usedOps.set(creator.name, (usedOps.get(creator.name) ?? 0) + 1);
      }
      if (usedOps.size) {
        ctx.inputs = converted;
        ctx.current = converted[0] ?? null;
        const detail = [...usedOps].map(([op, n]) => `${n}×${op}`).join(", ");
        const note = `merge: converted ${[...usedOps.values()].reduce((a, b) => a + b, 0)} non-PDF input(s) (${detail})`;
        notes.push(note);
        onStep?.({ index: foldStep.index, op: "merge", note });
      }
    }
  }

  // `when:` snapshot — facts from THIS input, taken once before any op runs (fact
  // names win over vars). Only computed when a step is actually guarded.
  let whenScope: WhenScope | null = null;
  if (plan.steps.some((s) => s.when)) {
    const facts = ctx.current ? await computeFacts(ctx.current) : {};
    // Rich facts (has_text/has_images) need a content inspection — done once, lazily,
    // only when a guard references one, via an inspect-capable adapter (Python).
    const richIds = new Set<string>();
    for (const s of plan.steps) {
      if (!s.when) continue;
      for (const id of analyzeWhen(s.when).identifiers) {
        if ((RICH_FACTS as readonly string[]).includes(id)) richIds.add(id);
      }
    }
    if (richIds.size && ctx.current) {
      const inspector = registry.all().find((a) => typeof a.inspect === "function");
      if (inspector && (await inspector.isAvailable())) {
        try {
          Object.assign(facts, await inspector.inspect!(ctx.current));
        } catch {
          /* fall through to the missing-fact error below */
        }
      }
      const missing = [...richIds].filter((id) => !(id in facts));
      if (missing.length) {
        throw new Error(
          `when: needs the Python backend for fact(s) ${missing.join(", ")} — install PyMuPDF, or remove the guard`,
        );
      }
    }
    whenScope = { ...varScope, ...facts };
  }

  for (const step of plan.steps) {
    if (done.has(step.index)) continue; // already applied per input, above
    if (step.when && whenScope) {
      let active: boolean;
      try {
        active = evaluateWhen(step.when, whenScope);
      } catch (e) {
        throw new Error(`when: (${step.op}) ${(e as Error).message}`);
      }
      if (!active) {
        notes.push(`skipped ${step.op}: when \`${step.when}\` is false`);
        onStep?.({ index: step.index, op: step.op, note: `skipped (when: ${step.when})` });
        continue;
      }
    }
    if (!step.adapter) {
      notes.push(`skipped ${step.op}: no adapter for capability "${step.capability}"`);
      onStep?.({ index: step.index, op: step.op, note: "skipped (no adapter)" });
      continue;
    }
    const adapter = registry.all().find((a) => a.id === step.adapter)!;
    const result = await adapter.apply(ctx, { ...step, params: substituteEnv(step.params) });
    if (result.current !== undefined) ctx.current = result.current;
    if (result.artifacts) ctx.artifacts.push(...result.artifacts);
    if (result.note) notes.push(result.note);
    if (result.incomplete) incomplete = true;
    onStep?.({ index: step.index, op: step.op, note: result.note });
  }

  // Write output + artifacts (see the top-level doc comment for the folder/file rules).
  const writtenArtifacts: string[] = [];
  let output: string | null = null;
  const outFile = target.file;
  const outFolder = target.folder;
  const outExt = outFile ? nodePath.extname(outFile).toLowerCase() : "";
  const pending = [...ctx.artifacts];

  if (outFolder) {
    for (const art of pending) {
      const p = `${outFolder.replace(/\/+$/, "")}/${nodePath.basename(art.path)}`;
      await fs.writeFile(p, art.bytes);
      writtenArtifacts.push(p);
    }
    return { output: outFolder, artifacts: writtenArtifacts, notes, incomplete };
  }

  if (outFile && outExt && outExt !== ".pdf") {
    const i = pending.findIndex((a) => nodePath.extname(a.path).toLowerCase() === outExt);
    if (i >= 0) {
      const [art] = pending.splice(i, 1);
      await fs.writeFile(outFile, art!.bytes);
      output = outFile;
    }
  }
  if (!output && ctx.current && outFile) {
    await fs.writeFile(outFile, ctx.current);
    output = outFile;
  }
  for (const art of pending) {
    const p = resolveArtifactPath(outFile, art);
    await fs.writeFile(p, art.bytes);
    writtenArtifacts.push(p);
  }
  return { output, artifacts: writtenArtifacts, notes, incomplete };
}

/** Does this look like a PDF? Sniffs the `%PDF` header rather than trusting the
 *  extension, so a mis-named file is converted (or reported) rather than silently
 *  handed to a PDF parser. */
function isPdfBytes(b: Uint8Array): boolean {
  return b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;
}

/** A glob input (`*`/`?`) triggers batch mode. */
export function isGlob(s: string): boolean {
  return /[*?]/.test(s);
}

function globToRegex(glob: string): RegExp {
  const rx = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${rx}$`);
}

/** Expand a workflow-relative glob (`*`/`?`/`**`) to a sorted, deduped file list via
 *  {@link HostFs.list}. Confinement is enforced by the fs at listing time. */
export async function expandGlob(fs: HostFs, pattern: string): Promise<string[]> {
  if (!fs.list) throw new Error("batch (glob inputs) requires a filesystem with directory listing");
  const list = fs.list.bind(fs);
  const segs = pattern.replace(/\\/g, "/").split("/").filter((s) => s.length);
  const out: string[] = [];
  async function walk(dir: string, i: number): Promise<void> {
    if (i >= segs.length) return;
    const seg = segs[i]!;
    const last = i === segs.length - 1;
    if (seg === "**") {
      await walk(dir, i + 1); // ** matches zero directories…
      for (const e of await list(dir || ".")) {
        if (e.dir) await walk(dir ? `${dir}/${e.name}` : e.name, i); // …or one-or-more
      }
      return;
    }
    const rx = isGlob(seg) ? globToRegex(seg) : null;
    for (const e of await list(dir || ".")) {
      if (rx ? rx.test(e.name) : e.name === seg) {
        const p = dir ? `${dir}/${e.name}` : e.name;
        if (last) {
          if (!e.dir) out.push(p);
        } else if (e.dir) {
          await walk(p, i + 1);
        }
      }
    }
  }
  await walk("", 0);
  return Array.from(new Set(out)).sort();
}

/** Substitute batch tokens in a templated `output.file`: {stem} {name} {ext} {i}.
 *  Delegates to the shared renderer, so zero-padding ({i:03}) works here too and batch
 *  outputs and split part names speak one token vocabulary. */
export function applyBatchTemplate(tpl: string, inputPath: string, i: number): string {
  const name = nodePath.basename(inputPath);
  const ext = nodePath.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  return renderTemplate(tpl, { stem, name, ext, i: i + 1 });
}

/** Parse + run in one call. */
export async function runWorkflowText(text: string, opts: RunWorkflowOptions): Promise<RunWorkflowResult> {
  return runWorkflow(parseWorkflow(text), opts);
}

/**
 * Substitute `${ENV_VAR}` from the environment at run time — but ONLY in the
 * password params in {@link SECRET_PARAMS} — so a signing/encryption secret can
 * be referenced by name instead of stored in plaintext in a committed
 * `.opw.yaml`. Any `${…}` in any other param is left untouched (see the security
 * note on {@link SECRET_PARAMS}). An unset variable becomes an empty string.
 */
export function substituteEnv(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] =
      SECRET_PARAMS.has(k) && typeof v === "string"
        ? v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => process.env[name] ?? "")
        : v;
  }
  return out;
}

/** Split artifacts land next to the output, using its stem. */
function resolveArtifactPath(outputFile: string | undefined, art: EmittedArtifact): string {
  if (art.path.startsWith("__split_named__/")) {
    // `split: { name: … }` already rendered the basename; keep it verbatim and only
    // decide the DIRECTORY — the output file's folder.
    const dir = nodePath.dirname(outputFile ?? "output/split.pdf");
    const base = art.path.slice("__split_named__/".length);
    return dir === "." ? base : `${dir}/${base}`;
  }
  if (art.path.startsWith("__split__/")) {
    // The pdf-lib `split` sentinel names parts from the output stem; `split`
    // requires output.file, so outputFile is present here (fall back defensively).
    const stem = (outputFile ?? "output/split.pdf").replace(/\.pdf$/i, "");
    const part = art.path.slice("__split__/".length).replace(/^part_/, "").replace(/\.pdf$/i, "");
    return `${stem}_${part}.pdf`;
  }
  return art.path;
}

/**
 * Resolve `p` against `baseDir` and refuse anything that escapes it — an
 * absolute path or `..` traversal — or that reaches into a protected directory
 * INSIDE it. A workflow may be untrusted (cloned, shared, or agent-authored), so
 * a crafted `output.file`, extract `to`, `inputs`, or asset path must not reach
 * `~/.bashrc`, a Startup folder, `.git/hooks`, or any file outside the
 * workflow's own directory.
 *
 * The two halves are separate protections. Confinement is a boundary check and
 * says nothing about what lives inside the boundary — and a workflow is often
 * rendered at the root of a repository, which puts `.git/` on the near side of
 * the fence. `.git/hooks/pre-commit` needs no traversal to reach; it is just a
 * relative path. See PROTECTED_DIRS for what that buys an attacker.
 */
export function confinePath(baseDir: string, p: string): string {
  // Reject Windows drive-prefixed (C:\x or drive-relative C:x) and UNC (\\host)
  // paths up front, host-independently: on a POSIX host `path.resolve` would
  // treat "C:x" as an ordinary filename and wrongly admit it, so the drive/UNC
  // check can't be left to the relative()-based test below.
  if (/^([a-zA-Z]:|\\\\)/.test(p)) {
    throw new Error(`path "${p}" escapes the workflow directory`);
  }
  const base = nodePath.resolve(baseDir);
  const abs = nodePath.resolve(base, p);
  const rel = nodePath.relative(base, abs);
  if (rel === ".." || rel.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(rel)) {
    throw new Error(`path "${p}" escapes the workflow directory`);
  }
  // Checked on the RESOLVED path, not the input: "output/../.git/hooks/x" and
  // ".git/hooks/x" are the same file, and only one of them looks like it.
  const dir = protectedDirIn(rel);
  if (dir) {
    throw new Error(`path "${p}" writes into "${dir}", which holds files your tools execute`);
  }
  return abs;
}

/** A HostFs backed by node fs, confined to baseDir (no `..`/absolute escape). */
export function nodeFs(baseDir: string): HostFs {
  return {
    async readFile(path: string): Promise<Uint8Array> {
      return readFile(confinePath(baseDir, path));
    },
    async list(dir: string): Promise<{ name: string; dir: boolean }[]> {
      try {
        const ents = await readdir(confinePath(baseDir, dir || "."), { withFileTypes: true });
        return ents.map((e) => ({ name: e.name, dir: e.isDirectory() }));
      } catch {
        return []; // missing directory → no matches
      }
    },
    async writeFile(path: string, bytes: Uint8Array): Promise<void> {
      const abs = confinePath(baseDir, path);
      await mkdir(nodePath.dirname(abs), { recursive: true });
      // Atomic: write to a temp sibling then rename, so a concurrent reader
      // (e.g. the pdf.js preview) never observes a half-written PDF. Falls back
      // to a direct write if the rename is blocked (e.g. target briefly locked).
      // The temp name is randomized so a co-located attacker can't pre-create /
      // symlink a predictable sibling to redirect the write.
      const tmp = `${abs}.tmp-${randomBytes(6).toString("hex")}`;
      await writeFile(tmp, bytes);
      try {
        await rename(tmp, abs);
      } catch {
        await writeFile(abs, bytes);
        try {
          await rm(tmp, { force: true });
        } catch {
          /* ignore */
        }
      }
    },
  };
}
