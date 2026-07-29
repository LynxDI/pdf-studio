# Lynx PDF Studio Automation

**PDFs as code — built for coding agents.** You don't click a PDF editor, and you
don't even write the YAML: you tell a **coding agent** what you want, and it authors an
**OpenPDF Workflow (OPW)** file that a deterministic engine renders. 100 composable
operations, one workflow language. The workflow is the source of truth; the PDF is a
build artifact; git is the undo stack.

> The developer platform for PDF automation — the way FFmpeg is for video and
> OpenTimelineIO is for editing.

```
Video  →  OpenTimelineIO (OTIO)  →  ffmpeg   →  rendered video
PDF    →  OpenPDF Workflow (OPW)  →  pdf-lib  →  rendered PDF
```

**Built for coding agents.** The workflow itself becomes an editable software artifact
your agent maintains — from a plain-language conversation, not a WYSIWYG editor:

```
Prompt  →  Coding Agent  →  workflow.opw.yaml  →  git diff / review
        →  Validate → Optimize → Plan  →  deterministic engine  →  PDF
```

The agent (Claude Code, Codex, Gemini, Copilot, …) authors and keeps updating the
`.opw.yaml`; you review the diff before anything runs; a fixed engine does the work —
and the PDF never enters the model's context. A bundled MCP server exposes deterministic
OPW helpers, and a generated `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` teaches whichever
agent you use how to edit PDFs *here*.

---

## What is OPW?

**OpenPDF Workflow (OPW) is not another PDF format.** It is an open, deterministic
**workflow layer** that sits above content documents and below the engines that
render them:

```
Content layer     PDF   (later: PPTX, DOCX, SVG, images, video)
Workflow layer    OPW   ← you edit this
Execution layer   pdf-lib · PyMuPDF · pikepdf · qpdf · Ghostscript
```

An OPW file lists input documents and an ordered program of operations that
transform them into an output. It is human-readable YAML, git-friendly, and
AI-native — a coding agent edits the workflow, not the binary.

```yaml
version: 1
kind: pdf
inputs:
  - input/contract.pdf
  - input/appendix.pdf
operations:
  - merge: {}
  - delete_pages: { pages: [10, 11] }
  - rotate_pages: { pages: [1], degrees: 90 }
  - watermark: { text: INTERNAL, opacity: 0.15 }
  - set_metadata: { title: Contract, author: Legal }
output:
  file: output/contract_final.pdf
```

## The compiler pipeline

OPW is compiled, not interpreted ad-hoc. Authoring is separated from execution so
the rendering engine can be swapped without touching a single workflow file:

```
workflow.opw.yaml
    │  parse
    ▼
Validator        structural diagnostics (run after every edit)
    ▼
Optimizer        behavior-preserving rewrites (coalesce, drop no-ops)
    ▼
Execution Plan   ordered steps, each bound to a backend
    ▼
Renderer Adapter
    ▼
pdf-lib (bundled)  ·  PyMuPDF / pikepdf / qpdf / Ghostscript (optional)
    ▼
output/*.pdf
```

The **renderer-adapter seam** is what makes OPW an interoperability layer rather
than a file format: adapters advertise which *capabilities* and *document kinds*
they can execute, and the compiler binds each operation to the best available
backend. An operation whose capability no installed backend provides (e.g. `ocr`)
is reported as **unsatisfied** at plan time — never a runtime surprise.

## Zero-install by default, scale up when you need it

| Layer | Backend | Install | Capabilities |
|-------|---------|---------|--------------|
| Bundled | **pdf-lib** (JS/WASM) | none — works on install | merge, split, rotate, reorder, delete, extract pages, watermark, metadata, basic compress |
| Optional | **PyMuPDF / pikepdf / qpdf / Ghostscript / OCR** (Python) | `pip install …` | extract text, extract/replace images, true redaction, deep compression, OCR |
| Optional | **Marker** (Surya OCR + layout) | `pip install marker-pdf` | AI OCR: scanned books/PDFs → clean Markdown; optional remote-GPU render over SSH (`remote: user@host`) |

The extension's color-coded **Dependencies** sidebar shows exactly which backends
are available and what each unlocks, with one-click setup for the missing ones.

## Quick start

1. Open a folder in VS Code with the PDF Studio Automation extension installed.
2. Run **PDF Studio: Initialize Project** — seeds `workflow.opw.yaml` + sample inputs.
3. Edit the workflow (or let a coding agent edit it).
4. Save, or run **PDF Studio: Render Workflow** → `output/…` renders and previews in-editor.

Or try the committed example:

```bash
npm install
npm run build
```

## MCP tools (for coding agents)

The local `pdf-studio` MCP server exposes deterministic OPW helpers (it never
renders — the extension does that locally). GitHub Copilot / VS Code agent mode
pick it up automatically (native registration); Claude Code, Cursor and other
`.mcp.json` clients get it via **Set Up MCP for This Workspace**:

- `opw_validate` — structural diagnostics; run after every edit.
- `opw_compile` — preview the execution plan + unsatisfied capabilities.
- `opw_optimize` — behavior-preserving rewrites.
- `opw_diff` — semantic diff between two workflow revisions.
- `opw_operations` — list the operation vocabulary.
- `opw_scaffold` — generate a starter workflow.

## Monorepo layout

```
pdf-studio/
├── core/         @pdf-studio/core — OPW model, validate→optimize→compile pipeline,
│                 renderer adapters (pdf-lib), dependency probing. Pure Node.
├── mcp/          @pdf-studio/mcp  — stdio MCP server (deterministic OPW helpers).
├── extension/    pdf-studio       — the VS Code extension (sidebar, runner, preview).
├── examples/     runnable sample OPW projects.
└── docs/         the OPW spec, design spec, operation reference and guides.
```

Build everything: `npm run build`.

## Status

Shipping on the VS Code Marketplace — **100 operations across 14 categories**. In place:
the OPW engine and compile pipeline, the bundled pdf-lib backend (structural ops), the
Python adapter (text/table extraction, redaction, forms, OCR, deep compression, PDF/A,
Office ⇆ PDF), batch workflows over a glob, document recognition (`text_report` page-stats
triage, Marker AI OCR with optional remote-GPU render, `extract_receipt` vision extraction),
the MCP server, and the VS Code extension (searchable Operations panel, guided Add Operation,
color-coded dependencies, runner, pdf.js preview, project scaffolding, agent map). See
[docs/design-spec.md](docs/design-spec.md).

## License

**AGPL-3.0-or-later** — © 2026 Lynx DI. See [LICENSE](LICENSE) and
[LICENSING.md](LICENSING.md). Free to install from the VS Code Marketplace, and free to
use commercially — the AGPL restricts redistribution and modification, not use.

We chose AGPL because several optional backends Lynx PDF Studio Automation builds on are themselves AGPL
(PyMuPDF and Ghostscript, both dual-licensed by Artifex). A **commercial licence** is
available for anyone who needs to embed it in a closed-source product.

Bundled third-party components keep their own licences — see
[extension/NOTICE](extension/NOTICE).

## Changelog

[extension/CHANGELOG.md](extension/CHANGELOG.md) — the same file the Marketplace shows,
kept in one place rather than duplicated here.
