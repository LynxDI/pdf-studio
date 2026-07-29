// PythonAdapter — the opt-in PyMuPDF execution backend.
//
// Handles the capabilities pdf-lib can't: extract_text, extract_images,
// replace_image, redact. It shells out to a Python sidecar (pdf_exec.py, owned
// by the extension and passed in as scriptPath), exchanging JSON over stdin/
// stdout and PDF/artifact bytes via a private temp dir. The sidecar runs with
// cwd = the workflow directory so relative asset paths (e.g. the replacement
// image) resolve naturally.
//
// The interpreter is resolved via resolvePythonWithPyMuPDF (core/deps): the
// extension host's PATH can put a bare `python` on the Windows Store stub or an
// interpreter without PyMuPDF, so we probe for one that can `import fitz`.
// isAvailable() returns false when none qualifies → capabilities stay
// unsatisfied exactly as before the backend was installed.

import { readFile, writeFile, mkdtemp, rm, stat, readdir } from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import type { DocumentKind } from "../../opw/model.js";
import type { Capability } from "../../opw/operations.js";
import type { PlanStep } from "../../opw/compile.js";
import type { AdapterResult, EmittedArtifact, ExecContext, RendererAdapter } from "../adapter.js";
import { resolvePythonWithPyMuPDF, parseLastJsonObject, type PythonCmd } from "../../deps/python-resolve.js";
import { envWithToolPath } from "../../deps/check.js";
import { PYTHON_CAPABILITIES } from "../capabilities.js";
import { getFormSchema, listForms, resolveFormFill, extractFormValues, detectForm, toTable, toCsv, groupByForm, csvToRecords, type RecordMap, type RawField } from "../../forms/index.js";
import { confinePath } from "../../execute.js";
import { renderTemplate } from "../../opw/template.js";

/** One input's raw AcroForm dump, as returned by the sidecar's extract_form. */
interface RawDump {
  fields: RawField[];
  error?: string;
}

/** The pseudo-form id for a PDF no pack recognises. Its fields are read raw (name → value),
 *  which is exactly right for a form create_form built: the tag key IS the field name. */
const RAW_FORM = "raw";

/** A row of the combined forms.json — also the resume ledger (see tabulateForms). */
interface LedgerEntry {
  file: string;
  sha256: string;
  form: string;
  title?: string;
  values: Record<string, string>;
  warnings?: string[];
  error?: string;
}

/** Kill the sidecar AND its descendants. `child.kill()` reaps only the direct
 *  Python child; on a timeout its grandchildren — ocrmypdf→ghostscript/tesseract,
 *  ssh/scp — orphan: they keep a remote GPU busy and can race a resume's cache dir,
 *  corrupting output. On Windows TerminateProcess runs no handler, so the tree must
 *  be reaped from here: `taskkill /T` on win32, and the process group (the child is
 *  spawned `detached`, so its pid is a group leader) on POSIX. Mirrors the sidecar's
 *  own _browser_run recipe. */
/** Parse one stderr line as a progress record ({"progress":{op?,chunk,of}}), or null if
 *  it's ordinary stderr (a traceback, a tqdm bar). Kept strict so real errors never look
 *  like progress. */
function tryParseProgress(line: string): { op?: string; chunk: number; of: number } | null {
  const t = line.trim();
  if (!t.startsWith("{") || !t.includes("\"progress\"")) return null;
  try {
    const o = JSON.parse(t) as { progress?: { op?: string; chunk?: unknown; of?: unknown } };
    const p = o.progress;
    if (p && typeof p.chunk === "number" && typeof p.of === "number") {
      return { op: p.op, chunk: p.chunk, of: p.of };
    }
  } catch {
    /* not JSON — real stderr */
  }
  return null;
}

function killProcessTree(child: ReturnType<typeof spawn>): void {
  const pid = child.pid;
  try {
    if (pid === undefined) {
      child.kill();
    } else if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      try {
        process.kill(-pid, "SIGKILL"); // negative pid = the whole process group
      } catch {
        child.kill("SIGKILL");
      }
    }
  } catch {
    /* ignore */
  }
}

/** Ops whose runtime scales with page count / document size — OCR, full-document
 * Markdown/table/text extraction, rasterization, PDF/A, sanitize, redact. On a
 * big book/scan these easily exceed the 60s default (a 230-page book → ~140s),
 * so they get a generous ceiling instead of aborting mid-render. */
const HEAVY_OPS = new Set([
  "ocr",
  "pdf_to_pdfa",
  "extract_markdown",
  "extract_tables",
  "extract_text",
  "render_pages",
  "rasterize",
  "sanitize",
  "auto_redact",
  // find-and-mark walks get_text("words") on every page, like auto_redact.
  "highlight",
  "replace_text",
  "split_invoices",
  "compare_pdfs",
  "pdf_to_epub",
  "recolor",
  "scanner_effect",
  "create_form",
  // text-coverage ops call get_text on every page — a 7,609-page doc exceeds the 60s
  // default the metadata-only pdf_info walk used to meet.
  "text_report",
  "pdf_info",
  // link extraction walks get_links + get_text over every page of every input in a folder.
  "extract_links",
  // annotation extraction walks page.annots() + get_textbox over every page of every input.
  "extract_annotations",
]);
const HEAVY_TIMEOUT_MS = 600_000;

/** Markdown extraction with the Marker engine (Surya OCR + layout models, model
 *  download + slow CPU inference) or ocr_first (a full OCRmyPDF re-OCR pass before
 *  extracting) can take many minutes on a big scan. Give those a much larger
 *  ceiling than the ordinary heavy ops. */
const HEAVY_ML_TIMEOUT_MS = 1_800_000;

/** Remote OCR (Marker over HTTP/SSH) on a large deck can run far past even the ML ceiling.
 *  These ops are RESUMABLE and self-budget against a soft deadline (80% of this), flushing a
 *  partial and returning before the hard timer fires — so this is only a backstop. */
const REMOTE_TIMEOUT_MS = 3_600_000;

/** Ops that CREATE a PDF from a non-PDF source, so they may run with no PDF
 * working document (e.g. url_to_pdf sources from a param). */
const CREATOR_OPS = new Set(["html_to_pdf", "markdown_to_pdf", "eml_to_pdf", "url_to_pdf", "epub_to_pdf", "images_to_pdf"]);

/** Ops that render pages to image files and accept a `name` filename template. They share
 *  one capability (render_pages); the op name only picks the format. */
const RENDER_IMAGE_OPS = new Set(["render_pages", "pdf_to_png", "pdf_to_jpg"]);

/** Ops that call an LLM. Gated behind pdfStudio.allowAiRequests because they send
 *  document text to the configured model (local Ollama by default, or a cloud API). */
const AI_OPS = new Set(["summarize", "translate", "semantic_search"]);

/** Ops that ALWAYS send document bytes to a model service over HTTP, even when the
 *  endpoint comes from an env default rather than an explicit `endpoint` param. These
 *  ride the same pdfStudio.allowRemoteRender gate as remote Marker (uploads bytes
 *  off-box), so they must be gated regardless of whether a param names the target. */
const ALWAYS_REMOTE_OPS = new Set(["extract_receipt"]);

export interface PythonAdapterOptions {
  /** Optional interpreter override (the pdfStudio.pythonPath setting). */
  configuredPython?: string;
  /** Absolute path to the pdf_exec.py sidecar (shipped in the extension). */
  scriptPath: string;
  /** Workflow directory — the sidecar's cwd, so relative asset paths resolve. */
  baseDir: string;
  /** Per-op timeout (default 60s). */
  timeoutMs?: number;
  /** Allow ops with a `remote` param to offload to a GPU box over SSH. Off by
   *  default; the extension sets it from the pdfStudio.allowRemoteRender setting.
   *  When false, a `remote` param is rejected rather than silently ignored. */
  allowRemote?: boolean;
  /** Allow AI ops (summarize/translate) to send document text to an LLM. Off by
   *  default; set from the pdfStudio.allowAiRequests setting. When false, an AI op
   *  is rejected rather than silently contacting a model. */
  allowAi?: boolean;
  /** Interpreter for the PaddleOCR-VL engine (a SEPARATE venv from the PyMuPDF one).
   *  Passed to the sidecar as $PDFSTUDIO_PADDLE_PYTHON so `extract_markdown`'s
   *  paddleocr-vl engine subprocesses into it. Undefined → the engine falls back to
   *  its own resolution / errors clearly. */
  paddlePython?: string;
  /** OpenAI-compatible VLM server URL for `extract_receipt` → $PDFSTUDIO_VLM_ENDPOINT. */
  vlmEndpoint?: string;
  /** Model name for `extract_receipt` → $PDFSTUDIO_VLM_MODEL. */
  vlmModel?: string;
  /** Per-chunk progress from long remote ops (Marker HTTP/SSH), streamed on stderr as
   *  NDJSON and forwarded here — the extension wires this to its output channel. */
  onProgress?: (p: { op?: string; chunk: number; of: number }) => void;
}

interface SidecarArtifact {
  tmp: string;
  path: string;
  kind: "text" | "image" | "pdf" | "json";
}
interface SidecarResult {
  ok: boolean;
  changed?: boolean;
  /** A dry run: the caller must DROP the working document (see the res.preview branch in
   *  apply) so execute.ts can't publish an un-transformed doc under the output name. */
  preview?: boolean;
  note?: string;
  error?: string;
  artifacts?: SidecarArtifact[];
  /** A remote/chunked op that self-truncated at its soft deadline — resumable on re-run. */
  incomplete?: boolean;
  /** Content facts for `when:` guards (has_text/has_images), from the `_facts` op. */
  facts?: Record<string, string | number | boolean>;
}

/** True for an http(s) URL whose host is loopback (localhost / 127.0.0.0-8 / ::1). Such
 *  traffic never leaves the machine, so it is NOT the off-box egress that
 *  allowRemoteRender guards. Any parse failure is treated as non-loopback (fail closed). */
function isLoopbackUrl(u: string): boolean {
  try {
    const h = new URL(u).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "::1" || /^127\./.test(h);
  } catch {
    return false;
  }
}

export class PythonAdapter implements RendererAdapter {
  readonly id = "python";
  readonly kinds: readonly DocumentKind[] = ["pdf"];
  readonly capabilities: readonly Capability[] = PYTHON_CAPABILITIES;
  private py: PythonCmd | null = null;
  private resolved = false;

  constructor(private readonly opts: PythonAdapterOptions) {}

  async isAvailable(): Promise<boolean> {
    if (!this.resolved) {
      this.py = await resolvePythonWithPyMuPDF(this.opts.configuredPython);
      this.resolved = true;
    }
    return this.py !== null;
  }

  /** Read content-level facts (has_text / has_images) for `when:` guards via a
   *  lightweight, read-only `_facts` sidecar call. Returns {} if unavailable. */
  async inspect(bytes: Uint8Array): Promise<Record<string, string | number | boolean>> {
    if (!(await this.isAvailable()) || !this.py) return {};
    const tmpDir = await mkdtemp(nodePath.join(os.tmpdir(), "opw-facts-"));
    const inPdf = nodePath.join(tmpDir, "in.pdf");
    try {
      await writeFile(inPdf, bytes);
      const res = await this.runSidecar(
        this.py,
        { op: "_facts", params: {}, in: inPdf, out: nodePath.join(tmpDir, "out.pdf"), artifact_dir: tmpDir },
        30_000,
      );
      return res.facts ?? {};
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async apply(ctx: ExecContext, step: PlanStep): Promise<AdapterResult> {
    const isCreator = CREATOR_OPS.has(step.op);
    if (!ctx.current && !isCreator) throw new Error(`python adapter: no working document for "${step.op}"`);

    // fill_form: resolve friendly record values → raw field instructions at execute
    // time (the registry lives in core; the sidecar stays a dumb raw-field filler).
    // `preview: true` short-circuits to a dry-run report without touching the PDF.
    let params = step.params as Record<string, unknown>;
    let extraNote = "";

    // Page-image filename templates: resolve `{stem}` HERE, where the input path is known,
    // and let the sidecar fill in the per-page {i}/{page}. renderTemplate leaves unknown
    // tokens verbatim, which is exactly what makes this two-stage substitution safe.
    if (RENDER_IMAGE_OPS.has(step.op) && typeof params["name"] === "string") {
      const base = nodePath.basename(ctx.inputPaths[0] ?? "document.pdf");
      const stem = base.slice(0, base.length - nodePath.extname(base).length);
      params = { ...params, name: renderTemplate(String(params["name"]), { stem }) };
    }

    if (step.op === "fill_form" && typeof params["form"] === "string") {
      const resolved = await this.resolveFillForm(params);
      if (resolved.preview) return resolved.preview;
      params = resolved.params;
      extraNote = resolved.note;
    }
    // create_form: read the field-config YAML here (the sidecar has no yaml), and catch the
    // most likely first-use mistake — forgetting the conversion op — before the sidecar dies
    // with a bare "open failed" on a .docx.
    if (step.op === "create_form") {
      const magic = new TextDecoder().decode((ctx.current ?? new Uint8Array()).slice(0, 5));
      if (!magic.startsWith("%PDF")) {
        throw new Error(
          `create_form expects a PDF, but the working document isn't one — put a conversion op ` +
            `(office_to_pdf / markdown_to_pdf / html_to_pdf) BEFORE create_form in the operations list.`,
        );
      }
      params = await this.resolveCreateForm(params, ctx);
    }
    if (params["remote"] && params["endpoint"]) {
      throw new Error(`"${step.op}": set "remote" (SSH) OR "endpoint" (HTTP), not both.`);
    }
    const remoteTarget = params["remote"] || params["endpoint"];
    // A loopback HTTP endpoint (localhost / 127.x / ::1) never leaves the machine, so it is
    // NOT the off-box egress allowRemoteRender guards — don't require the gate for it. The
    // receipt endpoint can also come from config (vlmEndpoint), not just a param. The SSH
    // `remote` param always targets another host, so it is never loopback-exempt.
    const httpEndpoint = params["endpoint"]
      ? String(params["endpoint"])
      : step.op === "extract_receipt"
        ? this.opts.vlmEndpoint ?? ""
        : "";
    const loopbackOnly = !params["remote"] && !!httpEndpoint && isLoopbackUrl(httpEndpoint);
    if (remoteTarget && !this.opts.allowRemote && !loopbackOnly) {
      const via = params["endpoint"] ? "an HTTP Marker service" : "a GPU box over SSH";
      throw new Error(
        `"${step.op}" sends the document to a remote target ("${String(remoteTarget)}"), but remote render is disabled. ` +
          `Enable the "pdfStudio.allowRemoteRender" setting to run Marker on ${via} (this uploads document bytes off-box).`,
      );
    }
    // Ops that always call a model server (e.g. extract_receipt → a vision-language endpoint)
    // are gated even when the endpoint is an env default — UNLESS that endpoint is loopback
    // (a local model server, so nothing leaves the machine).
    if (ALWAYS_REMOTE_OPS.has(step.op) && !remoteTarget && !this.opts.allowRemote && !loopbackOnly) {
      throw new Error(
        `"${step.op}" sends page images to a vision-language model server, but remote render is disabled. ` +
          `Enable the "pdfStudio.allowRemoteRender" setting, or point it at a LOCAL server (set the "endpoint" ` +
          `param or $PDFSTUDIO_VLM_ENDPOINT to http://localhost:… — a loopback endpoint needs no permission).`,
      );
    }
    const usesAi = AI_OPS.has(step.op) || String((step.params as Record<string, unknown>)["detect"] ?? "").toLowerCase() === "ai";
    if (usesAi && !this.opts.allowAi) {
      throw new Error(
        `"${step.op}" sends document text to an LLM, but AI requests are disabled. ` +
          `Enable the "pdfStudio.allowAiRequests" setting (uses a local Ollama by default; ` +
          `set ANTHROPIC_API_KEY to use Claude instead).`,
      );
    }
    if (!(await this.isAvailable()) || !this.py) {
      throw new Error(`python adapter: no PyMuPDF-capable interpreter found for "${step.op}"`);
    }
    const tmpDir = await mkdtemp(nodePath.join(os.tmpdir(), "opw-py-"));
    const inPdf = nodePath.join(tmpDir, "in.pdf");
    const outPdf = nodePath.join(tmpDir, "out.pdf");
    const artDir = nodePath.join(tmpDir, "artifacts");
    try {
      await writeFile(inPdf, ctx.current ?? new Uint8Array());
      // Multi-input creator ops (images_to_pdf) need every input, not just the
      // working doc — write each to a temp file and pass their paths to the sidecar.
      let inputPaths: string[] | undefined;
      if (step.op === "extract_form") {
        // Reads every input together (one table over many forms), not just the working doc.
        inputPaths = [];
        for (let i = 0; i < ctx.inputs.length; i++) {
          const p = nodePath.join(tmpDir, `form_${i}.pdf`);
          await writeFile(p, ctx.inputs[i]!);
          inputPaths.push(p);
        }
      }
      if (step.op === "images_to_pdf") {
        inputPaths = [];
        for (let i = 0; i < ctx.inputs.length; i++) {
          // Keep the original extension on the staged file. PyMuPDF picks its decoder
          // partly from the filename (SVG in particular), and the sidecar needs it to say
          // "this .heic needs pillow-heif" instead of a generic "no readable images".
          const ext = nodePath.extname(ctx.inputPaths[i] ?? "").toLowerCase();
          const p = nodePath.join(tmpDir, `img_${i}${ext}`);
          await writeFile(p, ctx.inputs[i]!);
          inputPaths.push(p);
        }
      }
      if (step.op === "extract_receipt") {
        // Reads every input as its own receipt batch (one combined table), not just the
        // working doc — write each to a temp file and pass their paths to the sidecar.
        inputPaths = [];
        for (let i = 0; i < ctx.inputs.length; i++) {
          const p = nodePath.join(tmpDir, `receipt_${i}.pdf`);
          await writeFile(p, ctx.inputs[i]!);
          inputPaths.push(p);
        }
      }
      if (step.op === "extract_links" || step.op === "extract_annotations") {
        // Reads every input together (one combined table across the folder), not just the
        // working doc — write each to a temp file and pass their paths.
        inputPaths = [];
        for (let i = 0; i < ctx.inputs.length; i++) {
          const p = nodePath.join(tmpDir, `extract_${i}.pdf`);
          await writeFile(p, ctx.inputs[i]!);
          inputPaths.push(p);
        }
      }
      // Remote Marker engines run resumably from a persistent cache and self-budget against a
      // soft deadline (80% of the hard timeout) so they can flush + return "incomplete" before
      // runSidecar's hard kill. Pass the deadline + an input hash (so Python needn't re-hash a
      // 1.6 GB file, and the cache key is stable across runs).
      let reqParams: Record<string, unknown> = params;
      if (step.op === "extract_receipt" || step.op === "extract_links" || step.op === "extract_annotations") {
        // The sidecar names per-input output and fills the source-file column from the REAL
        // workflow-relative paths, but only ever sees temp files — pass the real names.
        reqParams = { ...params, input_names: ctx.inputPaths };
      }
      if ((step.op === "extract_markdown" || step.op === "pdf_to_markdown") && (params["endpoint"] || params["remote"])) {
        const hardMs = this.timeoutFor(step) ?? HEAVY_TIMEOUT_MS;
        const inputSha = createHash("sha256").update(ctx.current ?? new Uint8Array()).digest("hex");
        reqParams = { ...params, soft_deadline_ms: Math.floor(hardMs * 0.8), input_sha: inputSha };
      }
      const res = await this.runSidecar(
        this.py,
        {
          op: step.op,
          params: reqParams,
          in: inPdf,
          out: outPdf,
          artifact_dir: artDir,
          ...(inputPaths ? { inputs: inputPaths } : {}),
        },
        this.timeoutFor(step),
      );
      if (!res.ok) throw new Error(res.error || `${step.op} failed in the Python backend`);

      let current: Uint8Array | null | undefined = undefined;
      if (res.changed) current = await readFile(outPdf);
      // A dry run must DROP the working document, not merely leave it alone: execute.ts writes
      // ctx.current to output.file whenever it's set, so `undefined` here would publish the
      // un-transformed doc under the finished name (for create_form: a PDF with the [[tags]]
      // still visible and no fields — exactly what the preview is warning about).
      if (res.preview) current = null;

      if (step.op === "extract_form") {
        const raw = JSON.parse(await readFile(nodePath.join(artDir, "raw_fields.json"), "utf8")) as RawDump[];
        return this.tabulateForms(ctx, params, raw);
      }

      const artifacts: EmittedArtifact[] = [];
      for (const a of res.artifacts ?? []) {
        const bytes = await readFile(nodePath.join(artDir, a.tmp));
        artifacts.push({ path: a.path, bytes, kind: a.kind });
      }
      return { current, artifacts, note: (res.note ?? "") + extraNote, ...(res.incomplete ? { incomplete: true } : {}) };
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Map every input's raw fields through its form pack → per-form JSON + a combined
   *  JSON/CSV table.
   *
   *  Resume: the combined forms.json doubles as the ledger. Each entry carries the
   *  content hash of the PDF it came from, so a re-run re-reads only files that are
   *  new or whose bytes changed, and merges them into the existing table — the "drop
   *  more forms in the folder and run again" loop. Entries whose source file is gone
   *  are kept: the extracted data outlives the file it came from. */
  private async tabulateForms(ctx: ExecContext, params: Record<string, unknown>, raw: RawDump[]): Promise<AdapterResult> {
    const to = String(params["to"] ?? "output/extracted").replace(/\/+$/, "");
    confinePath(this.opts.baseDir, to); // reject a `to` that escapes the project
    const fmt = String(params["format"] ?? "both").toLowerCase();
    const wantJson = fmt === "both" || fmt === "json";
    const wantCsv = fmt === "both" || fmt === "csv";
    const resume = params["resume"] !== false;
    const includeEmpty = params["include_empty"] === true;
    const forced = typeof params["form"] === "string" ? String(params["form"]) : undefined;
    const schemas = listForms();

    // Prior ledger (resume). Absent/corrupt → start fresh; never fail the run over it.
    const ledgerPath = `${to}/forms.json`;
    let prior: LedgerEntry[] = [];
    if (resume) {
      try {
        const txt = await readFile(confinePath(this.opts.baseDir, ledgerPath), "utf8");
        const parsed: unknown = JSON.parse(txt);
        if (Array.isArray(parsed)) prior = parsed as LedgerEntry[];
      } catch {
        /* first run, or an unreadable ledger — extract everything */
      }
    }
    const byFile = new Map(prior.map((e) => [e.file, e]));

    const artifacts: EmittedArtifact[] = [];
    const entries: LedgerEntry[] = [];
    let csvFiles: string[] = [];
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < raw.length; i++) {
      const file = ctx.inputPaths[i] ?? `input_${i}.pdf`;
      const sha = createHash("sha256").update(ctx.inputs[i] ?? new Uint8Array()).digest("hex").slice(0, 16);
      const seen = byFile.get(file);
      // A cached FAILURE is unfinished work, not a result — always retry it. Only a
      // successful extraction of identical bytes may be skipped.
      if (seen && seen.sha256 === sha && !seen.error) {
        entries.push(seen);
        byFile.delete(file);
        skipped++;
        continue;
      }
      if (seen) byFile.delete(file); // superseded by this run's fresh read
      const dump = raw[i]!;
      if (dump.error) {
        failed++;
        entries.push({ file, sha256: sha, form: "", error: dump.error, values: {} });
        continue;
      }
      const names = dump.fields.map((f) => f.name);
      const id = forced ?? detectForm(names, schemas)[0]?.form;
      const schema = id ? getFormSchema(id) : undefined;
      if (!schema) {
        if (names.length) {
          // No pack matches — but the PDF still has fields, so read them RAW: field name →
          // value. A form built by create_form lands here by design (its field names ARE the
          // friendly keys), which is what closes the loop: template → fillable → filled →
          // JSON/CSV, with nothing to author and no registry entry.
          const values: Record<string, string> = {};
          for (const f of dump.fields) {
            const v = (f.value ?? "").trim();
            if (v && v.toLowerCase() !== "off") values[f.name] = v;
          }
          entries.push({ file, sha256: sha, form: RAW_FORM, title: "Unrecognized form — raw fields", values });
          if (wantJson) {
            const stem = nodePath.basename(file).replace(/\.[^.]*$/, "");
            artifacts.push({
              path: `${to}/${stem}.json`,
              bytes: new TextEncoder().encode(JSON.stringify({ file, form: RAW_FORM, values }, null, 2) + "\n"),
              kind: "json",
            });
          }
          continue;
        }
        failed++;
        entries.push({
          file,
          sha256: sha,
          form: "",
          error: "no form fields (flattened or not a form)",
          values: {},
        });
        continue;
      }
      const ex = extractFormValues(schema, dump.fields);
      const values = includeEmpty ? { ...Object.fromEntries(ex.empty.map((k) => [k, ""])), ...ex.values } : ex.values;
      entries.push({ file, sha256: sha, form: ex.form, title: ex.title, values, ...(ex.warnings.length ? { warnings: ex.warnings } : {}) });
      if (wantJson) {
        const stem = nodePath.basename(file).replace(/\.[^.]*$/, "");
        artifacts.push({
          path: `${to}/${stem}.json`,
          bytes: new TextEncoder().encode(JSON.stringify({ file, form: ex.form, title: ex.title, values, empty: ex.empty }, null, 2) + "\n"),
          kind: "json",
        });
      }
    }
    // Rows whose source file was not in this run (a narrower glob, or a deleted file)
    // stay in the table — resume adds, it doesn't forget.
    for (const stale of byFile.values()) entries.push(stale);
    entries.sort((a, b) => a.file.localeCompare(b.file));

    const ok = entries.filter((e) => !e.error);
    if (wantJson) {
      artifacts.push({ path: ledgerPath, bytes: new TextEncoder().encode(JSON.stringify(entries, null, 2) + "\n"), kind: "json" });
    }
    if (wantCsv) {
      // One CSV per form type: their schemas are unrelated, so one grid over all of them
      // would be sparse and its columns would depend on which files were present.
      const byForm = groupByForm(ok.map((e) => ({ file: e.file, extracted: { form: e.form, title: e.title ?? "", values: e.values, empty: [], warnings: [] } })));
      for (const [id, rows] of byForm) {
        const table = toTable(rows, getFormSchema(id));
        artifacts.push({ path: `${to}/${id}.csv`, bytes: new TextEncoder().encode(toCsv(table)), kind: "csv" });
      }
      csvFiles = [...byForm.keys()].sort();
    }

    const fresh = raw.length - skipped - failed;
    const note =
      `extracted ${ok.length} form(s) → ${to}/` +
      (csvFiles.length ? ` (${csvFiles.map((f) => `${f}.csv`).join(", ")})` : "") +
      (fresh ? ` · ${fresh} new` : "") +
      (skipped ? ` · ${skipped} unchanged (skipped)` : "") +
      (failed ? ` · ${failed} unreadable (see forms.json)` : "");
    return { current: undefined, artifacts, note };
  }

  /** Normalize a create_form step's field config for the sidecar.
   *
   *  The YAML is read HERE, not in Python: the sidecar has no `yaml` import and PyYAML isn't
   *  one of its dependencies — same split as fill_form, where core owns the vocabulary and the
   *  sidecar stays a dumb widget-placer. Produces a plain `fields: [{key, type, ...}]` array.
   *
   *  Batch: `to`/`debug_to` accept {stem}/{name}/{i}, because artifact paths are NOT rewritten
   *  per input (resolveArtifactPath returns them verbatim and this op isn't `emitsFiles`), so a
   *  glob over templates would otherwise have every run overwrite the same report. */
  private async resolveCreateForm(params: Record<string, unknown>, ctx: ExecContext): Promise<Record<string, unknown>> {
    const ref = (params["fields_file"] ?? params["from"]) as string | undefined;
    let fromFile: Record<string, unknown> = {};
    let style: Record<string, unknown> = {};
    if (ref) {
      const abs = confinePath(this.opts.baseDir, ref); // workflow-supplied path — confine it
      let doc: unknown;
      try {
        doc = parseYaml(await readFile(abs, "utf8"));
      } catch (e) {
        throw new Error(`create_form: could not read fields_file "${ref}" — ${(e as Error).message}`);
      }
      const top = (doc ?? {}) as Record<string, unknown>;
      // Accept either { fields: {...}, style: {...} } or a bare map of fields (loadRecords
      // is equally lenient about its top-level key).
      const f = top["fields"];
      fromFile = (f && typeof f === "object" ? f : top["style"] ? {} : top) as Record<string, unknown>;
      style = (top["style"] ?? {}) as Record<string, unknown>;
    }
    const inline = (params["fields"] ?? {}) as Record<string, unknown>;
    // Merge per key, shallow-replace: an inline entry replaces that field's whole config
    // rather than half-merging into it.
    const merged: Record<string, unknown> = { ...fromFile, ...inline };
    const fields = Object.entries(merged).map(([key, raw]) => {
      const cfg = typeof raw === "string" ? { type: raw } : ((raw ?? {}) as Record<string, unknown>);
      return { key, type: "text", ...cfg };
    });

    const stem = nodePath.basename(ctx.inputPaths[0] ?? "input").replace(/\.[^.]*$/, "");
    const tpl = (p: unknown, dflt: string): string =>
      String(p ?? dflt)
        .replace(/\{stem\}/g, stem)
        .replace(/\{name\}/g, nodePath.basename(ctx.inputPaths[0] ?? "input"))
        .replace(/\{i\}/g, "1");

    const out: Record<string, unknown> = { ...params, fields, style: { ...style, ...((params["style"] ?? {}) as object) } };
    out["to"] = tpl(params["to"], "output/form-map.json");
    if (params["debug"]) out["debug_to"] = tpl(params["debug_to"], "output/form-debug.pdf");
    return out;
  }

  /** Resolve a fill_form step's friendly `form`/`people`/`person`/`values` into raw
   *  field instructions (via the core form registry). Returns replacement sidecar
   *  params + a note, or a preview AdapterResult when `preview: true`. */
  private async resolveFillForm(
    params: Record<string, unknown>,
  ): Promise<{ params: Record<string, unknown>; note: string; preview?: AdapterResult }> {
    const formId = String(params["form"]);
    const schema = getFormSchema(formId);
    if (!schema) throw new Error(`unknown form "${formId}" — see the form_list MCP tool or the PDF Fill catalog`);
    const ref = (params["records"] ?? params["people"]) as string | undefined;
    const people = ref ? await this.loadRecords(ref) : {};
    const res = resolveFormFill(schema, {
      values: params["values"] as Record<string, unknown> | undefined,
      people,
      person: params["person"] as string | undefined,
      roles: params["roles"] as Record<string, string> | undefined,
    });
    const meta: string[] = [];
    if (res.unfilledRequired.length) meta.push(`unfilled required: ${res.unfilledRequired.join(", ")}`);
    for (const w of res.warnings) meta.push(w);
    const note = meta.length ? " · " + meta.join(" · ") : "";

    if (params["preview"] || params["dry_run"]) {
      const to = (params["to"] as string) || "output/form-fill-preview.md";
      const lines = [
        `# Fill preview — ${schema.title}`,
        "",
        `**${res.instructions.length} field(s) resolved.** No PDF written (dry run). Remove \`preview: true\` to fill.`,
        "",
        "| field key | value | from |",
        "|---|---|---|",
        ...res.resolved.map((r) => `| ${r.key} | ${String(r.value).replace(/\|/g, "\\|")} | ${r.source} |`),
      ];
      if (res.unfilledRequired.length) lines.push("", `**Unfilled required:** ${res.unfilledRequired.join(", ")}`);
      if (res.warnings.length) lines.push("", `**Warnings:** ${res.warnings.join("; ")}`);
      const bytes = new TextEncoder().encode(lines.join("\n") + "\n");
      return {
        params,
        note,
        preview: { current: null, artifacts: [{ path: to, bytes, kind: "text" }], note: `PREVIEW: ${res.resolved.length} field(s) — no PDF written; see ${to}${note}` },
      };
    }

    const out: Record<string, unknown> = {
      fields: res.instructions,
      source_fields: schema.source.fields.map((f) => f.name),
    };
    if (params["signature"]) out["signature"] = params["signature"];
    if (params["flatten"]) out["flatten"] = params["flatten"];
    return { params: out, note };
  }

  /** Load a records file (people.yaml → its `people:` map) or a records/ directory
   *  (one *.yaml per person; id = filename stem). Relative to the workflow dir. */
  private async loadRecords(ref: string): Promise<RecordMap> {
    // Confine to the workflow dir: the records/people file is workflow-supplied and
    // its YAML values get written into the output PDF, so an absolute/`..` path would
    // be an arbitrary-file-read → exfiltration primitive. confinePath rejects those.
    const abs = confinePath(this.opts.baseDir, ref);
    const st = await stat(abs).catch(() => null);
    if (st?.isDirectory()) {
      const map: RecordMap = {};
      for (const name of await readdir(abs)) {
        if (!/\.ya?ml$/i.test(name)) continue;
        const rec = parseYaml(await readFile(nodePath.join(abs, name), "utf8"));
        if (rec && typeof rec === "object") map[name.replace(/\.ya?ml$/i, "")] = rec as Record<string, unknown>;
      }
      return map;
    }
    const text = await readFile(abs, "utf8");
    // A business keeps its people in a SPREADSHEET, not a YAML file — a vendor list, a staff
    // export, a client table. Accept that directly: one row per record, column headers as the
    // friendly keys the packs already use. Same one-form-per-workflow model, wider door.
    if (/\.csv$/i.test(ref)) return csvToRecords(text);

    const doc = parseYaml(text) as Record<string, unknown> | null;
    const inner = doc?.["people"];
    if (inner && typeof inner === "object") return inner as RecordMap;
    return (doc as RecordMap) ?? {};
  }

  /** Per-op timeout: Marker markdown gets the largest ceiling, other heavy ops a
   *  generous one, everything else the default (undefined → 60s in runSidecar). */
  private timeoutFor(step: PlanStep): number | undefined {
    const p = step.params as Record<string, unknown>;
    const engine = String(p["engine"] ?? "").toLowerCase();
    const mdOp = step.op === "extract_markdown" || step.op === "pdf_to_markdown";
    // Remote Marker (HTTP endpoint or SSH) is resumable + self-budgeting — largest ceiling.
    if (mdOp && (p["endpoint"] || p["remote"])) {
      return Math.max(this.opts.timeoutMs ?? 0, REMOTE_TIMEOUT_MS);
    }
    // Local marker inference or a full force-OCR pre-pass can run for many minutes.
    if (mdOp && (engine === "marker" || engine === "paddleocr-vl" || engine === "mineru" || p["ocr_first"] || String(p["ocr"] ?? "").toLowerCase() === "force")) {
      return Math.max(this.opts.timeoutMs ?? 0, HEAVY_ML_TIMEOUT_MS);
    }
    // split_invoices with a full re-OCR pass or an LLM detector can run for many
    // minutes on a big batch — give it the same ML ceiling as Marker markdown.
    if (step.op === "split_invoices" && (p["ocr_first"] || String(p["detect"] ?? "").toLowerCase() === "ai")) {
      return Math.max(this.opts.timeoutMs ?? 0, HEAVY_ML_TIMEOUT_MS);
    }
    // Receipt extraction is a per-page vision-model HTTP loop — resumable and
    // self-budgeting like remote Marker, so give it the largest ceiling.
    if (step.op === "extract_receipt") return Math.max(this.opts.timeoutMs ?? 0, REMOTE_TIMEOUT_MS);
    // LLM ops (summarize/translate) can take minutes on a local model / long doc.
    if (AI_OPS.has(step.op)) return Math.max(this.opts.timeoutMs ?? 0, HEAVY_ML_TIMEOUT_MS);
    if (HEAVY_OPS.has(step.op)) return Math.max(this.opts.timeoutMs ?? 0, HEAVY_TIMEOUT_MS);
    return undefined;
  }

  private runSidecar(py: PythonCmd, req: unknown, timeoutMs?: number): Promise<SidecarResult> {
    return new Promise((resolve, reject) => {
      let out = "";
      let err = "";
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(py.exe, [...py.args, this.opts.scriptPath], {
          cwd: this.opts.baseDir,
          windowsHide: true,
          // POSIX: put the child in its own process group so a timeout can reap the
          // whole tree (ocrmypdf→ghostscript/tesseract, ssh/scp) via killProcessTree,
          // not just the direct child. Piped stdio + a kept ref mean normal completion
          // is unaffected. No-op on Windows (uses taskkill /T instead).
          detached: process.platform !== "win32",
          // Augment PATH with common tool dirs (e.g. scoop shims) so ocrmypdf can find
          // the tesseract binary the host's PATH may miss. Optional model-backend config
          // (PaddleOCR-VL venv, the extract_receipt VLM endpoint/model) is injected so the
          // sidecar finds them without the user setting env vars by hand.
          env: {
            ...envWithToolPath(),
            ...(this.opts.paddlePython ? { PDFSTUDIO_PADDLE_PYTHON: this.opts.paddlePython } : {}),
            ...(this.opts.vlmEndpoint ? { PDFSTUDIO_VLM_ENDPOINT: this.opts.vlmEndpoint } : {}),
            ...(this.opts.vlmModel ? { PDFSTUDIO_VLM_MODEL: this.opts.vlmModel } : {}),
            // Policy the sidecar enforces itself: url_to_pdf may reach a private /
            // loopback / link-local address, and html_to_pdf may skip sanitizing.
            // Both are off unless the user turned remote render on. It travels as an
            // env var precisely because a workflow cannot set one — the attacker who
            // writes the .opw.yaml must not also be able to grant the permission.
            ...(this.opts.allowRemote ? { PDFSTUDIO_ALLOW_REMOTE: "1" } : {}),
          },
        });
      } catch (e) {
        reject(e as Error);
        return;
      }
      const timer = setTimeout(() => {
        killProcessTree(child);
        reject(new Error("python backend timed out"));
      }, timeoutMs ?? this.opts.timeoutMs ?? 60_000);
      child.stdout?.on("data", (d) => (out += String(d)));
      // Progress arrives as NDJSON on stderr ({"progress":{chunk,of}}). Filter those lines
      // out of `err` (so the failure-detail slice stays a real traceback) and forward them
      // as live progress. Everything else — including tqdm noise from ML libs — stays in err.
      let errLine = "";
      child.stderr?.on("data", (d) => {
        errLine += String(d);
        let nl: number;
        while ((nl = errLine.indexOf("\n")) >= 0) {
          const line = errLine.slice(0, nl);
          errLine = errLine.slice(nl + 1);
          const prog = tryParseProgress(line);
          if (prog) this.opts.onProgress?.(prog);
          else err += line + "\n";
        }
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", () => {
        clearTimeout(timer);
        err += errLine; // flush any trailing partial stderr line
        const parsed = parseLastJsonObject(out) as SidecarResult | null;
        if (parsed) {
          resolve(parsed);
        } else {
          const detail = `${out.trim().slice(-400)}${err ? ` | stderr: ${err.trim().slice(-400)}` : ""}`;
          reject(new Error(`python backend produced no valid result (using ${py.exe} ${py.args.join(" ")}): ${detail}`));
        }
      });
      child.stdin?.write(JSON.stringify(req));
      child.stdin?.end();
    });
  }
}
