// The PDF Studio sidebar tree.
//
// Two top sections:
//   Workflows     — every *.opw.yaml, each expanding to its inputs + output.
//   Dependencies  — the execution backends, color-coded by availability:
//                     ● pdf-lib   available (bundled)      green
//                     ● PyMuPDF   available (1.24.0)       green
//                     ⚠ qpdf      not installed            yellow (clickable)
//
// The color coding follows the File Content Index pattern: a ThemeIcon tinted
// with a ThemeColor so availability actually pops (an untinted icon renders in
// the default foreground and reads as "no status"). Green = ready, yellow =
// optional-and-missing, red = errored probe.

import * as vscode from "vscode";
import { checkDependencies, inspectPdf, resolvePythonWithPyMuPDF, DEPENDENCY_TIERS, type DependencyStatus } from "@pdf-studio/core";
import { findWorkflowFiles, outputPath, configuredPythonPath, resolvePaddlePython, configuredVlmEndpoint, type WorkflowFile } from "../project.js";
import { matchesWorkflow, workflowMatchHint } from "../workflow-search.js";
import { inspectPdfDeep, type DeepPdfInfo } from "../python-inspect.js";
import * as fs from "node:fs";
import * as path from "node:path";

interface Node {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  /** ThemeColor id used to tint {@link icon}. */
  iconColor?: string;
  /** Custom icon (e.g. a bundled SVG) — takes precedence over {@link icon}. */
  iconPath?: vscode.TreeItem["iconPath"];
  contextValue?: string;
  collapsible?: vscode.TreeItemCollapsibleState;
  children?: Node[];
  resourceUri?: vscode.Uri;
  command?: vscode.Command;
  tooltip?: string;
  /** Carried on operation nodes so add/remove commands know the target. */
  wfUri?: vscode.Uri;
  opIndex?: number;
  /** Lazily-loaded node kinds (children fetched in getChildren on expand). */
  lazyKind?: "document";
  /** Absolute PDF path for a {@link lazyKind} === "document" node. */
  pdfPath?: string;
  /** 1-based page number, carried on page nodes so page-targeted ops know the target. */
  pageNumber?: number;
  /** Image object name (PyMuPDF), carried on image nodes → replace_image selector. */
  imageName?: string;
  /** Form field name, carried on field nodes → fill_field target. */
  fieldName?: string;
}

export class PdfStudioExplorer implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private deps: DependencyStatus[] | undefined;
  private depsLoading = false;
  /** The in-flight probe, so concurrent callers (config change + tree expand +
   *  Check Dependencies) coalesce onto one run instead of each spawning probes. */
  private depsInFlight: Promise<DependencyStatus[]> | undefined;
  /** Built object-map subtrees, keyed by pdfPath → { mtime:size, nodes }. The
   *  deep inspect (full read + pdf-lib load + PyMuPDF sidecar) is expensive on
   *  large PDFs; a plain tree refresh must not re-run it while the file is
   *  unchanged. The mtime:size key auto-invalidates when the file really changes
   *  (e.g. a re-rendered output). */
  private docCache = new Map<string, { key: string; nodes: Node[] }>();
  /** Active query narrowing the Workflows section ("" = show everything). Kept in
   *  memory only: a filter that survived a reload would look like a lost tree. */
  private filter = "";
  /** id → parent node, recorded as children are built, so {@link revealWorkflow}
   *  can walk a hit back up to the root (TreeView.reveal needs getParent). */
  private parents = new Map<string, Node>();
  /** The tree view, attached after creation so a search hit can be revealed. */
  private view: vscode.TreeView<Node> | undefined;

  constructor(
    private readonly extensionUri?: vscode.Uri,
    private readonly output?: vscode.LogOutputChannel,
  ) {}

  /** Give the provider its view, so it can reveal/select rows. */
  attachView(view: vscode.TreeView<Node>): void {
    this.view = view;
  }

  /** The query currently narrowing the Workflows section ("" when unfiltered). */
  get workflowFilter(): string {
    return this.filter;
  }

  /** Narrow the Workflows section to workflows matching `query` (path, operation,
   *  param, input, output, var). Empty string shows all of them again. */
  setWorkflowFilter(query: string): void {
    this.filter = query.trim();
    // Drives the ✕ "Clear Filter" button's `when` clause in the view title bar.
    void vscode.commands.executeCommand("setContext", "pdfStudio.workflowFilterActive", this.filter.length > 0);
    this.refresh();
  }

  /** What the Workflows section currently shows: its rows and its own
   *  count/filter description. Read by the integration harness. */
  async workflowRows(): Promise<{
    filter: string;
    description?: string;
    rows: Array<{ label: string; description?: string }>;
  }> {
    const section = (await this.rootSections()).find((s) => s.id === "section-workflows");
    const children = section?.children ?? [];
    const placeholder = children.length === 1 && /^no-workflow/.test(children[0]!.id);
    return {
      filter: this.filter,
      description: section?.description,
      rows: placeholder ? [] : children.map((c) => ({ label: c.label, description: c.description })),
    };
  }

  /** Reveal + select a workflow's row (best-effort — a no-op if it isn't in the
   *  tree, e.g. the active filter excludes it or the file just disappeared). */
  async revealWorkflow(relPath: string): Promise<void> {
    if (!this.view) return;
    const node = (await this.rootSections())
      .find((s) => s.id === "section-workflows")
      ?.children?.find((n) => n.id === `wf-${relPath}`);
    if (!node) return;
    try {
      await this.view.reveal(node, { select: true, focus: true, expand: true });
    } catch (err) {
      this.output?.info(`[search] could not reveal ${relPath}: ${(err as Error).message}`);
    }
  }

  private pymupdfAvailable(): boolean {
    return (this.deps ?? []).some((d) => d.id === "pymupdf" && d.state === "available");
  }

  private inspectScriptPath(): string | undefined {
    return this.extensionUri
      ? vscode.Uri.joinPath(this.extensionUri, "resources", "python", "pdf_inspect.py").fsPath
      : undefined;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  /** Re-probe backends and repaint the Dependencies section. */
  async refreshDependencies(): Promise<DependencyStatus[]> {
    if (this.depsInFlight) return this.depsInFlight; // coalesce concurrent probes
    this.depsLoading = true;
    this.refresh();
    this.depsInFlight = (async () => {
      try {
        this.deps = await checkDependencies({
          pythonPath: configuredPythonPath(),
          paddlePythonPath: resolvePaddlePython(),
          vlmEndpoint: configuredVlmEndpoint(),
        });
        return this.deps ?? [];
      } finally {
        this.depsLoading = false;
        this.depsInFlight = undefined;
        this.refresh();
      }
    })();
    return this.depsInFlight;
  }

  getTreeItem(n: Node): vscode.TreeItem {
    const item = new vscode.TreeItem(n.label, n.collapsible ?? vscode.TreeItemCollapsibleState.None);
    item.id = n.id;
    item.description = n.description;
    item.contextValue = n.contextValue;
    item.resourceUri = n.resourceUri;
    item.command = n.command;
    item.tooltip = n.tooltip;
    if (n.iconPath) {
      item.iconPath = n.iconPath;
    } else if (n.icon) {
      item.iconPath = n.iconColor
        ? new vscode.ThemeIcon(n.icon, new vscode.ThemeColor(n.iconColor))
        : new vscode.ThemeIcon(n.icon);
    }
    return item;
  }

  async getChildren(element?: Node): Promise<Node[]> {
    const children =
      element?.lazyKind === "document" ? await this.documentChildren(element) : element ? (element.children ?? []) : await this.rootSections();
    if (element) for (const c of children) this.parents.set(c.id, element);
    return children;
  }

  /** Required for TreeView.reveal. Nodes are rebuilt on every refresh, but ids are
   *  stable (getTreeItem sets them), so a freshly-built node resolves to its row. */
  getParent(n: Node): Node | undefined {
    return this.parents.get(n.id);
  }

  /** Read a PDF and build its object map: Metadata + Pages (each page a target). */
  private async documentChildren(node: Node): Promise<Node[]> {
    const p = node.pdfPath;
    if (!p) return [];
    let statKey = "";
    try {
      const st = await fs.promises.stat(p);
      statKey = `${st.mtimeMs}:${st.size}`;
      const hit = this.docCache.get(p);
      if (hit && hit.key === statKey) return hit.nodes; // unchanged → skip the expensive inspect
    } catch {
      /* stat failed — fall through; the read below will surface the real error */
    }
    try {
      // Prefer the out-of-process PyMuPDF sidecar for the object map: it reads
      // the file itself (no multi-MB slurp into the extension host) and never
      // blocks the event loop the way pdf-lib's synchronous load does on large
      // PDFs. pdf-lib is used only as a fallback when PyMuPDF isn't available.
      const script = this.inspectScriptPath();
      const python = await resolvePythonWithPyMuPDF(configuredPythonPath());
      const deep: DeepPdfInfo | null =
        script && python ? await inspectPdfDeep({ pdfPath: p, scriptPath: script, python, timeoutMs: 20_000 }) : null;

      type Meta = { title?: string; author?: string; subject?: string; keywords?: string; creator?: string; producer?: string; created?: string; modified?: string };
      let meta: Meta;
      let pages: Array<{ index: number; width: number; height: number; rotation: number }>;
      let pageCount: number;
      if (deep) {
        const md = deep.metadata;
        meta = { title: md.title, author: md.author, subject: md.subject, keywords: md.keywords, creator: md.creator, producer: md.producer, created: md.creationDate, modified: md.modDate };
        pages = deep.pages.map((dp) => ({ index: dp.index, width: dp.width, height: dp.height, rotation: dp.rotation }));
        pageCount = deep.page_count;
        const imgCount = deep.pages.reduce((a, pg) => a + pg.images.length, 0);
        this.output?.info(`[object-map] ${path.basename(p)}: ${imgCount} image(s), ${deep.fonts.length} font(s)${deep.fields.length ? `, ${deep.fields.length} field(s)` : ""}`);
      } else {
        const info = await inspectPdf(new Uint8Array(await fs.promises.readFile(p)));
        meta = { title: info.metadata.title, author: info.metadata.author, subject: info.metadata.subject, keywords: info.metadata.keywords, creator: info.metadata.creator, producer: info.metadata.producer, created: info.metadata.created, modified: info.metadata.modified };
        pages = info.pages.map((pg) => ({ index: pg.index, width: pg.width, height: pg.height, rotation: pg.rotation }));
        pageCount = info.pageCount;
        this.output?.info(
          script && python
            ? `[object-map] ${path.basename(p)}: deep inspect unavailable (sidecar failed — see logs); using pdf-lib`
            : `[object-map] ${path.basename(p)}: no PyMuPDF-capable Python found (install PyMuPDF for images/fonts/fields)`,
        );
      }

      const metaRows: Node[] = [];
      const add = (k: string, v: string | undefined) => {
        if (v) metaRows.push({ id: `${node.id}-m-${k}`, label: k, description: v, icon: "symbol-string" });
      };
      add("title", meta.title);
      add("author", meta.author);
      add("subject", meta.subject);
      add("keywords", meta.keywords);
      add("creator", meta.creator);
      add("producer", meta.producer);
      add("created", meta.created);
      add("modified", meta.modified);
      if (metaRows.length === 0) metaRows.push({ id: `${node.id}-m-none`, label: "(no metadata set)", icon: "dash" });

      const deepByPage = new Map((deep?.pages ?? []).map((dp) => [dp.index, dp]));

      const pageNodes: Node[] = pages.map((pg) => {
        const dp = deepByPage.get(pg.index);
        const imgNodes: Node[] = (dp?.images ?? []).map((im, k) => ({
          id: `${node.id}-p-${pg.index}-img-${k}`,
          label: im.object_name,
          description: `${im.width}×${im.height}${im.bbox ? ` · at ${im.bbox[0]},${im.bbox[1]}` : ""}`,
          icon: "file-media",
          // An image is a target: replace_image pre-fills page + object_name.
          contextValue: "pdf-image",
          wfUri: node.wfUri,
          pageNumber: pg.index,
          imageName: im.object_name,
        }));
        const extra = dp
          ? ` · ${dp.images.length} img${dp.text_chars ? ` · ${dp.text_chars} chars` : ""}`
          : "";
        return {
          id: `${node.id}-p-${pg.index}`,
          label: `Page ${pg.index}`,
          description: `${pg.width}×${pg.height} pt${pg.rotation ? ` · ${pg.rotation}°` : ""}${extra}`,
          icon: "file",
          contextValue: "pdf-page",
          wfUri: node.wfUri,
          pageNumber: pg.index,
          collapsible: imgNodes.length ? vscode.TreeItemCollapsibleState.Collapsed : undefined,
          children: imgNodes.length ? imgNodes : undefined,
        };
      });

      const sections: Node[] = [
        {
          id: `${node.id}-meta`,
          label: "Metadata",
          icon: "info",
          collapsible: vscode.TreeItemCollapsibleState.Collapsed,
          children: metaRows,
        },
        {
          id: `${node.id}-pages`,
          label: "Pages",
          description: String(pageCount),
          icon: "files",
          collapsible: vscode.TreeItemCollapsibleState.Collapsed,
          children: pageNodes,
        },
      ];

      if (deep) {
        if (deep.fonts.length) {
          sections.push({
            id: `${node.id}-fonts`,
            label: "Fonts",
            description: String(deep.fonts.length),
            icon: "text-size",
            collapsible: vscode.TreeItemCollapsibleState.Collapsed,
            children: deep.fonts.map((f, k) => ({
              id: `${node.id}-font-${k}`,
              label: f.name,
              description: `${f.type} · p${f.pages.join(",")}`,
              icon: "symbol-text",
            })),
          });
        }
        if (deep.fields.length) {
          sections.push({
            id: `${node.id}-fields`,
            label: "Form Fields",
            description: String(deep.fields.length),
            icon: "checklist",
            collapsible: vscode.TreeItemCollapsibleState.Collapsed,
            children: deep.fields.map((f, k) => ({
              id: `${node.id}-field-${k}`,
              label: f.name ?? "(unnamed)",
              description: `${f.type ?? ""}${f.value ? ` = ${f.value}` : ""} · p${f.page}`,
              icon: "symbol-field",
              contextValue: f.name ? "pdf-field" : undefined,
              wfUri: node.wfUri,
              fieldName: f.name ?? undefined,
            })),
          });
        }
        if (deep.bookmarks.length) {
          sections.push({
            id: `${node.id}-toc`,
            label: "Bookmarks",
            description: String(deep.bookmarks.length),
            icon: "bookmark",
            collapsible: vscode.TreeItemCollapsibleState.Collapsed,
            children: deep.bookmarks.map((b, k) => ({
              id: `${node.id}-bm-${k}`,
              label: `${"  ".repeat(Math.max(0, b.level - 1))}${b.title}`,
              description: `p${b.page}`,
              icon: "arrow-small-right",
            })),
          });
        }
      } else {
        const hasPy = python != null;
        sections.push({
          id: `${node.id}-more`,
          label: "Fonts · Images · Fields",
          description: hasPy ? "content map unavailable — see Logs" : "install PyMuPDF to map content objects",
          icon: "lock",
          tooltip: hasPy
            ? "A PyMuPDF-capable Python was found but the object-map sidecar returned no data (the PDF couldn't be read). Run 'Show Logs' for the reason."
            : "Content-level objects (embedded images, fonts, form fields) require the optional PyMuPDF backend. Install it from the Dependencies section (pip install PyMuPDF), then refresh.",
        });
      }

      if (statKey) this.docCache.set(p, { key: statKey, nodes: sections });
      return sections;
    } catch (err) {
      return [
        {
          id: `${node.id}-err`,
          label: "could not read PDF",
          description: (err as Error).message,
          icon: "error",
          iconColor: "problemsErrorIcon.foreground",
        },
      ];
    }
  }

  private async rootSections(): Promise<Node[]> {
    const Collapsed = vscode.TreeItemCollapsibleState.Collapsed;
    const Expanded = vscode.TreeItemCollapsibleState.Expanded;

    const all = await findWorkflowFiles();
    const q = this.filter;
    const workflows = q ? all.filter((wf) => matchesWorkflow(wf, q)) : all;
    const workflowNodes = workflows.map((wf) => this.workflowNode(wf, q));

    let emptyNode: Node;
    if (q) {
      emptyNode = {
        id: "no-workflow-matches",
        label: `No workflow matches “${q}”`,
        description: "click to clear",
        icon: "search-stop",
        command: { command: "pdfStudio.clearWorkflowFilter", title: "Clear Filter" },
      };
    } else {
      emptyNode = { id: "no-workflows", label: "No workflows yet", description: "run Initialize Project", icon: "info" };
    }

    const workflowsSection: Node = {
      id: "section-workflows",
      label: "Workflows",
      description: q ? `${workflows.length} of ${all.length} · “${q}”` : String(all.length),
      icon: q ? "filter-filled" : "list-tree",
      iconColor: q ? "list.highlightForeground" : undefined,
      tooltip: q
        ? `Filtered by “${q}” — ${workflows.length} of ${all.length} workflows shown. Clear the filter to see them all.`
        : "Every *.opw.yaml in this folder. Use the search icon to find one by name, operation, input or output.",
      contextValue: q ? "section-workflows-filtered" : "section-workflows",
      collapsible: Expanded,
      children: workflowNodes.length ? workflowNodes : [emptyNode],
    };

    const sections: Node[] = [workflowsSection, this.operationsNode(), this.dependencySection(Collapsed), this.supportNode(Collapsed)];
    // Register the parent links reveal() needs, without waiting for an expand.
    for (const child of workflowsSection.children ?? []) this.parents.set(child.id, workflowsSection);
    return sections;
  }

  /** Operations — reveals the searchable Operations webview panel: the single build-and-
   *  reference surface (the full op vocabulary with ＋ to add to a workflow and click-to-doc,
   *  plus the Guides & setup and PDF Fill sections). */
  private operationsNode(): Node {
    return {
      id: "section-operations",
      label: "Operations",
      description: "vocabulary, docs & forms",
      icon: "symbol-method",
      contextValue: "section-operations",
      tooltip: "Open the Operations panel — the full operation vocabulary (＋ adds to a workflow, click opens the doc), plus setup guides & the PDF Fill forms.",
      command: { command: "pdfStudioOperations.focus", title: "Open Operations" },
    };
  }

  /** Support links — email, Reddit, website — each opens externally on click. */
  private supportNode(collapsible: vscode.TreeItemCollapsibleState): Node {
    const link = (id: string, label: string, description: string, icon: string, url: string): Node => ({
      id,
      label,
      description,
      icon,
      command: { command: "pdfStudio.openExternal", title: "Open", arguments: [url] },
    });
    return {
      id: "section-support",
      label: "Support",
      icon: "heart",
      contextValue: "section-support",
      collapsible,
      children: [
        link("support-email", "info@lynxdi.com", "email", "mail", "mailto:info@lynxdi.com"),
        link("support-reddit", "Reddit", "r/user/LynxDI", "comment-discussion", "https://www.reddit.com/user/LynxDI/"),
        link("support-website", "lynxdi.com/pdf", "website", "globe", "https://www.lynxdi.com/pdf"),
      ],
    };
  }

  /** One workflow row. `filter` (when set) is echoed as a match hint on the row,
   *  so a filtered tree says *why* each survivor matched (`op: watermark`). */
  private workflowNode(wf: WorkflowFile, filter = ""): Node {
    const out = outputPath(wf);
    const outExists = out ? fs.existsSync(out) : false;
    const children: Node[] = [];

    if (wf.parseError) {
      children.push({ id: `${wf.relPath}-err`, label: "parse error", description: wf.parseError, icon: "error", iconColor: "problemsErrorIcon.foreground" });
    } else if (wf.workflow) {
      children.push({
        id: `${wf.relPath}-inputs`,
        label: "inputs",
        description: String(wf.workflow.inputs.length),
        icon: "file-pdf",
        collapsible: vscode.TreeItemCollapsibleState.Collapsed,
        children: wf.workflow.inputs.map((inp, i) => {
          const abs = path.resolve(wf.baseDir, inp);
          const exists = fs.existsSync(abs);
          return {
            id: `${wf.relPath}-in-${i}`,
            label: inp,
            description: exists ? "expand to inspect" : "missing",
            icon: exists ? "file-pdf" : "warning",
            iconColor: exists ? undefined : "list.warningForeground",
            // Expand an input to browse its object map (Metadata + Pages).
            collapsible: exists ? vscode.TreeItemCollapsibleState.Collapsed : undefined,
            lazyKind: exists ? "document" : undefined,
            contextValue: exists ? "pdf-input" : undefined,
            pdfPath: exists ? abs : undefined,
            wfUri: wf.uri,
          };
        }),
      });
      children.push({
        id: `${wf.relPath}-ops`,
        label: "operations",
        description: String(wf.workflow.operations.length),
        icon: "symbol-event",
        contextValue: "operations",
        wfUri: wf.uri,
        collapsible: vscode.TreeItemCollapsibleState.Expanded,
        children: wf.workflow.operations.map((op, i) => ({
          id: `${wf.relPath}-op-${i}`,
          label: op.name,
          description: Object.keys(op.params).length ? JSON.stringify(op.params) : undefined,
          icon: "chevron-right",
          contextValue: "operation",
          wfUri: wf.uri,
          opIndex: i,
        })),
      });
      children.push({
        id: `${wf.relPath}-output`,
        label: wf.workflow.output?.file || "(no output)",
        description: outExists ? "rendered · expand to inspect" : "not rendered",
        icon: outExists ? "file-pdf" : "circle-large-outline",
        iconColor: outExists ? "charts.green" : undefined,
        contextValue: "output",
        resourceUri: out ? vscode.Uri.file(out) : undefined,
        // Clicking previews; expanding shows the rendered document's object map.
        collapsible: outExists ? vscode.TreeItemCollapsibleState.Collapsed : undefined,
        lazyKind: outExists ? "document" : undefined,
        pdfPath: outExists ? (out ?? undefined) : undefined,
        wfUri: wf.uri,
        command: out && outExists ? { command: "pdfStudio.openPreview", title: "Preview", arguments: [wf.uri] } : undefined,
      });
    }

    return {
      id: `wf-${wf.relPath}`,
      label: wf.relPath,
      description: filter ? workflowMatchHint(wf, filter) : undefined,
      icon: "file-code",
      contextValue: "workflow",
      collapsible: vscode.TreeItemCollapsibleState.Collapsed,
      resourceUri: wf.uri,
      command: { command: "pdfStudio.openWorkflow", title: "Open", arguments: [wf.uri] },
      children,
    };
  }

  private dependencySection(collapsible: vscode.TreeItemCollapsibleState): Node {
    let children: Node[];
    if (this.depsLoading && !this.deps) {
      children = [{ id: "dep-loading", label: "probing backends…", icon: "loading~spin" }];
    } else if (!this.deps) {
      children = [{ id: "dep-unprobed", label: "click to check dependencies", icon: "sync", command: { command: "pdfStudio.checkDependencies", title: "Check" } }];
    } else {
      // Group by tier. A flat list made pillow-heif (one image format) look as
      // consequential as PyMuPDF (most of the operation set), and Marker — a
      // multi-gigabyte GPU stack — as routine as qpdf. The tier is what a user
      // actually needs in order to decide what is worth installing.
      children = [];
      for (const t of DEPENDENCY_TIERS) {
        const inTier = this.deps.filter((d) => d.tier === t.tier);
        if (inTier.length === 0) continue;
        const ready = inTier.filter((d) => d.state === "available").length;
        const missing = inTier.length - ready;
        children.push({
          id: `dep-tier-${t.tier}`,
          label: t.title,
          description: `${ready}/${inTier.length} ready`,
          // Only "recommended" nags when incomplete — per-feature and heavy tiers are
          // meant to be mostly uninstalled, so a warning there would cry wolf.
          icon: missing > 0 && t.tier === "recommended" ? "warning" : "layers",
          iconColor: missing > 0 && t.tier === "recommended" ? "list.warningForeground" : undefined,
          tooltip: `${t.title} — ${t.blurb}`,
          contextValue: `dep-tier-${t.tier}`,
          // Everything a user is likely to want is visible at a glance; the opt-in
          // heavy tier starts collapsed so it doesn't dominate the section.
          collapsible:
            t.tier === "heavy"
              ? vscode.TreeItemCollapsibleState.Collapsed
              : vscode.TreeItemCollapsibleState.Expanded,
          children: inTier.map((d) => this.dependencyNode(d)),
        });
      }
    }
    // The headline number counts what MATTERS: bundled + recommended. Counting the
    // optional tiers made a healthy install look like "8/20 ready".
    const core = (this.deps ?? []).filter((d) => d.tier === "bundled" || d.tier === "recommended");
    const coreReady = core.filter((d) => d.state === "available").length;
    const coreMissing = core.length - coreReady;
    return {
      id: "section-deps",
      label: "Dependencies",
      description: this.deps ? `core ${coreReady}/${core.length} ready` : undefined,
      icon: coreMissing > 0 ? "warning" : "package",
      iconColor: coreMissing > 0 ? "list.warningForeground" : undefined,
      contextValue: "section-deps",
      collapsible,
      children,
    };
  }

  private dependencyNode(d: DependencyStatus): Node {
    const icon =
      d.state === "available" ? "pass-filled" : d.state === "missing" ? "warning" : "error";
    const iconColor =
      d.state === "available"
        ? "testing.iconPassed"
        : d.state === "missing"
          ? "list.warningForeground"
          : "problemsErrorIcon.foreground";
    const tooltipParts = [d.detail];
    if (d.unlocks?.length) tooltipParts.push(`unlocks: ${d.unlocks.join(", ")}`);
    if (d.state === "missing" && d.installHint) tooltipParts.push(`install: ${d.installHint}`);
    return {
      id: `dep-${d.id}`,
      label: d.label,
      description: d.detail,
      icon,
      iconColor,
      tooltip: tooltipParts.join("\n"),
      contextValue: d.state === "missing" ? `dep-missing-${d.id}` : `dep-${d.id}`,
      command:
        d.state === "missing"
          ? { command: "pdfStudio.setupDependency", title: "Set up", arguments: [d] }
          : undefined,
    };
  }
}
