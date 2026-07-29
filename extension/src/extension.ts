// PDF Studio extension entrypoint.
//
// Wires the sidebar, commands, and a save-watcher that auto-validates and
// (optionally) re-renders a workflow when its .opw.yaml is saved. All PDF work
// runs in-process via @pdf-studio/core — no subprocess for the bundled backend.

import * as vscode from "vscode";
import { resolvePythonWithPyMuPDF, resetPythonResolution } from "@pdf-studio/core";
import { PdfStudioExplorer } from "./sidebar/explorer-provider.js";
import { OperationsPanel } from "./ops-panel.js";
import { WorkflowRunner } from "./workflow-runner.js";
import { registerCommands } from "./commands.js";
import { initProject } from "./project-init.js";
import { refreshStagedMcpServer } from "./mcp-setup.js";
import { registerNativeMcpProvider } from "./mcp-native.js";
import { workspaceRoot, configuredPythonPath, findWorkflowFiles, setPaddleManagedPython, paddleVenvPython } from "./project.js";
import * as path from "node:path";
import { initTelemetry, track } from "./telemetry.js";

let output: vscode.LogOutputChannel | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // LogOutputChannel: timestamped, level-filterable (Developer: Set Log Level),
  // and shown as the "Lynx PDF Studio" channel — the single troubleshooting surface.
  output = vscode.window.createOutputChannel("Lynx PDF Studio", { log: true });
  context.subscriptions.push(output);
  const version = (context.extension.packageJSON as { version?: string }).version ?? "0.0.0";
  output.info(`Lynx PDF Studio v${version} activated.`);

  // Anonymous, consent-gated usage analytics (GA4). Learns which features/
  // operations are used most — never PII. Honors VS Code telemetry + our setting.
  initTelemetry(context);
  track("activated");

  // The extension-managed PaddleOCR-VL venv lives under globalStorage; register its
  // interpreter path so the runner/sidebar resolve it once "Set up PaddleOCR-VL" has run.
  setPaddleManagedPython(paddleVenvPython(path.join(context.globalStorageUri.fsPath, "paddle-venv")));

  const explorer = new PdfStudioExplorer(context.extensionUri, output);
  const treeView = vscode.window.createTreeView("pdfStudioExplorer", { treeDataProvider: explorer });
  explorer.attachView(treeView); // lets "Find a Workflow" reveal + select its hit
  context.subscriptions.push(treeView);

  // The "Operations" webview panel: the single build-and-reference surface — the full OPW
  // vocabulary grouped by category (＋ adds to the workflow, click opens the doc), plus the
  // Guides & setup, MCP (server tools + set-up), and PDF Fill sections, with search.
  const opsPanel = new OperationsPanel(context.extensionUri);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(OperationsPanel.viewType, opsPanel));

  const runner = new WorkflowRunner(output, context);
  registerCommands({ context, output, runner, explorer, extensionVersion: version });

  // Surface the bundled MCP server to VS Code's own MCP host (GitHub Copilot
  // agent mode) with zero config. Complements the Claude-Code-style .mcp.json
  // written by "Set Up MCP"; no-ops on VS Code < 1.101. See mcp-native.ts.
  registerNativeMcpProvider(context, version, (m) => output?.info(m));

  // Save-watcher: validate + optionally re-render on every .opw.yaml save.
  // Renders are serialized per file with a coalescing guard — a save that lands
  // while a render is in flight re-runs exactly once when it finishes (last save
  // wins), so two quick saves never render concurrently and a slow render can
  // never write stale bytes over a newer one.
  const renderInFlight = new Set<string>();
  const renderPending = new Set<string>();
  const handleSave = async (uri: vscode.Uri): Promise<void> => {
    const cfg = vscode.workspace.getConfiguration("pdfStudio");
    if (cfg.get<boolean>("autoValidateOnSave", true)) {
      const diags = await runner.validate(uri);
      if (diags.some((d) => d.severity === "error")) {
        explorer.refresh();
        return; // don't render an invalid workflow
      }
    }
    if (cfg.get<boolean>("autoRenderOnSave", true)) {
      await runner.run(uri);
    }
    explorer.refresh();
  };
  const scheduleSave = async (uri: vscode.Uri): Promise<void> => {
    const key = uri.fsPath;
    if (renderInFlight.has(key)) {
      renderPending.add(key); // coalesce: the in-flight run will pick this up
      return;
    }
    renderInFlight.add(key);
    try {
      do {
        renderPending.delete(key);
        await handleSave(uri);
      } while (renderPending.has(key));
    } finally {
      renderInFlight.delete(key);
      renderPending.delete(key);
    }
  };
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!/\.opw\.ya?ml$/.test(doc.uri.fsPath)) return;
      void scheduleSave(doc.uri);
    }),
  );

  // React to config changes that affect probing.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("pdfStudio.pythonPath")) {
        resetPythonResolution();
        runner.resetBackends(); // re-detect backends with the new interpreter
        void logPython();
        void explorer.refreshDependencies();
      }
    }),
  );

  // Resolve (and log) the interpreter used for the optional PyMuPDF backend, so
  // "Show Logs" reveals exactly which Python is driving advanced ops.
  async function logPython(): Promise<void> {
    const py = await resolvePythonWithPyMuPDF(configuredPythonPath());
    output?.info(
      py
        ? `[python] using ${py.exe}${py.args.length ? " " + py.args.join(" ") : ""}`
        : "[python] no PyMuPDF-capable interpreter found — advanced ops (OCR/redact/replace_image/extract) disabled",
    );
  }
  // Probe the interpreter only when this workspace actually has an OPW project,
  // so a plain VS Code window (activated by onStartupFinished) doesn't spawn a
  // Python probe on startup for nothing.
  void (async () => {
    if ((await findWorkflowFiles()).length > 0) await logPython();
  })();

  // NOTE: we deliberately do NOT write CLAUDE.md/AGENTS.md/GEMINI.md on
  // activation — that would litter every folder the extension opens. The agent
  // map is written only on an explicit "Initialize Project" / "Generate Agent
  // Map" action (see commands.ts).
  const root = workspaceRoot();
  if (root) {
    // If MCP was set up for this project, refresh the staged server so an
    // extension update doesn't leave the agent with a stale (missing-ops) copy.
    void refreshStagedMcpServer(root, context.extensionUri);
    const cfg = vscode.workspace.getConfiguration("pdfStudio");
    if (cfg.get<boolean>("scaffoldEmptyWorkspace", false) && (await isEmptyWorkspace(root))) {
      await initProject(root);
      explorer.refresh();
    }
  }

  // Probe backends in the background so the Dependencies section fills in.
  void explorer.refreshDependencies();
}

export function deactivate(): void {
  output?.dispose();
}

/** An "empty" workspace has no user content (ignoring VCS/editor/cache dirs). */
async function isEmptyWorkspace(root: string): Promise<boolean> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(root));
    const ignore = new Set([".git", ".vscode", ".claude", "node_modules", ".pdf-cache"]);
    return entries.every(([name]) => ignore.has(name) || name.startsWith("."));
  } catch {
    return false;
  }
}
