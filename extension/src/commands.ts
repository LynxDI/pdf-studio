// Command registration — the extension's action surface.

import * as vscode from "vscode";
import {
  parseWorkflow,
  serializeWorkflow,
  optimizeWorkflow,
  compileWorkflow,
  describePlan,
  defaultRegistry,
  OPERATIONS,
  resolvePythonWithPyMuPDF,
  resolvePythonWithMarkitdown,
  PythonAdapter,
  installCommand,
  type ExecContext,
  type PlanStep,
  type DependencyStatus,
} from "@pdf-studio/core";
import { findWorkflowFiles, outputPath, readWorkflowFile, workspaceRoot, configuredPythonPath, resolvePaddlePython, paddleVenvPython } from "./project.js";
import { matchesWorkflow, workflowSummary } from "./workflow-search.js";
import { WorkflowRunner } from "./workflow-runner.js";
import { PdfStudioExplorer } from "./sidebar/explorer-provider.js";
import { PreviewPanel } from "./preview-panel.js";
import { initProject } from "./project-init.js";
import { downloadExamples } from "./examples.js";
import { writeAgentMap } from "./agents/agent-map.js";
import { MCP_TOOLS, renderToolDoc, renderOverviewDoc } from "./sidebar/mcp-tools.js";
import { renderOpReference, renderFormDoc, getFormSchema, blankPeople, buildExampleWorkflow } from "@pdf-studio/core";
import { OpDocView } from "./op-doc-view.js";
import { insertOperation, insertOperationAt, opChangesPagination, pageSafeInsertIndex, removeOperationAt } from "@pdf-studio/core";
import { collectParams } from "./param-form.js";
import { inspectPdfDeep } from "./python-inspect.js";
import { convertToMarkdown } from "./markitdown-convert.js";
import { projectLogPath } from "./project-log.js";
import { track } from "./telemetry.js";
import { stageMcpServerInProject, writeMcpJson } from "./mcp-setup.js";
import * as path from "node:path";
import * as fs from "node:fs";
import * as cp from "node:child_process";

export interface CommandDeps {
  context: vscode.ExtensionContext;
  output: vscode.LogOutputChannel;
  runner: WorkflowRunner;
  explorer: PdfStudioExplorer;
  extensionVersion: string;
}

/** Spawn a command and stream stdout/stderr to the output channel; reject on non-zero exit
 *  or timeout. `shell: true` runs a full command string (system installers); a `timeoutMs`
 *  guards against a step hanging (e.g. a UAC prompt) so the caller can fall back. */
function runStreamed(
  cmd: string,
  args: string[],
  output: vscode.LogOutputChannel,
  opts: { shell?: boolean; timeoutMs?: number } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(cmd, args, { windowsHide: true, shell: opts.shell });
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        reject(new Error(`timed out after ${Math.round(opts.timeoutMs! / 1000)}s`));
      }, opts.timeoutMs);
    }
    const onData = (d: Buffer) => output.append(d.toString());
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`\`${cmd} ${args.join(" ")}\` exited ${code}`));
    });
  });
}

/** Auto-run `run()`; on any failure/timeout, open a terminal with `displayCmd` so the user
 *  can finish it (e.g. approve a UAC prompt). Returns true when the auto-run succeeded. */
async function autoRun(displayCmd: string, run: () => Promise<void>, output: vscode.LogOutputChannel): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (e) {
    output.appendLine(`[setup] auto-run failed (${(e as Error).message}); opening a terminal to finish.`);
    const term = vscode.window.createTerminal("Lynx PDF Studio setup");
    term.show();
    term.sendText(displayCmd);
    return false;
  }
}

/** Is a command runnable (responds to --version)? Quiet — used to skip already-installed tools. */
function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = cp.spawn(cmd, ["--version"], { windowsHide: true, shell: process.platform === "win32" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/** The base Python interpreter for pip installs into the main backend venv. */
function basePython(configured: string | undefined): [string, string[]] {
  if (configured) return [configured, []];
  return process.platform === "win32" ? ["py", ["-3"]] : ["python3", []];
}

/** Resolve the Ollama binary (winget/installer may not have refreshed this process's PATH). */
function ollamaExe(): string {
  if (process.platform === "win32") {
    const p = path.join(process.env["LOCALAPPDATA"] ?? "", "Programs", "Ollama", "ollama.exe");
    if (fs.existsSync(p)) return p;
  }
  return "ollama";
}

export function registerCommands(deps: CommandDeps): void {
  const { context, output, runner, explorer, extensionVersion } = deps;
  // Wrap every command so we learn which FEATURES get used most: each real
  // (non-internal) command fires an anonymous `feature_used` event with the
  // command id. Consent-gated in telemetry.ts; no args/paths are ever sent.
  const reg = (id: string, fn: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, (...args: unknown[]) => {
        if (!id.startsWith("pdfStudio._")) track("feature_used", { feature: id.replace(/^pdfStudio\./, "") });
        return fn(...args);
      }),
    );

  // Single reusable webview for an operation's doc page (usage, params, example + Copy button).
  const opDocView = new OpDocView(context.extensionUri);

  reg("pdfStudio.showLogs", () => output.show());

  // Open this extension's settings (gear icon in the view header) — scoped to the
  // pdfStudio.* settings so users land directly on them.
  reg("pdfStudio.openSettings", () =>
    vscode.commands.executeCommand("workbench.action.openSettings", "@ext:lynxdi.lynxdi-pdf-studio"),
  );

  // Open the persistent per-project render log (.lynx-pdf-studio/pdf-studio.log).
  reg("pdfStudio.openProjectLog", async () => {
    const root = workspaceRoot();
    if (!root) {
      void vscode.window.showInformationMessage("Lynx PDF Studio: open a project folder first.");
      return;
    }
    const logPath = projectLogPath(root);
    if (!fs.existsSync(logPath)) {
      void vscode.window.showInformationMessage("Lynx PDF Studio: no render log yet — render a workflow first.");
      return;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(logPath));
    await vscode.window.showTextDocument(doc, { preview: true });
  });

  // Open an http(s) / mailto link in the browser or mail client (Support links).
  reg("pdfStudio.openExternal", (arg) => {
    const url = typeof arg === "string" ? arg : undefined;
    if (url) void vscode.env.openExternal(vscode.Uri.parse(url));
  });

  // Internal (not contributed to the palette): lets the integration harness read
  // the webview's actual render outcome, so the pdf.js worker path is verified
  // end-to-end in a live VS Code.
  reg("pdfStudio._previewRenderStatus", () => PreviewPanel.getLastRenderStatus());

  // Internal: drive the apply-operation path without the interactive quick-pick,
  // so the harness can verify it end-to-end.
  reg("pdfStudio._applyOperation", async (uriStr, opName, params) => {
    await rewriteWorkflow(vscode.Uri.file(String(uriStr)), (raw) =>
      insertOperation(raw, String(opName), String(params ?? "{}")),
    );
  });

  // Internal: render a workflow and return its result (output/artifacts/notes),
  // so the harness can assert on what actually ran without file-timing races.
  reg("pdfStudio._renderAndReport", async (uriStr) => {
    const uri = vscode.Uri.file(String(uriStr));
    const res = await runner.run(uri);
    if (res) return { ok: true, output: res.output, artifacts: res.artifacts, notes: res.notes };
    const diags = await runner.validate(uri);
    return { ok: false, diagnostics: diags.map((d) => `[${d.severity}] ${d.code}: ${d.message}`) };
  });

  // Internal: run the PyMuPDF deep-inspection sidecar (returns null when PyMuPDF
  // is unavailable), so the harness can verify the object-map wiring.
  reg("pdfStudio._inspectDeep", async (pdfPath) => {
    const script = vscode.Uri.joinPath(context.extensionUri, "resources", "python", "pdf_inspect.py").fsPath;
    const python = await resolvePythonWithPyMuPDF(configuredPythonPath());
    if (!python) return null;
    return inspectPdfDeep({ pdfPath: String(pdfPath), scriptPath: script, python });
  });

  // --- MCP Tools discoverability + setup ---
  reg("pdfStudio.showMcpTools", () => openMarkdown(renderOverviewDoc()));
  reg("pdfStudio.setupMcp", async () => {
    const root = workspaceRoot();
    if (!root) {
      void vscode.window.showInformationMessage("PDF Studio: open a folder first, then set up the MCP server.");
      return;
    }
    const rel = await stageMcpServerInProject(root, context.extensionUri);
    if (!rel) {
      void vscode.window.showErrorMessage("PDF Studio: could not stage the MCP server. See the logs.");
      return;
    }
    let file: string;
    try {
      file = await writeMcpJson(root, rel);
    } catch (e) {
      void vscode.window.showErrorMessage(`Lynx PDF Studio: ${(e as Error).message}`);
      return;
    }
    output.info(`[mcp] wrote ${file} + ${rel} (self-contained in the project)`);
    void vscode.window.showInformationMessage(
      `Lynx PDF Studio: wrote ${path.basename(file)} + ${rel} — your coding agent can now call the OPW tools (reload the agent/MCP if needed).`,
    );
  });
  reg("pdfStudio.showMcpTool", async (arg) => {
    const name = typeof arg === "string" ? arg : undefined;
    const tool = MCP_TOOLS.find((t) => t.name === name);
    await openMarkdown(tool ? renderToolDoc(tool) : renderOverviewDoc());
  });

  // --- Operation documentation (sidebar "Documentation" node) ---
  reg("pdfStudio.showOpReference", () => openMarkdown(renderOpReference()));
  reg("pdfStudio.showOpDoc", async (arg) => {
    const op = typeof arg === "string" ? arg : (arg as { op?: string } | undefined)?.op;
    // A specific op → the webview doc page (with a Copy button on the example); no op → the
    // full Markdown reference.
    if (op) opDocView.show(op);
    else await openMarkdown(renderOpReference());
  });
  // Copy a ready-to-run example workflow for an operation to the clipboard (Operations panel ⧉).
  reg("pdfStudio.copyOpExample", async (arg) => {
    const op = typeof arg === "string" ? arg : (arg as { op?: string } | undefined)?.op;
    if (!op || !OPERATIONS[op]) {
      void vscode.window.showInformationMessage(`PDF Studio: unknown operation "${String(op)}".`);
      return;
    }
    await vscode.env.clipboard.writeText(buildExampleWorkflow(op) + "\n");
    void vscode.window.showInformationMessage(`Copied an example \`${op}\` workflow to the clipboard.`);
  });

  // --- PDF Fill catalog: open a form's doc (fields + copy-paste workflow) ---
  reg("pdfStudio.showFormDoc", async (arg) => {
    const id = typeof arg === "string" ? arg : (arg as { form?: string } | undefined)?.form;
    const schema = id ? getFormSchema(id) : undefined;
    if (!schema) {
      void vscode.window.showInformationMessage(`PDF Studio: unknown form "${String(id)}".`);
      return;
    }
    track("form_doc_opened", { op: schema.id });
    await openMarkdown(renderFormDoc(schema));
  });

  // Create the local, gitignored people.yaml records file (fill_form draws from it).
  reg("pdfStudio.initPeople", async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showInformationMessage("PDF Studio: open a folder first.");
      return;
    }
    const peopleUri = vscode.Uri.joinPath(folder.uri, "people.yaml");
    let exists = true;
    try {
      await vscode.workspace.fs.stat(peopleUri);
    } catch {
      exists = false;
    }
    if (!exists) await vscode.workspace.fs.writeFile(peopleUri, new TextEncoder().encode(blankPeople()));

    // Auto-gitignore: PII must never be committed.
    const giUri = vscode.Uri.joinPath(folder.uri, ".gitignore");
    let gi = "";
    try {
      gi = new TextDecoder().decode(await vscode.workspace.fs.readFile(giUri));
    } catch {
      /* no .gitignore yet */
    }
    const lines = gi.split(/\r?\n/);
    const toAdd = ["people.yaml", "*.people.yaml"].filter((p) => !lines.includes(p));
    if (toAdd.length) {
      const prefix = gi && !gi.endsWith("\n") ? "\n" : "";
      const block = `${prefix}\n# PDF Studio — local records (PII), never commit\n${toAdd.join("\n")}\n`;
      await vscode.workspace.fs.writeFile(giUri, new TextEncoder().encode(gi + block));
    }
    const doc = await vscode.workspace.openTextDocument(peopleUri);
    await vscode.window.showTextDocument(doc);
    void vscode.window.showInformationMessage(
      exists
        ? "people.yaml already exists — opened. It's gitignored; keep your PII local."
        : "Created people.yaml (gitignored). Fill in your details, then use fill_form to fill any form.",
    );
  });

  // --- Apply / remove operations from the UI (edit the .opw.yaml for the user) ---
  reg("pdfStudio.addOperation", async (arg) => {
    const uri = await targetWorkflowUri(arg);
    if (!uri) {
      void vscode.window.showInformationMessage("PDF Studio: open or select a workflow first.");
      return;
    }
    const items = Object.values(OPERATIONS).map((s) => ({
      label: s.name,
      description: s.capability,
      detail: s.summary,
    }));
    const pick = await vscode.window.showQuickPick(items, {
      title: "Add operation",
      placeHolder: "Choose an OPW operation to apply",
      matchOnDetail: true,
    });
    if (!pick) return;
    const params = await collectParams(pick.label);
    if (params === undefined) return; // cancelled
    await rewriteWorkflow(uri, (raw) => insertOperation(raw, pick.label, params));
    track("operation_added", { op: pick.label });
    output.info(`added operation "${pick.label}" to ${path.basename(uri.fsPath)}`);
  });

  // Add a specific operation by name (from the MCP Tools panel): resolve the
  // active/only workflow, prompt for params pre-filled with the example, insert.
  reg("pdfStudio.addNamedOperation", async (arg) => {
    const opName = typeof arg === "string" ? arg : undefined;
    if (!opName || !Object.hasOwn(OPERATIONS, opName)) return;
    const uri = await targetWorkflowUri(undefined);
    if (!uri) {
      void vscode.window.showInformationMessage("PDF Studio: no workflow found — run Initialize Project first.");
      return;
    }
    const params = await collectParams(opName);
    if (params === undefined) return;
    await rewriteWorkflow(uri, (raw) => insertOperation(raw, opName, params));
    track("operation_added", { op: opName });
    output.info(`added operation "${opName}" to ${path.basename(uri.fsPath)}`);
  });

  reg("pdfStudio.deleteOperation", async (arg) => {
    const node = arg as { wfUri?: vscode.Uri; opIndex?: number; label?: string } | undefined;
    if (!node?.wfUri || node.opIndex === undefined) return;
    await rewriteWorkflow(node.wfUri, (raw) => removeOperationAt(raw, node.opIndex!));
    output.info(`removed operation #${node.opIndex + 1} from ${path.basename(node.wfUri.fsPath)}`);
  });

  // Page-targeted operations: picking a page in the object tree offers only the
  // operations valid for a page, with the page number pre-filled — so the user
  // never guesses which target an option applies to.
  reg("pdfStudio.applyToPage", async (arg) => {
    const node = arg as { wfUri?: vscode.Uri; pageNumber?: number } | undefined;
    if (!node?.wfUri || node.pageNumber === undefined) return;
    const n = node.pageNumber;
    type PageChoice = vscode.QuickPickItem & {
      op?: string;
      params?: string;
      prompt?: "watermark" | "replace_image" | "stamp" | "crop" | "move" | "swap";
      more?: boolean;
      /** Params carry no page number — safe to append at the end. */
      wholeDoc?: boolean;
    };
    const choices: PageChoice[] = [
      { label: "$(debug-step-over) Rotate 90°", detail: "rotate_pages", op: "rotate_pages", params: `{ pages: [${n}], degrees: 90 }` },
      { label: "$(debug-step-over) Rotate 180°", detail: "rotate_pages", op: "rotate_pages", params: `{ pages: [${n}], degrees: 180 }` },
      { label: "$(debug-step-over) Rotate 270°", detail: "rotate_pages", op: "rotate_pages", params: `{ pages: [${n}], degrees: 270 }` },
      { label: "$(arrow-both) Move this page…", detail: "move_pages", op: "move_pages", prompt: "move" },
      { label: "$(arrow-swap) Swap this page with…", detail: "swap_pages", op: "swap_pages", prompt: "swap" },
      { label: "$(trash) Delete this page", detail: "delete_pages", op: "delete_pages", params: `{ pages: [${n}] }` },
      { label: "$(list-selection) Keep only this page", detail: "extract_pages", op: "extract_pages", params: `{ pages: [${n}] }` },
      { label: "$(screen-normal) Crop this page…", detail: "crop", op: "crop", prompt: "crop" },
      { label: "$(text-size) Watermark this page…", detail: "watermark", op: "watermark", prompt: "watermark" },
      { label: "$(symbol-string) Stamp text on this page…", detail: "stamp", op: "stamp", prompt: "stamp" },
      { label: "$(law) Redact a region on this page", detail: "redact", op: "redact", params: `{ page: ${n}, rects: [[72, 72, 200, 100]] }` },
      { label: "$(edit) Annotate this page (highlight / note / shape)…", detail: "annotate", op: "annotate", params: `{ annotations: [{ type: highlight, page: ${n}, find: "TODO" }] }` },
      { label: "$(replace) Replace an image on this page…", detail: "replace_image", op: "replace_image", prompt: "replace_image" },
      // Whole-document ops carry no page number, so they append (running them
      // early would extract from the input rather than the finished document).
      { label: "$(export) Extract all images (whole document)", detail: "extract_images", op: "extract_images", params: "{ to: output/images }", wholeDoc: true },
      { label: "$(file-text) Extract text (whole document)", detail: "extract_text", op: "extract_text", params: "{ to: output/text.txt }", wholeDoc: true },
      { label: "$(ellipsis) More operations…", detail: "browse all operations", more: true },
    ];
    const pick = await vscode.window.showQuickPick(choices, {
      title: `Page ${n} — apply operation`,
      placeHolder: "Choose an operation (writes it into the workflow)",
      matchOnDetail: true,
    });
    if (!pick) return;
    if (pick.more) {
      await vscode.commands.executeCommand("pdfStudio.addOperation", node);
      return;
    }
    const op = pick.op;
    if (!op) return;

    let params = pick.params ?? "{}";
    if (pick.prompt === "watermark") {
      const text = await vscode.window.showInputBox({ title: `Watermark page ${n}`, prompt: "Watermark text", value: "DRAFT" });
      if (text === undefined) return;
      params = `{ text: ${text}, pages: [${n}], opacity: 0.15 }`;
    } else if (pick.prompt === "stamp") {
      const text = await vscode.window.showInputBox({ title: `Stamp page ${n}`, prompt: "Stamp text", value: "APPROVED" });
      if (text === undefined) return;
      params = `{ text: ${text}, x: 72, y: 72, pages: [${n}] }`;
    } else if (pick.prompt === "crop") {
      const box = await vscode.window.showInputBox({
        title: `Crop page ${n}`,
        prompt: "Crop box [x, y, width, height] in points (origin bottom-left)",
        value: "[0, 0, 400, 600]",
      });
      if (box === undefined) return;
      params = `{ box: ${box}, pages: [${n}] }`;
    } else if (pick.prompt === "move") {
      // `after` is numbered in the ORIGINAL document, so the user answers with a
      // page they can still see in the object map — no mid-edit arithmetic.
      const dest = await vscode.window.showInputBox({
        title: `Move page ${n}`,
        prompt: "Put it after which page? (0 = the very start)",
        value: "0",
        validateInput: (v) => {
          const d = Number(v.trim());
          if (!Number.isInteger(d) || d < 0) return "enter a page number, or 0 for the start";
          return d === n ? `page ${n} is the page being moved — pick a page that stays put` : undefined;
        },
      });
      if (dest === undefined) return;
      params = `{ pages: [${n}], after: ${Number(dest.trim())} }`;
    } else if (pick.prompt === "swap") {
      const other = await vscode.window.showInputBox({
        title: `Swap page ${n}`,
        prompt: "Exchange it with which page?",
        validateInput: (v) => {
          const d = Number(v.trim());
          if (!Number.isInteger(d) || d < 1) return "enter a 1-based page number";
          return d === n ? "that's the same page — pick a different one" : undefined;
        },
      });
      if (other === undefined) return;
      params = `{ a: ${n}, b: ${Number(other.trim())} }`;
    } else if (pick.prompt === "replace_image") {
      const name = await vscode.window.showInputBox({
        title: `Replace image on page ${n}`,
        prompt: "Image object name (expand the page in the object map to see names)",
        value: "Im0",
      });
      if (name === undefined) return;
      const img = await vscode.window.showInputBox({ title: "Replacement image", prompt: "Path relative to the workflow", value: "assets/replacement.png" });
      if (img === undefined) return;
      params = `{ selector: { page: ${n}, object_name: ${name} }, image: ${img} }`;
    }
    if (pick.wholeDoc) {
      await rewriteWorkflow(node.wfUri, (raw) => insertOperation(raw, op, params));
      output.info(`applied ${op} (whole document)`);
    } else {
      await insertPageScopedOperation(node.wfUri, op, params, `applied ${op} to page ${n}`);
    }
  });

  // Image-targeted operations: right-click an image object in the object map.
  reg("pdfStudio.applyToImage", async (arg) => {
    const node = arg as { wfUri?: vscode.Uri; pageNumber?: number; imageName?: string } | undefined;
    if (!node?.wfUri || node.pageNumber === undefined || !node.imageName) return;
    const choices: Array<vscode.QuickPickItem & { op: "replace_image" | "extract_images" }> = [
      { label: "$(replace) Replace this image…", detail: "replace_image", op: "replace_image" },
      { label: "$(export) Extract all images", detail: "extract_images", op: "extract_images" },
    ];
    const pick = await vscode.window.showQuickPick(choices, {
      title: `Image ${node.imageName} (page ${node.pageNumber})`,
      placeHolder: "Choose an operation to write into the workflow",
    });
    if (!pick) return;
    if (pick.op === "replace_image") {
      const img = await vscode.window.showInputBox({
        title: "Replacement image",
        prompt: "Path of the replacement image, relative to the workflow",
        value: "assets/replacement.png",
      });
      if (img === undefined) return;
      // The selector names a page, so it needs the same placement care.
      await insertPageScopedOperation(
        node.wfUri,
        "replace_image",
        `{ selector: { page: ${node.pageNumber}, object_name: ${node.imageName} }, image: ${img} }`,
        `applied replace_image to image ${node.imageName} (page ${node.pageNumber})`,
      );
    } else {
      await rewriteWorkflow(node.wfUri, (raw) => insertOperation(raw, "extract_images", "{ to: output/images }"));
      output.info("applied extract_images (whole document)");
    }
  });

  // Form-field-targeted: right-click a form field in the object map to fill it.
  reg("pdfStudio.applyToField", async (arg) => {
    const node = arg as { wfUri?: vscode.Uri; fieldName?: string } | undefined;
    if (!node?.wfUri || !node.fieldName) return;
    const value = await vscode.window.showInputBox({
      title: `Fill form field "${node.fieldName}"`,
      prompt: "Value to set",
    });
    if (value === undefined) return;
    const params = `{ field: ${JSON.stringify(node.fieldName)}, value: ${JSON.stringify(value)} }`;
    await rewriteWorkflow(node.wfUri, (raw) => insertOperation(raw, "fill_field", params));
    output.info(`fill_field "${node.fieldName}" = ${JSON.stringify(value)}`);
  });

  // Read as Markdown: run the extract_markdown sidecar directly on an input PDF
  // (non-destructive — does NOT add an op to the workflow) and open the result,
  // so an agent (or you) can read the PDF as structured text with tables.
  reg("pdfStudio.readAsMarkdown", async (arg) => {
    const node = arg as { pdfPath?: string } | undefined;
    const pdfPath = node?.pdfPath;
    if (!pdfPath) return;
    const py = await resolvePythonWithPyMuPDF(configuredPythonPath());
    if (!py) {
      void vscode.window.showWarningMessage(
        "PDF Studio: Read as Markdown needs the PyMuPDF backend. Install it from the Dependencies section (pip install PyMuPDF; pymupdf4llm improves quality).",
      );
      return;
    }
    const scriptPath = vscode.Uri.joinPath(context.extensionUri, "resources", "python", "pdf_exec.py").fsPath;
    const adapter = new PythonAdapter({
      configuredPython: configuredPythonPath(),
      scriptPath,
      baseDir: path.dirname(pdfPath),
    });
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(fs.readFileSync(pdfPath));
    } catch (e) {
      void vscode.window.showErrorMessage(`PDF Studio: could not read ${path.basename(pdfPath)} — ${(e as Error).message}`);
      return;
    }
    const ctx: ExecContext = { kind: "pdf", inputs: [bytes], inputPaths: [path.basename(pdfPath)], assets: {}, current: bytes, artifacts: [] };
    const step: PlanStep = {
      index: 0,
      op: "extract_markdown",
      capability: "extract_markdown",
      params: { to: "document.md" },
      adapter: "python",
    };
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Reading ${path.basename(pdfPath)} as Markdown…` },
      async () => {
        try {
          const res = await adapter.apply(ctx, step);
          const art = res.artifacts?.[0];
          if (!art) {
            void vscode.window.showErrorMessage("PDF Studio: no Markdown was produced.");
            return;
          }
          const mdPath = pdfPath.replace(/\.pdf$/i, "") + ".md";
          fs.writeFileSync(mdPath, Buffer.from(art.bytes));
          output.info(`read ${path.basename(pdfPath)} → ${path.basename(mdPath)} (${art.bytes.length} bytes)`);
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(mdPath));
          await vscode.window.showTextDocument(doc, { preview: true });
        } catch (e) {
          void vscode.window.showErrorMessage(`PDF Studio: Read as Markdown failed — ${(e as Error).message}`);
        }
      },
    );
  });

  // Convert ANY file (docx / pptx / xlsx / html / epub / images / … ) to Markdown
  // via Microsoft MarkItDown. Invoked from the file-explorer context menu or the
  // palette (file picker). Standalone — not an OPW operation.
  reg("pdfStudio.convertToMarkdown", async (arg) => {
    let fileUri: vscode.Uri | undefined;
    if (arg instanceof vscode.Uri) fileUri = arg;
    else if (arg && typeof arg === "object") {
      const node = arg as { resourceUri?: vscode.Uri; pdfPath?: string };
      fileUri = node.resourceUri ?? (node.pdfPath ? vscode.Uri.file(node.pdfPath) : undefined);
    }
    if (!fileUri) {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        title: "Convert file to Markdown",
        openLabel: "Convert to Markdown",
      });
      fileUri = picked?.[0];
    }
    if (!fileUri) return;
    const inputPath = fileUri.fsPath;

    const py = await resolvePythonWithMarkitdown(configuredPythonPath());
    if (!py) {
      const install = "Install MarkItDown";
      const choice = await vscode.window.showWarningMessage(
        'Lynx PDF Studio: "Convert to Markdown" needs Microsoft MarkItDown. Install it to convert Office/HTML/EPUB/image files to Markdown.',
        install,
      );
      if (choice === install) {
        const term = vscode.window.createTerminal("Install MarkItDown");
        term.show();
        term.sendText('pip install "markitdown[all]"');
      }
      return;
    }
    const scriptPath = vscode.Uri.joinPath(context.extensionUri, "resources", "python", "markitdown_convert.py").fsPath;
    const mdPath = inputPath.replace(/\.[^.\\/]+$/, "") + ".md";
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Converting ${path.basename(inputPath)} to Markdown…` },
      async () => {
        const res = await convertToMarkdown({ inputPath, outputPath: mdPath, scriptPath, python: py });
        if (!res.ok) {
          void vscode.window.showErrorMessage(`Lynx PDF Studio: MarkItDown failed — ${res.error ?? "unknown error"}`);
          return;
        }
        output.info(`markitdown: ${path.basename(inputPath)} → ${path.basename(mdPath)} (${res.chars ?? 0} chars)`);
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(mdPath));
        await vscode.window.showTextDocument(doc, { preview: true });
        try {
          await vscode.commands.executeCommand("markdown.showPreview");
        } catch {
          /* preview is a nicety */
        }
      },
    );
  });

  /** Resolve the workflow to act on: a tree node's wfUri, an explicit uri, or the active/only workflow. */
  async function targetWorkflowUri(arg: unknown): Promise<vscode.Uri | undefined> {
    const node = arg as { wfUri?: vscode.Uri } | undefined;
    if (node?.wfUri) return node.wfUri;
    return resolveWorkflowUri(arg);
  }

  /** Apply a pure text transform to a workflow file, then save (→ validate + render). */
  /**
   * Insert an operation whose params carry INPUT-document page numbers.
   *
   * The object map enumerates the pages of the input PDF, so "Page 5" means the
   * fifth page of the file on disk. Appending is only correct while nothing
   * upstream renumbers the document — a workflow that already merges, deletes or
   * reorders would make an appended `delete_pages: [5]` hit a different page.
   * So the op goes before the first pagination-changing operation, and we say so.
   */
  async function insertPageScopedOperation(
    wfUri: vscode.Uri,
    opName: string,
    params: string,
    what: string,
  ): Promise<void> {
    let placedBefore: string | undefined;
    await rewriteWorkflow(wfUri, (raw) => {
      const at = pageSafeInsertIndex(raw, opChangesPagination);
      if (at >= 0) {
        // Name the blocking op from the parsed workflow, not by scanning lines —
        // `inputs:` entries are list items too and would shift the index.
        try {
          placedBefore = parseWorkflow(raw).operations[at]?.name;
        } catch {
          /* unparseable file — still insert, just without naming the op */
        }
      }
      return insertOperationAt(raw, opName, params, at);
    });
    if (placedBefore) {
      output.info(`${what} — inserted before "${placedBefore}" so the page number still refers to the page you picked`);
      void vscode.window.showInformationMessage(
        `PDF Studio: added ${opName} before "${placedBefore}" — ${placedBefore} renumbers the document, so a page number written after it would point somewhere else.`,
      );
    } else {
      output.info(what);
    }
  }

  async function rewriteWorkflow(uri: vscode.Uri, transform: (raw: string) => string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const raw = doc.getText();
    const next = transform(raw);
    if (next === raw) return;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), doc.positionAt(raw.length)), next);
    await vscode.workspace.applyEdit(edit);
    await doc.save();
    explorer.refresh();
  }

  /**
   * Write the self-contained project files: the agent map (gated by the setting)
   * plus the MCP server + .mcp.json inside the project. Called only from explicit
   * workflow-creating actions (Initialize Project / New Workflow) — never on
   * activation — so a workspace that has a workflow.opw.yaml also has everything
   * a coding agent needs, all inside the project folder.
   */
  async function setupProjectFiles(root: string): Promise<void> {
    if (vscode.workspace.getConfiguration("pdfStudio").get<boolean>("generateAgentMap", true)) {
      await writeAgentMap(root, extensionVersion, (m) => output.appendLine(m));
    }
    const rel = await stageMcpServerInProject(root, context.extensionUri);
    if (rel) {
      try {
        await writeMcpJson(root, rel);
      } catch (e) {
        // Don't fail project init over a pre-existing malformed .mcp.json.
        output.appendLine(`[mcp] skipped .mcp.json — ${(e as Error).message}`);
      }
    }
  }

  /** Open transient Markdown content in a rendered preview. */
  async function openMarkdown(content: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument({ content, language: "markdown" });
    await vscode.window.showTextDocument(doc, { preview: true });
    try {
      await vscode.commands.executeCommand("markdown.showPreview");
    } catch {
      /* preview is a nicety; the source doc is already shown */
    }
  }

  reg("pdfStudio.initProject", async () => {
    const uri = await initProject();
    if (uri) {
      const root = workspaceRoot();
      if (root) await setupProjectFiles(root);
      explorer.refresh();
      await vscode.window.showTextDocument(uri);
    }
  });

  reg("pdfStudio.downloadExamples", () => downloadExamples(explorer));

  reg("pdfStudio.newWorkflow", async () => {
    const root = workspaceRoot();
    if (!root) {
      void vscode.window.showErrorMessage("PDF Studio: open a folder first.");
      return;
    }
    const name = await vscode.window.showInputBox({
      prompt: "New workflow file name",
      value: "workflow.opw.yaml",
      validateInput: (v) => (/\.opw\.ya?ml$/.test(v) ? undefined : "must end in .opw.yaml"),
    });
    if (!name) return;
    const uri = vscode.Uri.file(path.join(root, name));
    const wf = parseWorkflow(
      JSON.stringify({ version: 1, kind: "pdf", inputs: ["input/document.pdf"], operations: [], output: { file: "output/out.pdf" } }),
    );
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(serializeWorkflow(wf)));
    // Creating a workflow initializes the project: agent map + self-contained
    // MCP wiring, so the folder is ready for a coding agent immediately.
    await setupProjectFiles(root);
    explorer.refresh();
    await vscode.window.showTextDocument(uri);
  });

  reg("pdfStudio.runWorkflow", async (arg) => {
    const uri = await resolveWorkflowUri(arg);
    if (uri) {
      await runner.run(uri);
      explorer.refresh();
    }
  });

  reg("pdfStudio.validateWorkflow", async (arg) => {
    const uri = await resolveWorkflowUri(arg);
    if (!uri) return;
    const diags = await runner.validate(uri);
    const errs = diags.filter((d) => d.severity === "error").length;
    if (diags.length === 0) void vscode.window.showInformationMessage("PDF Studio: workflow is valid ✓");
    else void vscode.window.showWarningMessage(`PDF Studio: ${errs} error(s), ${diags.length - errs} warning(s) — see Problems.`);
  });

  reg("pdfStudio.optimizeWorkflow", async (arg) => {
    const uri = await resolveWorkflowUri(arg);
    if (!uri) return;
    const wf = await readWorkflowFile(uri);
    if (!wf.workflow) return;
    const { workflow, rewrites } = optimizeWorkflow(wf.workflow);
    if (rewrites.length === 0) {
      void vscode.window.showInformationMessage("PDF Studio: workflow already optimal.");
      return;
    }
    const apply = "Apply";
    const choice = await vscode.window.showInformationMessage(
      `PDF Studio optimizer: ${rewrites.map((r) => r.message).join("; ")}`,
      apply,
      "Cancel",
    );
    if (choice === apply) {
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(serializeWorkflow(workflow)));
      explorer.refresh();
    }
  });

  reg("pdfStudio.showPlan", async (arg) => {
    const uri = await resolveWorkflowUri(arg);
    if (!uri) return;
    const wf = await readWorkflowFile(uri);
    if (!wf.workflow) return;
    const { workflow } = optimizeWorkflow(wf.workflow);
    const registry = defaultRegistry();
    await registry.refreshAvailability();
    const plan = compileWorkflow(workflow, { registry });
    const doc = await vscode.workspace.openTextDocument({ content: describePlan(plan), language: "markdown" });
    await vscode.window.showTextDocument(doc, { preview: true });
  });

  reg("pdfStudio.openPreview", async (arg) => {
    const uri = await resolveWorkflowUri(arg);
    if (!uri) return;
    const wf = await readWorkflowFile(uri);
    const out = outputPath(wf);
    if (!out) {
      void vscode.window.showErrorMessage("PDF Studio: workflow has no output.");
      return;
    }
    if (!fs.existsSync(out)) {
      const render = "Render Now";
      const choice = await vscode.window.showInformationMessage("PDF Studio: output not rendered yet.", render);
      if (choice !== render) return;
      const result = await runner.run(uri);
      if (!result?.output) return;
    }
    PreviewPanel.show(context.extensionUri, output, out);
  });

  reg("pdfStudio.openWorkflow", async (arg) => {
    const uri = arg instanceof vscode.Uri ? arg : await resolveWorkflowUri(arg);
    if (uri) await vscode.window.showTextDocument(uri);
  });

  reg("pdfStudio.refresh", async () => {
    explorer.refresh();
    await explorer.refreshDependencies();
  });

  // Find a workflow in a long tree. Matching covers what people actually
  // remember — an operation ("watermark"), an input glob ("invoices/*.pdf"), the
  // output name — not just the file name, so it finds workflows whose rows aren't
  // even expanded. Enter jumps to one (revealed in the tree + opened); the filter
  // button keeps the query as a persistent narrowing of the Workflows section.
  reg("pdfStudio.searchWorkflows", async () => {
    const workflows = await findWorkflowFiles();
    if (workflows.length === 0) {
      const pick = await vscode.window.showInformationMessage(
        "Lynx PDF Studio: no workflows in this folder yet.",
        "New Workflow",
      );
      if (pick === "New Workflow") await vscode.commands.executeCommand("pdfStudio.newWorkflow");
      return;
    }

    interface Hit extends vscode.QuickPickItem {
      wf: (typeof workflows)[number];
    }
    const items: Hit[] = workflows.map((wf) => {
      const dir = path.dirname(wf.relPath);
      return {
        wf,
        label: `$(file-code) ${path.basename(wf.relPath)}`,
        description: dir === "." ? undefined : dir,
        detail: workflowSummary(wf),
      };
    });

    const filterButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon("filter"),
      tooltip: "Keep this text as a filter on the Workflows tree",
    };
    const qp = vscode.window.createQuickPick<Hit>();
    qp.items = items;
    qp.value = explorer.workflowFilter; // resume from the active filter, if any
    qp.matchOnDescription = true;
    qp.matchOnDetail = true; // this is what makes ops/inputs/outputs typeable
    qp.title = "Find a workflow";
    qp.placeholder = `Search ${workflows.length} workflow${workflows.length === 1 ? "" : "s"} — file name, operation, input or output`;
    qp.buttons = [filterButton];

    const choice = await new Promise<{ hit?: Hit; filter?: string }>((resolve) => {
      let settled = false;
      const settle = (v: { hit?: Hit; filter?: string }) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      qp.onDidTriggerButton(() => {
        settle({ filter: qp.value });
        qp.hide();
      });
      qp.onDidAccept(() => {
        settle({ hit: qp.selectedItems[0] });
        qp.hide();
      });
      qp.onDidHide(() => {
        settle({}); // dismissed
        qp.dispose();
      });
      qp.show();
    });

    if (choice.filter !== undefined) {
      await vscode.commands.executeCommand("pdfStudio.filterWorkflows", choice.filter);
      return;
    }
    const wf = choice.hit?.wf;
    if (!wf) return;
    // Never jump to a row the current filter is hiding.
    if (explorer.workflowFilter && !matchesWorkflow(wf, explorer.workflowFilter)) explorer.setWorkflowFilter("");
    await explorer.revealWorkflow(wf.relPath);
    await vscode.window.showTextDocument(wf.uri, { preview: true });
  });

  // Narrow the Workflows section itself, so a big project's tree shows only the
  // handful you're working on. Takes the query as an argument (scriptable, and how
  // the search picker's filter button gets here) or prompts for it.
  reg("pdfStudio.filterWorkflows", async (arg) => {
    let query = typeof arg === "string" ? arg : undefined;
    if (query === undefined) {
      query = await vscode.window.showInputBox({
        title: "Filter the Workflows tree",
        prompt: "Show only workflows matching every term — a name, operation, input, output or var. Empty shows all.",
        value: explorer.workflowFilter,
        placeHolder: "e.g. watermark invoices",
      });
      if (query === undefined) return; // dismissed — leave the current filter alone
    }
    explorer.setWorkflowFilter(query);
    const rows = await explorer.workflowRows();
    if (query.trim() && rows.rows.length === 0) {
      void vscode.window.showInformationMessage(`Lynx PDF Studio: no workflow matches “${query.trim()}”.`);
    }
  });

  reg("pdfStudio.clearWorkflowFilter", () => explorer.setWorkflowFilter(""));

  // Internal: what the Workflows section is currently showing (rows + the
  // section's count/filter description), so the harness can assert on search and
  // filtering directly instead of inferring it from side effects.
  reg("pdfStudio._workflowRows", () => explorer.workflowRows());

  // Internal: the reveal half of the search picker (getParent + TreeView.reveal),
  // driven by workspace-relative path so the harness can exercise it.
  reg("pdfStudio._revealWorkflow", (relPath) => explorer.revealWorkflow(String(relPath)));

  reg("pdfStudio.checkDependencies", async () => {
    runner.resetBackends(); // a just-installed tool should render on the next run
    const deps = await explorer.refreshDependencies();
    const ready = deps.filter((d) => d.state === "available").length;
    void vscode.window.showInformationMessage(`PDF Studio: ${ready}/${deps.length} backends ready.`);
  });

  reg("pdfStudio.setupDependency", async (arg) => {
    const dep = arg as DependencyStatus | undefined;
    // OCR backends have real setup beyond a one-line pip (a dedicated venv, a system binary,
    // a model server) — route each to its purpose-built one-click command.
    const setupRoute: Record<string, string> = {
      "paddleocr-vl": "pdfStudio.setupPaddleOcr",
      ocrmypdf: "pdfStudio.setupOcr",
      tesseract: "pdfStudio.setupOcr",
      marker: "pdfStudio.setupMarker",
      "receipt-ocr": "pdfStudio.setupReceiptOcr",
    };
    const route = dep?.id ? setupRoute[dep.id] : undefined;
    if (route) {
      await vscode.commands.executeCommand(route);
      return;
    }
    if (!dep?.installHint) {
      void vscode.window.showInformationMessage("PDF Studio: no install hint for this dependency.");
      return;
    }
    const hint = dep.installHint;

    // Some backends (e.g. Ghostscript on Windows) aren't in a package manager,
    // so the hint is a download URL — open it in a browser, never type a URL
    // into the shell.
    if (/^https?:\/\//i.test(hint)) {
      const openIt = "Open Download Page";
      const copy = "Copy Link";
      const choice = await vscode.window.showInformationMessage(`Set up ${dep.label}: download from ${hint}`, openIt, copy);
      if (choice === openIt) {
        await vscode.env.openExternal(vscode.Uri.parse(hint));
      } else if (choice === copy) {
        await vscode.env.clipboard.writeText(hint);
        void vscode.window.showInformationMessage("Copied link to clipboard.");
      }
      return;
    }

    const runIt = "Run in Terminal";
    const copy = "Copy Command";
    const choice = await vscode.window.showInformationMessage(`Set up ${dep.label}: ${hint}`, runIt, copy);
    if (choice === copy) {
      await vscode.env.clipboard.writeText(hint);
      void vscode.window.showInformationMessage("Copied command to clipboard.");
    } else if (choice === runIt) {
      const term = vscode.window.createTerminal("Lynx PDF Studio setup");
      term.show();
      term.sendText(hint);
      void vscode.window.showInformationMessage(
        `Installing ${dep.label}. When it finishes, reopen the terminal, then run "Lynx PDF Studio: Check Dependencies".`,
      );
    }
  });

  // One-click PaddleOCR-VL setup: create a DEDICATED venv (kept apart from the PyMuPDF
  // interpreter so the PaddlePaddle stack can't break its pins), install the packages,
  // warm up the model (first-run download), then persist the interpreter as a setting so
  // the paddleocr-vl engine works with no env var and no window reload.
  reg("pdfStudio.setupPaddleOcr", async () => {
    if (resolvePaddlePython()) {
      const redo = await vscode.window.showInformationMessage(
        "PaddleOCR-VL already looks set up. Reinstall it?", "Reinstall", "Cancel");
      if (redo !== "Reinstall") return;
    } else {
      const go = await vscode.window.showInformationMessage(
        "Set up PaddleOCR-VL? This creates a dedicated Python venv and installs PaddlePaddle + PaddleOCR " +
          "(~1–2 GB download, several minutes). It runs on CPU.",
        { modal: true }, "Set up");
      if (go !== "Set up") return;
    }

    const venvDir = path.join(context.globalStorageUri.fsPath, "paddle-venv");
    const venvPy = paddleVenvPython(venvDir);
    // Base interpreter to CREATE the venv: the configured pythonPath, else py -3 / python3.
    const configured = configuredPythonPath();
    const [baseCmd, baseArgs] = configured
      ? [configured, [] as string[]]
      : process.platform === "win32"
        ? ["py", ["-3"]]
        : ["python3", []];

    output.show();
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Setting up PaddleOCR-VL", cancellable: false },
        async (progress) => {
          const step = (message: string) => {
            progress.report({ message });
            output.appendLine(`[paddleocr-vl setup] ${message}`);
          };
          await fs.promises.mkdir(context.globalStorageUri.fsPath, { recursive: true });
          step("creating a dedicated venv…");
          await runStreamed(baseCmd, [...baseArgs, "-m", "venv", venvDir], output);
          step("upgrading pip…");
          await runStreamed(venvPy, ["-m", "pip", "install", "--upgrade", "pip"], output);
          step("installing paddlepaddle + paddleocr (several minutes)…");
          await runStreamed(venvPy, ["-m", "pip", "install", "paddlepaddle==3.2.0", "paddleocr[doc-parser]"], output);
          step("downloading the model on first run…");
          await runStreamed(venvPy, ["-c", "from paddleocr import PaddleOCRVL; PaddleOCRVL(device='cpu')"], output);
          step("saving settings…");
          await vscode.workspace
            .getConfiguration("pdfStudio")
            .update("paddlePythonPath", venvPy, vscode.ConfigurationTarget.Global);
        },
      );
      runner.resetBackends();
      await explorer.refreshDependencies();
      explorer.refresh();
      void vscode.window.showInformationMessage(
        "PaddleOCR-VL is ready. Use it with extract_markdown: { engine: paddleocr-vl }.",
      );
    } catch (err) {
      output.appendLine(`[paddleocr-vl setup] FAILED: ${(err as Error).message}`);
      const showLog = "Show Log";
      const choice = await vscode.window.showErrorMessage(
        `PaddleOCR-VL setup failed: ${(err as Error).message}`,
        showLog,
      );
      if (choice === showLog) output.show();
    }
  });

  // One-click OCR (the `ocr` op): OCRmyPDF into the main venv (pinned <17 so it coexists
  // with Marker's pypdfium2), plus the Tesseract system binary. pip is UAC-free and auto-run;
  // the system installer auto-runs too but falls back to a terminal if it needs elevation.
  reg("pdfStudio.setupOcr", async () => {
    const [py, pyArgs] = basePython(configuredPythonPath());
    output.show();
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Setting up OCR", cancellable: false },
        async (progress) => {
          progress.report({ message: "installing OCRmyPDF (pinned <17)…" });
          await autoRun(
            `${[py, ...pyArgs].join(" ")} -m pip install "ocrmypdf<17"`,
            () => runStreamed(py, [...pyArgs, "-m", "pip", "install", "ocrmypdf<17"], output),
            output,
          );
          if (await commandExists("tesseract")) {
            output.appendLine("[setup] Tesseract already installed.");
          } else {
            const tess = installCommand("tesseract");
            if (tess && /^https?:/i.test(tess)) {
              await vscode.env.openExternal(vscode.Uri.parse(tess));
            } else if (tess) {
              progress.report({ message: "installing Tesseract (may prompt for admin)…" });
              await autoRun(tess, () => runStreamed(tess, [], output, { shell: true, timeoutMs: 300_000 }), output);
            }
          }
        },
      );
      runner.resetBackends();
      await explorer.refreshDependencies();
      explorer.refresh();
      void vscode.window.showInformationMessage("OCR setup finished. The `ocr` op is ready once OCRmyPDF and Tesseract both show green.");
    } catch (err) {
      void vscode.window.showErrorMessage(`OCR setup failed: ${(err as Error).message}`);
    }
  });

  // One-click Marker (Surya OCR → Markdown): pip into the main venv, then warm up the models.
  reg("pdfStudio.setupMarker", async () => {
    const [py, pyArgs] = basePython(configuredPythonPath());
    output.show();
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Setting up Marker (Surya OCR)", cancellable: false },
        async (progress) => {
          progress.report({ message: "installing marker-pdf (heavy — pulls torch/Surya)…" });
          const ok = await autoRun(
            `${[py, ...pyArgs].join(" ")} -m pip install marker-pdf`,
            () => runStreamed(py, [...pyArgs, "-m", "pip", "install", "marker-pdf"], output),
            output,
          );
          if (ok) {
            progress.report({ message: "warming up the Surya models (first-run download)…" });
            // Best-effort — models also download on the first real run.
            await runStreamed(py, [...pyArgs, "-c", "from marker.models import create_model_dict; create_model_dict()"], output).catch(
              (e) => output.appendLine(`[setup] marker warm-up skipped: ${(e as Error).message}`),
            );
          }
        },
      );
      runner.resetBackends();
      await explorer.refreshDependencies();
      explorer.refresh();
      void vscode.window.showInformationMessage("Marker set up. Use extract_markdown: { engine: marker }.");
    } catch (err) {
      void vscode.window.showErrorMessage(`Marker setup failed: ${(err as Error).message}`);
    }
  });

  // One-click Receipt OCR (extract_receipt): install Ollama if missing, pull a local vision
  // model, and point the VLM settings at it — no env var, no window reload.
  reg("pdfStudio.setupReceiptOcr", async () => {
    const model = "qwen2.5vl:3b";
    output.show();
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Setting up Receipt OCR (Qwen3-VL)", cancellable: false },
        async (progress) => {
          if (!(await commandExists(ollamaExe()))) {
            progress.report({ message: "installing Ollama…" });
            const cmd =
              process.platform === "win32"
                ? "winget install --id Ollama.Ollama -e --accept-package-agreements --accept-source-agreements"
                : process.platform === "darwin"
                  ? "brew install ollama"
                  : "curl -fsSL https://ollama.com/install.sh | sh";
            await autoRun(cmd, () => runStreamed(cmd, [], output, { shell: true, timeoutMs: 600_000 }), output);
          } else {
            output.appendLine("[setup] Ollama already installed.");
          }
          progress.report({ message: `pulling the vision model ${model} (~3 GB)…` });
          await autoRun(
            `ollama pull ${model}`,
            () => runStreamed(ollamaExe(), ["pull", model], output, { shell: process.platform === "win32", timeoutMs: 1_800_000 }),
            output,
          );
          progress.report({ message: "saving settings…" });
          const cfg = vscode.workspace.getConfiguration("pdfStudio");
          await cfg.update("vlmEndpoint", "http://localhost:11434/v1", vscode.ConfigurationTarget.Global);
          await cfg.update("vlmModel", model, vscode.ConfigurationTarget.Global);
          // NB: we deliberately do NOT enable pdfStudio.allowRemoteRender here. The endpoint is
          // loopback (Ollama on localhost), which the adapter exempts from that gate — so a
          // "local" setup never silently grants off-box document egress for other ops.
        },
      );
      runner.resetBackends();
      await explorer.refreshDependencies();
      explorer.refresh();
      void vscode.window.showInformationMessage("Receipt OCR ready — extract_receipt now uses a local Qwen vision model on CPU.");
    } catch (err) {
      void vscode.window.showErrorMessage(`Receipt OCR setup failed: ${(err as Error).message}`);
    }
  });

  reg("pdfStudio.generateAgentMap", async () => {
    const root = workspaceRoot();
    if (!root) return;
    const res = await writeAgentMap(root, extensionVersion, (m) => output.appendLine(m));
    void vscode.window.showInformationMessage(`PDF Studio: wrote ${res.written.join(", ")}.`);
  });

  reg("pdfStudio.revealOutput", async (arg) => {
    const uri = await resolveWorkflowUri(arg);
    if (!uri) return;
    const wf = await readWorkflowFile(uri);
    const out = outputPath(wf);
    if (out && fs.existsSync(out)) await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(out));
  });
}

/**
 * Resolve which workflow a command targets: an explicit Uri arg, the active
 * editor if it's an .opw.yaml, or a pick from the workspace's workflows.
 */
async function resolveWorkflowUri(arg: unknown): Promise<vscode.Uri | undefined> {
  if (arg instanceof vscode.Uri && /\.opw\.ya?ml$/.test(arg.fsPath)) return arg;
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active && /\.opw\.ya?ml$/.test(active.fsPath)) return active;

  const files = await findWorkflowFiles();
  if (files.length === 0) {
    void vscode.window.showErrorMessage("PDF Studio: no .opw.yaml workflow found. Run Initialize Project.");
    return undefined;
  }
  if (files.length === 1) return files[0]!.uri;
  const pick = await vscode.window.showQuickPick(
    files.map((f) => ({ label: f.relPath, uri: f.uri })),
    { placeHolder: "Select a workflow" },
  );
  return pick?.uri;
}
