// Runs an OPW workflow locally via @pdf-studio/core and reports results.
//
// Validation diagnostics flow into a DiagnosticCollection (the Problems panel);
// the render itself runs under a progress notification. The bundled pdf-lib
// backend handles structural ops with no external dependency; unsatisfied
// capabilities (OCR etc.) are reported, not fatal.

import * as vscode from "vscode";
import * as path from "node:path";
import {
  runWorkflow,
  validateWorkflow,
  nodeFs,
  AdapterRegistry,
  PdfLibAdapter,
  PythonAdapter,
  CliCompressAdapter,
  CliOfficeAdapter,
  CliVideoAdapter,
  type Diagnostic,
  type RunWorkflowResult,
} from "@pdf-studio/core";
import { readWorkflowFile, configuredPythonPath, allowRemoteRender, allowAiRequests, resolvePaddlePython, configuredVlmEndpoint, configuredVlmModel, type WorkflowFile } from "./project.js";
import { track } from "./telemetry.js";
import { RenderLog, PROJECT_LOG_REL } from "./project-log.js";

export class WorkflowRunner {
  private readonly diagnostics: vscode.DiagnosticCollection;
  private readonly extensionUri: vscode.Uri;

  constructor(
    private readonly output: vscode.LogOutputChannel,
    context: vscode.ExtensionContext,
  ) {
    this.diagnostics = vscode.languages.createDiagnosticCollection("pdf-studio");
    this.extensionUri = context.extensionUri;
    context.subscriptions.push(this.diagnostics);
  }

  /** Cache the adapter registry per workflow dir. Each CLI adapter memoizes its
   *  `--version` probe per instance, so reusing the registry across renders
   *  avoids re-spawning Ghostscript/qpdf/LibreOffice probes on every save. */
  private readonly registryCache = new Map<string, AdapterRegistry>();

  /** pdf-lib (bundled) + the opt-in PyMuPDF backend (gated by isAvailable()). */
  private buildRegistry(baseDir: string): AdapterRegistry {
    const cached = this.registryCache.get(baseDir);
    if (cached) return cached;
    const scriptPath = vscode.Uri.joinPath(this.extensionUri, "resources", "python", "pdf_exec.py").fsPath;
    const registry = new AdapterRegistry([
      // cli-compress first so `compress` resolves to Ghostscript/qpdf when
      // available (deep compression), falling back to pdf-lib's re-save.
      new CliCompressAdapter(),
      new PdfLibAdapter(),
      new PythonAdapter({
        configuredPython: configuredPythonPath(),
        scriptPath,
        baseDir,
        allowRemote: allowRemoteRender(),
        allowAi: allowAiRequests(),
        // The paddleocr-vl markdown engine subprocesses into this separate venv.
        paddlePython: resolvePaddlePython(),
        // extract_receipt's vision-language endpoint/model (no env var / restart needed).
        vlmEndpoint: configuredVlmEndpoint(),
        vlmModel: configuredVlmModel(),
        // Live per-chunk progress from long remote Marker runs (otherwise a 30-min job looks hung).
        onProgress: (p) => this.output.appendLine(`  [remote ${p.op ?? "marker"}] chunk ${p.chunk}/${p.of}`),
      }),
      // Optional LibreOffice backend (Office ⇆ PDF); gated by isAvailable().
      new CliOfficeAdapter(),
      // Optional ffmpeg backend (video → PDF); gated by isAvailable().
      new CliVideoAdapter(),
    ]);
    this.registryCache.set(baseDir, registry);
    return registry;
  }

  /** Drop the cached backend probes so a newly-installed tool (or a changed
   *  `pdfStudio.pythonPath`) is re-detected on the next render. */
  resetBackends(): void {
    this.registryCache.clear();
  }

  /** Validate a workflow file and publish diagnostics; return them. */
  async validate(uri: vscode.Uri): Promise<Diagnostic[]> {
    const wf = await readWorkflowFile(uri);
    if (!wf.workflow) {
      this.diagnostics.set(uri, [
        new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 1),
          `OPW parse error: ${wf.parseError}`,
          vscode.DiagnosticSeverity.Error,
        ),
      ]);
      return [];
    }
    const diags = validateWorkflow(wf.workflow);
    this.publish(uri, diags);
    return diags;
  }

  /** Render a workflow file to its output. Shows progress + surfaces notes. */
  async run(uri: vscode.Uri): Promise<RunWorkflowResult | undefined> {
    const wf = await readWorkflowFile(uri);
    if (!wf.workflow) {
      void vscode.window.showErrorMessage(`PDF Studio: cannot parse ${wf.relPath}: ${wf.parseError}`);
      return undefined;
    }
    const diags = validateWorkflow(wf.workflow);
    this.publish(uri, diags);
    if (diags.some((d) => d.severity === "error")) {
      void vscode.window.showErrorMessage(
        `PDF Studio: ${wf.relPath} has validation errors — see the Problems panel.`,
      );
      return undefined;
    }

    this.output.info(`rendering ${wf.relPath} …`);
    const startedAt = Date.now();
    const log = new RenderLog(wf.baseDir, wf.relPath);
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Rendering ${wf.relPath}…`, cancellable: false },
      async (progress) => {
        try {
          const result = await runWorkflow(wf.workflow!, {
            baseDir: wf.baseDir,
            fs: nodeFs(wf.baseDir),
            registry: this.buildRegistry(wf.baseDir),
            onStep: (s) => {
              this.output.appendLine(`  [${s.index + 1}] ${s.op}${s.note ? ` — ${s.note}` : ""}`);
              log.step(s.index, s.op, s.note);
            },
            onBatchItem: (i, total, input) => {
              progress.report({ message: `file ${i + 1}/${total}: ${path.basename(input)}` });
              this.output.appendLine(`  [batch ${i + 1}/${total}] ${input}`);
            },
          });
          this.logResult(wf, result);
          for (const r of result.rewrites) log.line(`  optimizer: ${r.message}`);
          for (const u of result.plan.unsatisfied) log.line(`  unsatisfied: ${u.op} — ${u.reason}`);
          log.ok(result.output, result.artifacts.length);
          track("workflow_rendered", { ops: wf.workflow!.operations.length, ok: Boolean(result.output) });
          // Per-operation usage — the direct signal for "which operations do
          // users actually run most", so high-use ops can be prioritized. Anon:
          // only the op NAME (never params/paths). One event per op per render.
          for (const op of wf.workflow!.operations) track("operation_used", { op: op.name });
          this.output.info(`done ${wf.relPath} in ${Date.now() - startedAt}ms`);
          if (result.batch) {
            // Batch: N inputs → N outputs. Offer to reveal the destination folder.
            const failed = result.batch.filter((b) => b.error).length;
            const summary = failed ? `${result.outputs.length} file(s), ${failed} failed` : `${result.outputs.length} file(s)`;
            const dest = wf.workflow?.output?.folder ?? (result.outputs[0] ? path.dirname(result.outputs[0]) : "output");
            const reveal = "Reveal Folder";
            void vscode.window.showInformationMessage(`PDF Studio: batch rendered ${summary}`, reveal).then((choice) => {
              if (choice === reveal) void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(path.resolve(wf.baseDir, dest)));
            });
          } else if (result.output) {
            // A folder output (e.g. split_invoices) can't be "previewed" as a PDF —
            // offer to reveal it in the OS file explorer instead.
            const isFolder = Boolean(wf.workflow?.output?.folder);
            const action = isFolder ? "Reveal Folder" : "Open Preview";
            void vscode.window
              .showInformationMessage(`PDF Studio: rendered ${result.output}`, action)
              .then((choice) => {
                if (choice !== action) return;
                if (isFolder) {
                  const abs = vscode.Uri.file(path.resolve(wf.baseDir, result.output!));
                  void vscode.commands.executeCommand("revealFileInOS", abs);
                } else {
                  void vscode.commands.executeCommand("pdfStudio.openPreview", uri);
                }
              });
          }
          return result;
        } catch (err) {
          const msg = (err as Error).message;
          this.output.error(`render failed (${wf.relPath}): ${(err as Error).stack ?? String(err)}`);
          log.fail(msg);
          const openLog = "Open Log";
          void vscode.window
            .showErrorMessage(`PDF Studio: render failed — ${msg}. See ${PROJECT_LOG_REL}.`, openLog)
            .then((choice) => {
              if (choice === openLog) void vscode.commands.executeCommand("pdfStudio.openProjectLog");
            });
          return undefined;
        }
      },
    );
  }

  private logResult(wf: WorkflowFile, result: RunWorkflowResult): void {
    this.output.info(`rendered ${wf.relPath}`);
    for (const r of result.rewrites) this.output.appendLine(`  optimizer: ${r.message}`);
    if (result.plan.unsatisfied.length) {
      this.output.appendLine("  unsatisfied capabilities (install a backend to enable):");
      for (const u of result.plan.unsatisfied) this.output.appendLine(`    - ${u.op}: ${u.reason}`);
    }
    if (result.batch) {
      for (const b of result.batch) {
        this.output.appendLine(b.error ? `  ✗ ${b.input} — ${b.error}` : `  → ${b.output} (from ${b.input})`);
      }
    } else if (result.output) {
      this.output.appendLine(`  → ${result.output}`);
    }
    for (const a of result.artifacts) this.output.appendLine(`  → ${a}`);
  }

  private publish(uri: vscode.Uri, diags: Diagnostic[]): void {
    const vsDiags = diags.map((d) => {
      const sev = d.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
      const diag = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), `[${d.code}] ${d.message}`, sev);
      diag.source = "pdf-studio";
      return diag;
    });
    this.diagnostics.set(uri, vsDiags);
  }
}
