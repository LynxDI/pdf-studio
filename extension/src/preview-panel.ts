// In-editor PDF preview via a pdf.js webview.
//
// The webview is a Chromium context, so pdf.js renders pages to <canvas> there.
// We hand pdf.js a webview resource URI for the output PDF (localResourceRoots
// grants access) and it fetches + renders it. A single reused panel follows the
// active workflow's output.

import * as vscode from "vscode";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

export interface PreviewRenderStatus {
  ok: boolean;
  pages?: number;
  error?: string;
}

export class PreviewPanel {
  private static current: PreviewPanel | undefined;
  /** Last render outcome reported by the webview — read by tests / agents. */
  private static lastRender: PreviewRenderStatus | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  static getLastRenderStatus(): PreviewRenderStatus | undefined {
    return PreviewPanel.lastRender;
  }

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly output: vscode.LogOutputChannel,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "pdfStudioPreview",
      "PDF Preview",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
      },
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    // Surface the webview renderer's own logs (worker setup, load, render,
    // uncaught errors) in the "Lynx PDF Studio" output channel for troubleshooting.
    this.panel.webview.onDidReceiveMessage(
      (msg: { type?: string; level?: string; msg?: string; ok?: boolean; pages?: number; error?: string } | undefined) => {
        if (!msg) return;
        if (msg.type === "log") {
          const line = `[preview] ${msg.msg ?? ""}`;
          if (msg.level === "error") this.output.error(line);
          else if (msg.level === "warn") this.output.warn(line);
          else this.output.info(line);
        } else if (msg.type === "render") {
          PreviewPanel.lastRender = { ok: !!msg.ok, pages: msg.pages, error: msg.error };
          if (msg.ok) this.output.info(`[preview] rendered ${msg.pages} page(s)`);
          else this.output.error(`[preview] render failed: ${msg.error ?? "unknown"}`);
        }
      },
      null,
      this.disposables,
    );
  }

  static show(extensionUri: vscode.Uri, output: vscode.LogOutputChannel, pdfPath: string): void {
    if (!PreviewPanel.current) {
      PreviewPanel.current = new PreviewPanel(extensionUri, output);
    }
    PreviewPanel.current.render(pdfPath);
    PreviewPanel.current.panel.reveal(vscode.ViewColumn.Beside);
  }

  private render(pdfPath: string): void {
    PreviewPanel.lastRender = undefined; // cleared until the webview reports back
    const webview = this.panel.webview;
    // Grant this specific output file (its directory) to the webview.
    const dir = vscode.Uri.file(path.dirname(pdfPath));
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist"), dir],
    };
    this.panel.title = `PDF Preview — ${path.basename(pdfPath)}`;

    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "preview.js"));
    const workerUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "pdf.worker.js"));
    const pdfUri = webview.asWebviewUri(vscode.Uri.file(pdfPath));
    const nonce = makeNonce();
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}' 'wasm-unsafe-eval'`,
      `connect-src ${webview.cspSource} blob: data:`,
      "worker-src blob:",
    ].join("; ");

    webview.html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  body { margin: 0; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
  #toolbar { position: sticky; top: 0; padding: 6px 10px; background: var(--vscode-editorWidget-background); border-bottom: 1px solid var(--vscode-widget-border); font-size: 12px; }
  #pages { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 12px; }
  canvas { box-shadow: 0 1px 6px rgba(0,0,0,0.4); max-width: 100%; height: auto; }
  #status { opacity: 0.7; }
</style>
</head>
<body>
  <div id="toolbar"><span id="status">Loading…</span></div>
  <div id="pages"></div>
  <script nonce="${nonce}">window.__PDF_STUDIO__ = { pdfUrl: "${pdfUri}", workerUrl: "${workerUri}" };</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    this.output.info(`[preview] opening ${pdfPath}`);
  }

  private dispose(): void {
    PreviewPanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}

function makeNonce(): string {
  // Cryptographically random so the CSP nonce can't be predicted (32 hex chars).
  return randomBytes(16).toString("hex");
}
