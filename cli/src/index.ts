// opw — the OpenPDF Workflow CLI.
//
// Runs the SAME @pdf-studio/core engine the VS Code extension uses, with no editor:
// render / validate / compile a .opw.yaml, list the operation vocabulary, and probe
// backends (doctor). Built for CI, cron, and headless servers.
//
// Dependency model (mirrors the extension, minus the GUI):
//   - bundled pdf-lib backend → zero install (structural ops always work).
//   - Python/PyMuPDF + LibreOffice/Chrome/qpdf/Ghostscript/Tesseract → the user/CI
//     installs them; the CLI FINDS them (--python / $PDFSTUDIO_PYTHON / PATH) and
//     degrades gracefully — unsatisfied ops are reported by `compile`, never crash.
//   - The pdf_exec.py sidecar ships WITH the CLI (dist/python/pdf_exec.py), passed
//     as scriptPath — no user install for the script itself.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  VERSION as CORE_VERSION,
  parseWorkflow,
  OpwParseError,
  validateWorkflow,
  hasErrors,
  compileWorkflow,
  describePlan,
  runWorkflow,
  nodeFs,
  AdapterRegistry,
  PdfLibAdapter,
  PythonAdapter,
  CliCompressAdapter,
  CliOfficeAdapter,
  checkDependencies,
  OPERATIONS,
  OP_CATEGORIES,
  type Diagnostic,
} from "@pdf-studio/core";

// Resolved relative to the bundle (dist/index.cjs) → dist/python/pdf_exec.py.
// __dirname is provided by the CJS bundle esbuild emits (package is CommonJS).
const SCRIPT_PATH = path.join(__dirname, "python", "pdf_exec.py");

const CLI_VERSION = "0.1.0";

interface GlobalOpts {
  python?: string;
  allowAi: boolean;
  allowRemote: boolean;
  json: boolean;
}

/** A env-var truthy check for the boolean toggles. */
const envOn = (name: string): boolean => {
  const v = process.env[name];
  return v === "1" || v === "true" || v === "yes";
};

/** Split argv into a positional list and the global flags we understand. */
function parseArgs(argv: string[]): { positionals: string[]; opts: GlobalOpts } {
  const positionals: string[] = [];
  const opts: GlobalOpts = {
    python: process.env["PDFSTUDIO_PYTHON"] || undefined,
    allowAi: envOn("PDFSTUDIO_ALLOW_AI"),
    allowRemote: envOn("PDFSTUDIO_ALLOW_REMOTE"),
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--python" || a === "-p") opts.python = argv[++i];
    else if (a.startsWith("--python=")) opts.python = a.slice("--python=".length);
    else if (a === "--allow-ai") opts.allowAi = true;
    else if (a === "--allow-remote") opts.allowRemote = true;
    else if (a === "--json") opts.json = true;
    else positionals.push(a);
  }
  return { positionals, opts };
}

/** pdf-lib (bundled) + the opt-in PyMuPDF/CLI backends — mirrors the extension runner. */
function buildRegistry(baseDir: string, opts: GlobalOpts): AdapterRegistry {
  return new AdapterRegistry([
    new CliCompressAdapter(), // deep compress via qpdf/Ghostscript when present
    new PdfLibAdapter(), // always available, zero install
    new PythonAdapter({
      configuredPython: opts.python,
      scriptPath: SCRIPT_PATH,
      baseDir,
      allowRemote: opts.allowRemote,
      allowAi: opts.allowAi,
      paddlePython: process.env["PDFSTUDIO_PADDLE_PYTHON"],
      vlmEndpoint: process.env["PDFSTUDIO_VLM_ENDPOINT"],
      vlmModel: process.env["PDFSTUDIO_VLM_MODEL"],
    }),
    new CliOfficeAdapter(), // Office ⇆ PDF via LibreOffice when present
  ]);
}

const err = (msg: string): void => {
  process.stderr.write(`opw: ${msg}\n`);
};
const out = (msg = ""): void => {
  process.stdout.write(`${msg}\n`);
};

/** Read + parse a workflow file; exits(1) with a clear message on parse failure. */
function loadWorkflow(file: string): { wf: ReturnType<typeof parseWorkflow>; baseDir: string } {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    err(`workflow not found: ${file}`);
    process.exit(1);
  }
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch (e) {
    err(`cannot read ${file}: ${(e as Error).message}`);
    process.exit(1);
  }
  try {
    return { wf: parseWorkflow(text), baseDir: path.dirname(abs) };
  } catch (e) {
    if (e instanceof OpwParseError) err(`parse error in ${file}: ${e.message}`);
    else err(`parse error in ${file}: ${(e as Error).message}`);
    process.exit(1);
  }
}

function printDiagnostics(diags: Diagnostic[]): void {
  for (const d of diags) {
    const tag = d.severity === "error" ? "ERROR" : "warn ";
    (d.severity === "error" ? process.stderr : process.stdout).write(`  ${tag} [${d.code}] ${d.message}\n`);
  }
}

// ---------------------------------------------------------------- commands ----

async function cmdValidate(file: string | undefined): Promise<number> {
  if (!file) return usageError("validate <workflow.opw.yaml>");
  const { wf } = loadWorkflow(file);
  const diags = validateWorkflow(wf);
  if (diags.length === 0) {
    out(`✓ ${file} is valid`);
    return 0;
  }
  printDiagnostics(diags);
  const errs = diags.filter((d) => d.severity === "error").length;
  if (errs) {
    err(`${errs} error(s)`);
    return 1;
  }
  out(`✓ ${file} valid (${diags.length} warning(s))`);
  return 0;
}

async function cmdCompile(file: string | undefined, opts: GlobalOpts): Promise<number> {
  if (!file) return usageError("compile <workflow.opw.yaml>");
  const { wf, baseDir } = loadWorkflow(file);
  const diags = validateWorkflow(wf);
  if (hasErrors(diags)) {
    printDiagnostics(diags);
    return 1;
  }
  const plan = compileWorkflow(wf, { registry: buildRegistry(baseDir, opts) });
  if (opts.json) {
    out(JSON.stringify(plan, null, 2));
    return 0;
  }
  out(describePlan(plan));
  if (plan.unsatisfied.length) {
    out("");
    out("Unsatisfied (install a backend to enable):");
    for (const u of plan.unsatisfied) out(`  - ${u.op}: ${u.reason}`);
  }
  return 0;
}

async function cmdRender(file: string | undefined, opts: GlobalOpts): Promise<number> {
  if (!file) return usageError("render <workflow.opw.yaml>");
  const { wf, baseDir } = loadWorkflow(file);
  const diags = validateWorkflow(wf);
  printDiagnostics(diags);
  if (hasErrors(diags)) {
    err("validation failed — not rendering");
    return 1;
  }
  try {
    const result = await runWorkflow(wf, {
      baseDir,
      fs: nodeFs(baseDir),
      registry: buildRegistry(baseDir, opts),
      onStep: (s) => out(`  [${s.index + 1}] ${s.op}${s.note ? ` — ${s.note}` : ""}`),
      onBatchItem: (i, total, input) => out(`  [batch ${i + 1}/${total}] ${path.basename(input)}`),
    });
    for (const r of result.rewrites) out(`  optimizer: ${r.message}`);
    for (const u of result.plan.unsatisfied) out(`  unsatisfied: ${u.op} — ${u.reason}`);
    if (result.batch) {
      const failed = result.batch.filter((b) => b.error).length;
      for (const b of result.batch) out(b.error ? `  ✗ ${b.input} — ${b.error}` : `  → ${b.output}`);
      out(`Rendered ${result.outputs.length} file(s)${failed ? `, ${failed} failed` : ""}.`);
      return failed ? 1 : 0;
    }
    if (result.output) out(`→ ${result.output}`);
    for (const a of result.artifacts) out(`→ ${a}`);
    out("Done.");
    return 0;
  } catch (e) {
    err(`render failed: ${(e as Error).message}`);
    return 1;
  }
}

function cmdOps(opts: GlobalOpts): number {
  if (opts.json) {
    out(JSON.stringify(Object.values(OPERATIONS), null, 2));
    return 0;
  }
  const total = Object.keys(OPERATIONS).length;
  out(`${total} operations across ${OP_CATEGORIES.length} categories:`);
  for (const cat of OP_CATEGORIES) {
    out("");
    out(cat.title);
    for (const name of cat.ops) {
      const spec = OPERATIONS[name as keyof typeof OPERATIONS];
      if (spec) out(`  ${name.padEnd(22)} ${spec.summary}`);
    }
  }
  return 0;
}

async function cmdDoctor(opts: GlobalOpts): Promise<number> {
  const deps = await checkDependencies({
    pythonPath: opts.python,
    paddlePythonPath: process.env["PDFSTUDIO_PADDLE_PYTHON"],
    vlmEndpoint: process.env["PDFSTUDIO_VLM_ENDPOINT"],
  });
  if (opts.json) {
    out(JSON.stringify(deps, null, 2));
    return 0;
  }
  for (const d of deps) {
    const mark = d.state === "available" ? "✓" : d.state === "missing" ? "•" : "✗";
    out(`${mark} ${d.label.padEnd(30)} ${d.detail}`);
    if (d.state !== "available" && d.installHint) out(`    install: ${d.installHint}`);
  }
  const missing = deps.filter((d) => d.state === "missing").length;
  out("");
  out(`${deps.filter((d) => d.state === "available").length}/${deps.length} available` + (missing ? ` · ${missing} optional backend(s) not installed` : ""));
  return 0;
}

// ------------------------------------------------------------------ usage -----

function printHelp(): void {
  out(`opw — OpenPDF Workflow CLI (core ${CORE_VERSION})

Usage:
  opw render   <workflow.opw.yaml>   Validate then render the workflow to its output
  opw validate <workflow.opw.yaml>   Structural diagnostics (exit 1 on errors)
  opw compile  <workflow.opw.yaml>   Show the execution plan + unsatisfied backends
  opw ops                            List the operation vocabulary
  opw doctor                         Probe backends (Python/LibreOffice/qpdf/…)

Options:
  -p, --python <path>   Python interpreter for the PyMuPDF backend
                        (else $PDFSTUDIO_PYTHON, else auto-detect on PATH)
      --allow-ai        Permit AI ops (summarize/translate) to call a model
      --allow-remote    Permit ops with a remote: param to offload over SSH
      --json            Machine-readable output (compile / ops / doctor)
  -v, --version         Print version
  -h, --help            This help

The bundled pdf-lib backend needs nothing installed; heavier ops light up when
their backend is present — run "opw doctor" to see what's available.`);
}

function usageError(usage: string): number {
  err(`usage: opw ${usage}`);
  return 1;
}

async function main(): Promise<number> {
  const raw = process.argv.slice(2);
  if (raw.length === 0 || raw[0] === "-h" || raw[0] === "--help" || raw[0] === "help") {
    printHelp();
    return 0;
  }
  if (raw[0] === "-v" || raw[0] === "--version" || raw[0] === "version") {
    out(`opw ${CLI_VERSION} (core ${CORE_VERSION})`);
    return 0;
  }
  const [command, ...rest] = raw;
  const { positionals, opts } = parseArgs(rest);
  switch (command) {
    case "render":
      return cmdRender(positionals[0], opts);
    case "validate":
      return cmdValidate(positionals[0]);
    case "compile":
      return cmdCompile(positionals[0], opts);
    case "ops":
      return cmdOps(opts);
    case "doctor":
      return cmdDoctor(opts);
    default:
      err(`unknown command: ${command}`);
      printHelp();
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    err((e as Error).stack ?? String(e));
    process.exit(1);
  });
