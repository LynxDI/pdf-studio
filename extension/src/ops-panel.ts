// The "Operations" sidebar panel — the single build-and-reference surface for PDF Studio.
// Lists the full OPW operation vocabulary grouped by category (collapsed to the group level;
// the ＋ inserts an op into the active workflow, clicking a row opens its doc), plus a
// "Guides & setup" section (NVIDIA/OCR/Python guides, opened in an in-editor Markdown preview)
// and the "PDF Fill" form catalog (each opens the form's doc + a copy-paste fill_form workflow).
// Frozen search header. Strict nonce CSP, no remote resources (same bar as the pdf.js preview).

import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { OPERATIONS, OP_DOCS, OP_CATEGORIES, opSearchIndex, formCategories } from "@pdf-studio/core";
import { MCP_TOOLS } from "./sidebar/mcp-tools.js";

/** A distinct accent per category (indexed by OP_CATEGORIES order). */
const CATEGORY_COLORS = [
  "#4ec9b0", "#c084fc", "#4fc1ff", "#dcdcaa", "#f472b6", "#f59e0b",
  "#38bdf8", "#ef4444", "#10b981", "#a78bfa", "#fb923c", "#34d399",
];

/** Setup/how-to guides surfaced at the top of the panel. `doc` is a Markdown file bundled into
 *  the VSIX under resources/docs/ (build.mjs copies them); clicking opens it in VS Code's
 *  Markdown preview — offline, no external URL. */
const GUIDES: { title: string; desc: string; doc: string }[] = [
  {
    title: "AI models — NVIDIA free cloud endpoints",
    desc: "Run translate, semantic search & OCR on free NVIDIA models — no local GPU (riva-translate-4b, nv-embed-v1, llama-3.2-vision). Get a key, set env vars, go.",
    doc: "python-setup.md",
  },
  {
    title: "OCR engines — which to use (with benchmark)",
    desc: "Tesseract vs Marker vs PaddleOCR-VL vs Qwen3-VL, and why to run text_report before OCR.",
    doc: "ocr-engines.md",
  },
  {
    title: "Python backend & optional dependencies",
    desc: "PyMuPDF, OCR (Tesseract/OCRmyPDF), Marker, PaddleOCR-VL, receipt VLM — install + configure.",
    doc: "python-setup.md",
  },
  {
    title: "opw CLI — run workflows in CI / servers",
    desc: "The same engine outside the editor: render/validate a .opw.yaml headlessly for CI, cron, Docker or a terminal. Not needed inside VS Code (use ▶ Render).",
    doc: "cli.md",
  },
];

const esc = (s: unknown): string =>
  String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c] as string);

export class OperationsPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = "pdfStudioOperations";
  private view?: vscode.WebviewView;

  constructor(private readonly extensionUri: vscode.Uri) {}

  refresh(): void {
    if (this.view) this.view.webview.html = this.html(this.view.webview);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.description = `${Object.keys(OPERATIONS).length} operations + docs`;
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg: { type?: string; name?: string; doc?: string; form?: string } | undefined) => {
      if (!msg) return;
      switch (msg.type) {
        case "openDoc":
          if (msg.name) void vscode.commands.executeCommand("pdfStudio.showOpDoc", msg.name);
          break;
        case "addOp":
          // The ＋ — insert this operation into the active workflow.
          if (msg.name) void vscode.commands.executeCommand("pdfStudio.addNamedOperation", msg.name);
          break;
        case "copyExample":
          // The ⧉ — copy a ready-to-run example workflow for this op to the clipboard.
          if (msg.name) void vscode.commands.executeCommand("pdfStudio.copyOpExample", msg.name);
          break;
        case "openTool":
          // An MCP server-tool row → its doc.
          if (msg.name) void vscode.commands.executeCommand("pdfStudio.showMcpTool", msg.name);
          break;
        case "setupMcp":
          void vscode.commands.executeCommand("pdfStudio.setupMcp");
          break;
        case "howto":
          void vscode.commands.executeCommand("pdfStudio.showMcpTools");
          break;
        case "openForm":
          // A PDF Fill form row → its doc (fields + a copy-paste fill_form workflow).
          if (msg.form) void vscode.commands.executeCommand("pdfStudio.showFormDoc", msg.form);
          break;
        case "openGuide":
          // Open the bundled guide in VS Code's Markdown preview (offline, no external URL).
          if (msg.doc) {
            const uri = vscode.Uri.joinPath(this.extensionUri, "resources", "docs", msg.doc);
            void vscode.commands.executeCommand("markdown.showPreview", uri);
          }
          break;
        case "reference":
          void vscode.commands.executeCommand("pdfStudio.showOpReference");
          break;
      }
    });
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString("hex");

    // Each op category as a {title, html} entry. The accent stays tied to the category's
    // original index so it keeps the same color regardless of sort position. These get sorted
    // together with the PDF Fill group below, so PDF Fill lands in its natural A→Z slot.
    const opEntries = OP_CATEGORIES.map((cat, i) => {
      const color = CATEGORY_COLORS[i % CATEGORY_COLORS.length];
      const rows = cat.ops
        .map((name) => {
          const spec = OPERATIONS[name];
          if (!spec) return "";
          const doc = OP_DOCS[name];
          const desc = doc?.usage ?? spec.summary;
          // `usage` can run to several paragraphs; a tooltip wants the first one, while the
          // search index wants all of it (so "pptx" or "LibreOffice" finds office_to_pdf).
          const tip = desc.split(/\n{2,}/)[0]!.trim();
          const params = spec.params.map((p) => p.name + (p.required ? "*" : "")).join(", ") || "no params";
          // Aliases are searchable too — someone hunting "interleave" should land on
          // merge, and "metadata" on set_metadata.
          // Name (with and without underscores), aliases, search synonyms, description,
          // params and category — built in core so the vocabulary is unit-tested.
          const search = esc(opSearchIndex(name));
          // Name only (the "chapter"); hover shows the summary, click opens the doc, ＋ inserts it.
          return `<div class="row" data-name="${esc(name)}" data-search="${search}" title="${esc(tip)}">
            <span class="dot" style="background:${color}"></span>
            <div class="txt"><div class="name">${esc(name)}</div></div>
            <button class="copy" title="Copy an example ${esc(name)} workflow to the clipboard" data-name="${esc(name)}">⧉</button>
            <button class="add" title="Add ${esc(name)} to the active workflow" data-name="${esc(name)}">＋</button>
          </div>`;
        })
        .join("\n");
      // Collapsed by default → opens as a clean list of category headers (the group level);
      // expand a category to reveal its operation names.
      const html = `<div class="group collapsed" data-group="${i}">
        <div class="ghead"><span class="chev">▾</span><span class="gdot" style="background:${color}"></span><span class="gtitle">${esc(cat.title)}</span><span class="gcount">${cat.ops.length}</span></div>
        <div class="gbody">${rows}</div>
      </div>`;
      return { title: cat.title, html };
    });

    const guideRows = GUIDES.map((g) => {
      const search = esc(`${g.title} ${g.desc} guide setup nvidia ai cloud`.toLowerCase());
      return `<div class="row guide" data-doc="${esc(g.doc)}" data-search="${search}" title="Open the guide">
        <span class="dot" style="background:#7ee787"></span>
        <div class="txt"><div class="name">${esc(g.title)}</div><div class="desc">${esc(g.desc)}</div></div>
      </div>`;
    }).join("\n");
    const guidesGroup = `<div class="group" data-group="guides">
      <div class="ghead"><span class="chev">▾</span><span class="gdot" style="background:#7ee787"></span><span class="gtitle">Guides &amp; setup</span><span class="gcount">${GUIDES.length}</span></div>
      <div class="gbody">${guideRows}</div>
    </div>`;

    // MCP — the server-integration surface, folded in as a pinned group (replaces the former
    // standalone MCP Tools sidecar): set-up actions + the deterministic tools an AI agent calls.
    const MCP_COLOR = "#4fc1ff";
    const mcpActionRows = [
      { label: "Set up for this workspace", action: "setupMcp", desc: "Write .mcp.json + stage the MCP server into this project" },
      { label: "How to connect", action: "howto", desc: "How to connect the MCP server to your agent" },
    ]
      .map((a) => {
        const search = esc(`${a.label} ${a.desc} mcp setup connect agent`.toLowerCase());
        return `<div class="row guide" data-action="${a.action}" data-search="${search}" title="${esc(a.desc)}">
          <span class="dot" style="background:${MCP_COLOR}"></span>
          <div class="txt"><div class="name">${esc(a.label)}</div></div>
        </div>`;
      })
      .join("\n");
    const mcpToolRows = MCP_TOOLS.map((t) => {
      const search = esc(`${t.name} ${t.summary} ${t.signature} mcp tool`.toLowerCase());
      return `<div class="row" data-tool="${esc(t.name)}" data-search="${search}" title="${esc(t.summary)}">
        <span class="dot" style="background:${MCP_COLOR}"></span>
        <div class="txt"><div class="name">${esc(t.name)}</div></div>
      </div>`;
    }).join("\n");
    const mcpGroup = `<div class="group collapsed" data-group="mcp">
      <div class="ghead"><span class="chev">▾</span><span class="gdot" style="background:${MCP_COLOR}"></span><span class="gtitle">MCP</span><span class="gcount">${MCP_TOOLS.length}</span></div>
      <div class="gbody">${mcpActionRows}${mcpToolRows}</div>
    </div>`;

    // PDF Fill — the fillable-form catalog, as its own collapsed group. Each row opens the
    // form's doc (fields + a copy-paste fill_form workflow).
    const forms = formCategories().flatMap((c) => c.forms);
    const fillRows = forms
      .map((f) => {
        const meta = [f.category, f.issuer, `${f.fields.length} fields`, f.partial ? "partial mapping" : ""].filter(Boolean).join(" · ");
        const search = esc(`${f.id} ${f.title} ${f.category} ${f.issuer ?? ""} form fill pdf`.toLowerCase());
        return `<div class="row" data-form="${esc(f.id)}" data-search="${search}" title="${esc(meta)}">
          <span class="dot" style="background:#e879f9"></span>
          <div class="txt"><div class="name">${esc(f.title)}</div></div>
        </div>`;
      })
      .join("\n");
    const pdfFillGroup = forms.length
      ? `<div class="group collapsed" data-group="pdffill">
          <div class="ghead"><span class="chev">▾</span><span class="gdot" style="background:#e879f9"></span><span class="gtitle">PDF Fill</span><span class="gcount">${forms.length}</span></div>
          <div class="gbody">${fillRows}</div>
        </div>`
      : "";

    // Content groups (op categories + PDF Fill) sorted A→Z by title; PDF Fill therefore lands
    // right after "Pages & layout". Guides & setup stays pinned above the sorted list.
    const sortedGroups = [
      ...opEntries,
      ...(forms.length ? [{ title: "PDF Fill", html: pdfFillGroup }] : []),
    ]
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((e) => e.html)
      .join("\n");

    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;

    return `<!doctype html><html lang="en"><head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  html, body { height: 100%; }
  body { margin: 0; padding: 0; display: flex; flex-direction: column; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  /* Frozen header — the search box stays put; only the list below it scrolls. */
  .header { flex: 0 0 auto; padding: 6px 8px 4px; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); border-bottom: 1px solid var(--vscode-panel-border, #8883); }
  #list { flex: 1 1 auto; overflow-y: auto; padding: 0 8px 8px; }
  input#q { width: 100%; box-sizing: border-box; padding: 5px 8px; margin-bottom: 4px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; }
  .topbar { display: flex; align-items: center; gap: 8px; margin: 2px 0 6px; }
  .count { font-size: 11px; opacity: .6; }
  .ref { margin-left: auto; font-size: 11px; cursor: pointer; color: var(--vscode-textLink-foreground); background: none; border: none; padding: 0; }
  .ref:hover { text-decoration: underline; }
  .group { margin-bottom: 4px; }
  /* Opaque + above the rows (z-index) so rows scroll cleanly UNDER the sticky group header. */
  .ghead { display: flex; align-items: center; gap: 6px; padding: 5px 4px; cursor: pointer; user-select: none; position: sticky; top: 0; z-index: 2; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); border-bottom: 1px solid var(--vscode-panel-border, #8884); }
  .ghead:hover { background: var(--vscode-list-hoverBackground); }
  .chev { font-size: 10px; width: 10px; opacity: .8; transition: transform .1s; }
  .group.collapsed .chev { transform: rotate(-90deg); }
  .group.collapsed .gbody { display: none; }
  .gdot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
  .gtitle { font-weight: 600; font-size: 11.5px; }
  .gcount { font-size: 10px; opacity: .5; }
  /* Indent rows under their category, with a guide line, so the hierarchy reads. */
  .gbody { margin-left: 8px; padding-left: 10px; border-left: 1px solid var(--vscode-panel-border, #8883); }
  .row { display: flex; gap: 8px; align-items: flex-start; padding: 5px 4px; border-radius: 4px; cursor: pointer; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.hidden { display: none; }
  .dot { width: 7px; height: 7px; border-radius: 50%; margin-top: 5px; flex: 0 0 auto; opacity: .7; }
  .txt { min-width: 0; flex: 1; }
  .name { font-family: var(--vscode-editor-font-family, monospace); font-size: 12.5px; }
  .desc { font-size: 11px; opacity: .7; line-height: 1.3; }
  .add { flex: 0 0 auto; visibility: hidden; font-size: 13px; line-height: 1; padding: 2px 6px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; border-radius: 4px; }
  .row:hover .add { visibility: visible; }
  .copy { flex: 0 0 auto; visibility: hidden; font-size: 12px; line-height: 1; padding: 2px 6px; cursor: pointer; color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground, transparent); border: none; border-radius: 4px; opacity: .75; }
  .row:hover .copy { visibility: visible; }
  .copy:hover { opacity: 1; }
  .empty { opacity: .6; font-size: 12px; padding: 8px 4px; display: none; }
  .guide .name { color: var(--vscode-textLink-foreground); font-family: var(--vscode-font-family); font-size: 12px; font-weight: 600; }
</style></head>
<body>
  <div class="header">
    <input id="q" type="text" placeholder="Search operations, guides & forms…" />
    <div class="topbar"><span class="count" id="count"></span><button class="ref" id="ref" title="Open the full Markdown reference">Full reference ↗</button></div>
  </div>
  <div id="list">${guidesGroup}${mcpGroup}${sortedGroups}<div class="empty" id="empty">Nothing matches.</div></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const rows = Array.from(document.querySelectorAll('.row'));
  const opRows = rows.filter((r) => !r.classList.contains('guide') && !r.dataset.form && !r.dataset.tool);
  const groups = Array.from(document.querySelectorAll('.group'));
  const total = opRows.length;
  const q = document.getElementById('q');

  document.getElementById('ref').addEventListener('click', () => vscode.postMessage({ type: 'reference' }));

  document.getElementById('list').addEventListener('click', (e) => {
    const head = e.target.closest('.ghead');
    if (head) { head.parentElement.classList.toggle('collapsed'); return; }
    const copy = e.target.closest('.copy');
    if (copy) { vscode.postMessage({ type: 'copyExample', name: copy.dataset.name }); e.stopPropagation(); return; }
    const add = e.target.closest('.add');
    if (add) { vscode.postMessage({ type: 'addOp', name: add.dataset.name }); e.stopPropagation(); return; }
    const row = e.target.closest('.row');
    if (!row) return;
    if (row.dataset.action) vscode.postMessage({ type: row.dataset.action });
    else if (row.dataset.tool) vscode.postMessage({ type: 'openTool', name: row.dataset.tool });
    else if (row.dataset.form) vscode.postMessage({ type: 'openForm', form: row.dataset.form });
    else if (row.dataset.doc) vscode.postMessage({ type: 'openGuide', doc: row.dataset.doc });
    else vscode.postMessage({ type: 'openDoc', name: row.dataset.name });
  });

  q.addEventListener('input', apply);

  function apply() {
    const s = (q.value || '').toLowerCase().trim();
    // Every whitespace-separated term must match (AND), so "powerpoint merge" narrows
    // instead of returning nothing. Each term is still a plain substring — predictable,
    // and it keeps partials like "powerp" working.
    const terms = s ? s.split(/\s+/) : [];
    rows.forEach((row) => {
      const hay = row.dataset.search || '';
      const show = terms.every((t) => hay.includes(t));
      row.classList.toggle('hidden', !show);
    });
    groups.forEach((g) => {
      const any = g.querySelectorAll('.row:not(.hidden)').length > 0;
      g.style.display = any ? '' : 'none';
      if (s) g.classList.remove('collapsed');
    });
    const n = opRows.filter((r) => !r.classList.contains('hidden')).length;
    document.getElementById('empty').style.display = rows.some((r) => !r.classList.contains('hidden')) ? 'none' : 'block';
    document.getElementById('count').textContent = (s && n !== total) ? ('showing ' + n + ' of ' + total) : (total + ' operations');
  }
  apply();
</script>
</body></html>`;
  }
}
