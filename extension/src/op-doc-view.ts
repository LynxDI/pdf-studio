// A webview page for a single operation's documentation — usage, parameters, the example
// workflow (with an always-visible Copy button), an "ask an AI agent" prompt, and the capability
// footer. Rendered from the registry (OPERATIONS/OP_DOCS) so it stays in sync with the engine.
// Used by pdfStudio.showOpDoc for a specific op; the multi-op reference stays Markdown.
//
// Why a webview and not the Markdown preview: the preview blocks command: links, so a copy
// button rendered in Markdown can't act. A webview can write the clipboard on click.

import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import {
  OPERATIONS, OP_DOCS, buildExampleWorkflow, formCategories, formFillExampleYaml,
  type OperationSpec,
} from "@pdf-studio/core";

const esc = (s: unknown): string =>
  String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** Minimal inline Markdown → HTML for the short doc strings: `code`, **bold**, _italic_,
 *  and bare http(s) URLs → clickable links (VS Code opens them externally). */
const inline = (s: unknown): string =>
  esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/_([^_]+)_/g, "<em>$1</em>")
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');

/** OCR / Markdown-OCR / receipt ops get a compact engine-performance table on their doc
 *  page — the wired engines' benchmark headline numbers (mirrors docs/ocr-benchmark.md) so
 *  a user can pick an engine without leaving the panel. */
const OCR_OPS = new Set(["ocr", "extract_markdown", "pdf_to_markdown", "extract_receipt"]);
const OCR_PERF: ReadonlyArray<readonly [string, string, string, string, string, string]> = [
  // engine, how to select, TEDS (table structure), GPU throughput, VRAM, best for
  ["MinerU 2.5-Pro", "engine: mineru", "0.96", "~98 pg/min", "2.4 GB", "best tables / forms (real HTML tables)"],
  ["PaddleOCR-VL", "engine: paddleocr-vl", "0.00", "~311 pg/min", "1.8 GB", "fast searchable text at scale"],
  ["Marker (Surya)", "engine: marker", "0.84", "~5 pg/min", "GPU", "faithful Markdown + figures"],
  ["Qwen3-VL", "extract_receipt", "0.69", "18 pg/min", "~10 GB", "receipt / invoice fields → JSON/CSV"],
  ["Tesseract", "ocr", "—", "40 pg/min (CPU)", "0 (CPU)", "zero-cost searchable PDF"],
];
function ocrPerfHtml(op: string): string {
  if (!OCR_OPS.has(op)) return "";
  const rows = OCR_PERF.map(
    ([eng, sel, teds, thru, vram, best]) =>
      `<tr><td><strong>${esc(eng)}</strong></td><td><code>${esc(sel)}</code></td><td>${esc(teds)}</td><td>${esc(thru)}</td><td>${esc(vram)}</td><td>${esc(best)}</td></tr>`,
  ).join("");
  return `<h2>OCR engine performance</h2>
    <p class="muted">Independent 16-engine benchmark. Clean-text accuracy is a near-tie — the differentiators are <strong>table structure</strong> (TEDS ↑, 0 = tables flattened) and <strong>speed</strong>. These are the engines PDF Studio wires in.</p>
    <table><thead><tr><th>Engine</th><th>Select with</th><th>Tables&nbsp;(TEDS)</th><th>Throughput&nbsp;(GPU)</th><th>VRAM</th><th>Best for</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="muted">Throughput is on a <strong>GPU</strong> (batched); Tesseract is CPU-only. On CPU the VLM engines are far slower — e.g. MinerU runs ~5 pg/min via its <code>transformers</code> backend. Full report — all 16 engines, methodology, free cloud endpoints: <a href="https://github.com/LynxDI/pdf-studio/blob/main/docs/ocr-benchmark.md">OCR performance report ↗</a></p>`;
}

function paramsHtml(spec: OperationSpec): string {
  if (spec.params.length === 0) return "<p class='muted'>This operation takes no parameters.</p>";
  const rows = spec.params
    .map((p) => {
      const type = p.enum ? p.enum.map((e) => `<code>${esc(e)}</code>`).join(" | ") : `<code>${esc(p.type)}</code>`;
      const bounds = [p.min != null ? `min ${p.min}` : "", p.max != null ? `max ${p.max}` : ""].filter(Boolean).join(", ");
      return `<tr><td><code>${esc(p.name)}</code></td><td>${type}</td><td>${p.required ? "<strong>yes</strong>" : "no"}</td><td>${inline(p.description)}${bounds ? ` <span class='muted'>(${esc(bounds)})</span>` : ""}</td></tr>`;
    })
    .join("");
  return `<table><thead><tr><th>Param</th><th>Type</th><th>Required</th><th>Description</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** A YAML code block with a Copy button (the button copies the <pre>'s text). */
function codeBlock(yaml: string): string {
  return `<div class="codeblock"><button class="copy" title="Copy this workflow to the clipboard">⧉ Copy</button><pre>${esc(yaml)}</pre></div>`;
}

/** The plain-English "ask your AI agent" block, derived from the op's summary. */
function aiPrompt(op: string, spec: OperationSpec): string {
  const summary = (spec.summary || op).replace(/\s*\.\s*$/, "");
  const action = /^[A-Z][a-z]/.test(summary) ? summary[0]!.toLowerCase() + summary.slice(1) : summary;
  return `<h2><span class="ai">✨</span> Ask an AI agent to build this</h2>
    <p>You don't have to write YAML by hand. Tell your AI coding agent (Claude Code, Cursor, Copilot, …) what you want in plain English and it edits your <code>.opw.yaml</code> for you:</p>
    <blockquote>
      <p><strong>Add to a workflow —</strong> <em>"Add a <code>${esc(op)}</code> step that ${esc(action)}."</em></p>
      <p><strong>New workflow —</strong> <em>"Create a workflow that ${esc(action)}."</em></p>
    </blockquote>
    <p class="muted">The agent reads the same operation registry as this page, so it already knows <code>${esc(op)}</code> and its parameters — plain English is enough. (Set up the MCP server from the Operations panel so the agent can validate as it edits.)</p>`;
}

export class OpDocView {
  private panel?: vscode.WebviewPanel;

  constructor(private readonly extensionUri: vscode.Uri) {}

  /** Open (or refocus) the doc page for `op`. Unknown op → an info toast, no page. */
  show(op: string): void {
    const spec = OPERATIONS[op];
    if (!spec) {
      void vscode.window.showInformationMessage(`PDF Studio: unknown operation "${op}".`);
      return;
    }
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel("pdfStudioOpDoc", `Operation: ${op}`, vscode.ViewColumn.Active, {
        enableScripts: true,
        localResourceRoots: [this.extensionUri],
      });
      this.panel.onDidDispose(() => (this.panel = undefined));
      this.panel.webview.onDidReceiveMessage((msg: { type?: string; text?: string } | undefined) => {
        if (msg?.type === "copy" && typeof msg.text === "string") {
          void vscode.env.clipboard.writeText(msg.text);
          void vscode.window.showInformationMessage("Copied the workflow to the clipboard.");
        }
      });
    }
    this.panel.title = `Operation: ${op}`;
    this.panel.webview.html = this.html(this.panel.webview, op, spec);
    this.panel.reveal(vscode.ViewColumn.Active, false);
  }

  private html(webview: vscode.Webview, op: string, spec: OperationSpec): string {
    const nonce = randomBytes(16).toString("hex");
    const doc = OP_DOCS[op];
    // `usage` is authored as Markdown and may be several paragraphs (blank-line separated);
    // rendering it into one <p> would run them together into a wall of text.
    const usage = String(doc?.usage ?? spec.summary)
      .split(/\n{2,}/)
      .map((p) => `<p class="usage">${inline(p.trim())}</p>`)
      .join("");
    const result = doc?.result ? `<p><strong>Result:</strong> ${inline(doc.result)}</p>` : "";
    // Ops whose real use is a recipe (a folder of .pptx → one PDF each, or all merged) carry
    // extra named workflows. Each gets its own Copy button, like the main example.
    const recipes = doc?.recipes?.length
      ? "<h2>More workflows</h2>" +
        doc.recipes
          .map((r) => `<h3>${esc(r.title)}</h3><p>${inline(r.description)}</p>${codeBlock(r.yaml)}`)
          .join("")
      : "";
    const perForm =
      op === "fill_form"
        ? "<h2>Example workflow for each form</h2>" +
          formCategories()
            .flatMap((cat) =>
              cat.forms.map(
                (f) =>
                  `<h3><code>${esc(f.id)}</code> — ${esc(f.title)} <span class="muted">· ${esc(cat.title)}${f.partial ? " · partial" : ""}</span></h3>${codeBlock(formFillExampleYaml(f))}`,
              ),
            )
            .join("")
        : "";

    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;

    return `<!doctype html><html lang="en"><head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); line-height: 1.55; padding: 0 26px 48px; max-width: 900px; }
  h1 { font-size: 1.8em; margin: .8em 0 .2em; }
  h1 code { font-size: inherit; background: none; padding: 0; }
  h2 { font-size: 1.25em; margin-top: 1.7em; border-bottom: 1px solid var(--vscode-panel-border, #8883); padding-bottom: .2em; }
  h3 { font-size: 1.02em; margin-top: 1.3em; }
  code { font-family: var(--vscode-editor-font-family, monospace); background: var(--vscode-textCodeBlock-background, #8881); padding: .1em .35em; border-radius: 3px; font-size: .92em; }
  .muted { opacity: .7; }
  .ai { font-size: 1.1em; }
  .usage { font-size: 1.05em; }
  table { border-collapse: collapse; width: 100%; margin: .5em 0; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border, #8883); vertical-align: top; }
  th { font-weight: 600; }
  blockquote { margin: 1em 0; padding: .3em 1em; border-left: 3px solid var(--vscode-textLink-foreground); background: var(--vscode-textBlockQuote-background, #8881); }
  blockquote p { margin: .45em 0; }
  .codeblock { position: relative; margin: .6em 0; }
  .codeblock pre { background: var(--vscode-textCodeBlock-background, #1e1e1e); border: 1px solid var(--vscode-panel-border, #8883); border-radius: 6px; padding: 12px 14px; overflow-x: auto; font-family: var(--vscode-editor-font-family, monospace); font-size: .9em; margin: 0; }
  .copy { position: absolute; top: 8px; right: 8px; font-size: 12px; padding: 3px 9px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; border-radius: 4px; opacity: .92; }
  .copy:hover { opacity: 1; }
  .footer { margin-top: 2em; font-size: .9em; }
</style></head>
<body>
  <h1><code>${esc(op)}</code></h1>
  ${usage}
  ${ocrPerfHtml(op)}
  <h2>Parameters</h2>
  ${paramsHtml(spec)}
  <h2>Example workflow</h2>
  ${codeBlock(buildExampleWorkflow(op))}
  ${result}
  ${recipes}
  ${aiPrompt(op, spec)}
  ${perForm}
  <p class="muted footer">Save as <code>workflow.opw.yaml</code> and Render, or add just this operation via the sidebar / <strong>Add Operation…</strong>. Capability: <code>${esc(spec.capability)}</code> · applies to: ${esc(spec.kinds.join(", "))}</p>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.querySelectorAll('.copy').forEach((btn) => btn.addEventListener('click', () => {
    const pre = btn.parentElement.querySelector('pre');
    vscode.postMessage({ type: 'copy', text: pre.textContent });
    const original = btn.textContent;
    btn.textContent = 'Copied ✓';
    setTimeout(() => { btn.textContent = original; }, 1400);
  }));
</script>
</body></html>`;
  }
}
