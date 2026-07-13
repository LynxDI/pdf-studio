<p align="center">
  <img src="https://raw.githubusercontent.com/LynxDI/pdf-studio/main/media/hero.png" alt="Lynx PDF Studio — PDFs as code" width="840" />
</p>

<h1 align="center">Lynx PDF Studio for VS Code</h1>

<p align="center"><b>Agentic, git-native PDF automation.</b><br/>Edit an OpenPDF Workflow file; a deterministic engine renders the PDF.</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=LynxDI.lynxdi-pdf-studio"><img src="https://img.shields.io/visual-studio-marketplace/v/LynxDI.lynxdi-pdf-studio?color=2dd4bf&label=Marketplace&logo=visualstudiocode" alt="Marketplace"></a>
  <img src="https://img.shields.io/badge/operations-63-2dd4bf" alt="63 operations">
  <img src="https://img.shields.io/badge/backends-pdf--lib%20bundled-3fb950" alt="pdf-lib bundled">
  <img src="https://img.shields.io/badge/agent--native-MCP-4fc1ff" alt="MCP">
</p>

You don't click around a PDF editor — you edit an **OpenPDF Workflow (OPW)** file,
and a deterministic engine renders the PDF. The workflow is the source of truth;
the PDF is a build artifact; **git is your undo stack.**

```yaml
# workflow.opw.yaml
version: 1
kind: pdf
inputs:
  - input/contract.pdf
  - input/appendix.pdf
operations:
  - merge: {}
  - delete_pages: { pages: [10, 11] }
  - watermark: { text: INTERNAL, opacity: 0.15 }
  - add_page_numbers: { format: "Page {n} of {total}", position: bottom-right }
  - set_metadata: { title: Contract, author: Legal }
output:
  file: output/contract_final.pdf
```

## See it in action

Save the file and the PDF re-renders. Diff it, revert it, review it in a PR —
it's just code.

<p align="center">
  <img src="https://raw.githubusercontent.com/LynxDI/pdf-studio/main/media/in-action.png" alt="Editing an OPW workflow with live PDF preview, the operations sidebar, and color-coded dependencies" width="900" />
</p>

## Why it's different

- **Code-first, not click-first.** Every change is a line in a human-readable
  YAML file — versionable, diffable, reproducible. No opaque binary edits.
- **Deterministic pipeline.** `parse → validate → optimize → plan → render`. The
  same workflow always produces the same PDF; the plan is previewable and hashable.
- **Agent-native.** A local MCP server exposes deterministic OPW helpers so any
  MCP-capable coding agent can edit your workflow safely — with a generated
  `CLAUDE.md` / `AGENTS.md` that teaches it your project.
- **Batteries included, nothing required.** The bundled engine renders many
  operations with zero external dependencies; advanced ones light up when their
  optional backend is present.

## Discover and build without memorizing YAML

<table>
<tr>
<td width="52%" valign="top">

**Searchable Operations panel** — all **62 operations** grouped by category. Search,
click to open the docs, or ＋ to add one to the active workflow.

**Guided Add Operation** — pick an operation and fill its parameters with native
controls: dropdowns for choices, validated number boxes, list inputs. No hand-typing
raw YAML.

**Per-operation Documentation** — every op has a page with a summary, a parameter
table, and a complete, copy-pasteable example workflow.

**Live preview & color-coded Dependencies** — the output re-renders on save; every
backend shows green when ready, amber with a one-click install hint when not.

</td>
<td width="48%" valign="top">
<img src="https://raw.githubusercontent.com/LynxDI/pdf-studio/main/media/operations-panel.png" alt="Searchable Operations panel grouped by category" width="330" />
</td>
</tr>
</table>

<p align="center">
  <img src="https://raw.githubusercontent.com/LynxDI/pdf-studio/main/media/guided-add.png" alt="Guided Add Operation with native dropdowns" width="560" />
</p>

## 63 operations, twelve categories

Everything is one line in the `operations:` list:

- **Pages & layout** — merge, split, delete / reorder / rotate / extract pages,
  crop, scale, N-up, booklet, poster, single-page.
- **Stamps & overlays** — watermark, positioned stamp, page numbers, overlay.
- **Metadata, bookmarks & tables** — set metadata, set/extract bookmarks, export
  fields and detected tables to CSV, `pdf_info` report.
- **Text, image & Markdown extraction** — text, images, clean Markdown
  (GitHub-flavored tables), **AI OCR for scans** (Marker / Surya), render pages to
  images, replace an image.
- **Redaction & cleanup** — true redaction, find-and-redact text, sanitize, remove
  annotations / images / blank pages, OCR.
- **Forms** — fill fields, flatten, unlock.
- **Encryption & permissions** — AES-256 encrypt / decrypt, set permissions.
- **Optimize, repair & archival** — compress, linearize, repair, decompress,
  rasterize, PDF/A.
- **Convert to PDF** — Markdown, HTML, a live URL, `.eml`, images, Office docs.
- **Convert from PDF** — docx / pptx / xlsx / html / Markdown.
- **Digital signatures** — sign (PKCS#12), validate, RFC-3161 timestamp.

## Markdown / HTML / URL → PDF, high fidelity, no bloat

`markdown_to_pdf`, `html_to_pdf`, `url_to_pdf`, and `eml_to_pdf` render through a
**system Chrome or Edge** in headless print mode for full-fidelity output — no
200 MB bundled browser. When no browser is present they fall back to WeasyPrint and
then a pure-Python engine, so they always work.

## Scanned books & documents → Markdown (AI OCR)

Old scans with a poor or missing text layer? `extract_markdown` and
`pdf_to_markdown` can run **Marker** (Surya OCR + layout models) to rebuild clean,
GitHub-flavored Markdown — headings, lists, and tables intact — straight from the
page images:

```yaml
operations:
  - extract_markdown: { engine: marker }
```

Marker is accurate but heavy. For a full book, **offload it to a GPU box over SSH
with one parameter — minutes on a GPU vs hours on a CPU:**

```yaml
operations:
  - extract_markdown: { engine: marker, remote: user@gpu-box }   # 138-page scan → ~1 min on a 4090
```

The PDF is uploaded, Marker runs on the remote GPU, and the Markdown is downloaded.
Off by default — enable `pdfStudio.allowRemoteRender`; it runs over key-based SSH,
and the host is validated to block command injection. For lighter scans,
`ocr_first: true` runs an OCRmyPDF/Tesseract pass before extraction — no GPU needed.

## Convert any file to Markdown

Beyond PDFs: right-click **any** file in the Explorer → **Convert File to
Markdown**, or run it from the palette. Powered by Microsoft **MarkItDown**, it
turns Word / PowerPoint / Excel / HTML / EPUB / CSV / images and more into clean
Markdown — handy for docs, diffs, and LLM ingestion. (Install MarkItDown when
prompted; it's an optional backend.)

## Execution backends

The bundled **pdf-lib** backend runs page layout, stamps, watermarks, metadata, and
image→PDF with **zero external dependencies**. Advanced operations use optional
backends the extension auto-detects:

| Backend | Unlocks |
|---|---|
| **Python** (PyMuPDF / pikepdf / OCRmyPDF / pymupdf4llm) | extraction, redaction, sanitize, forms, encryption, OCR, PDF/A, info |
| **Marker** (Surya OCR + layout) | AI OCR: scanned books / PDFs → clean Markdown; optional remote GPU render |
| **Ghostscript / qpdf** | deep compression, linearization |
| **Tesseract** | OCR text layer |
| **LibreOffice** | Office ⇆ PDF conversion |
| **Chrome / Edge** | high-fidelity Markdown / HTML / URL → PDF |
| **pyHanko** | digital signatures, timestamps |

Until a backend is installed, `opw_compile` reports its operations as
`unsatisfied` — nothing fails silently.

## Getting started

1. **Lynx PDF Studio: Initialize Project** — seeds `workflow.opw.yaml` + sample inputs.
2. Edit the workflow — by hand, the **Operations** panel, guided **Add Operation…**,
   or your coding agent.
3. **Render Workflow** (▶ in the sidebar) — writes `output/*.pdf`.
4. **Open Preview** — see the result; it re-renders on save.

## Agent-native (MCP)

A local MCP server exposes deterministic OPW helpers — `opw_validate`,
`opw_compile`, `opw_optimize`, `opw_diff`, `opw_scaffold`, `opw_operations` — so an
MCP-capable agent can author and check workflows without ever touching the PDF
directly. The server never renders and never writes files. **Set Up MCP for This
Workspace** wires it into your project in one step.

## Security & trust model

A workflow is treated as **potentially untrusted** — it may be cloned, shared, or
agent-authored. Input/output/asset paths are confined to the project directory,
`${ENV_VAR}` expands only in password params (never into `text`/`url`/metadata), the
Python interpreter is pinned, and webviews use a strict CSP. Because `url_to_pdf` /
`html_to_pdf` fetch network and local resources by design, review an untrusted
workflow before rendering it. Full details:
[docs/security.md](https://github.com/LynxDI/pdf-studio/blob/main/docs/security.md).

## Telemetry

Lynx PDF Studio collects **anonymous, non-identifying** usage events (which
features and operations are used, and whether a render succeeded) to help
prioritize development. It **never** collects file paths, document contents,
names, or any personal data — only `vscode.env.machineId` (an anonymized
per-install id). Events are only sent when VS Code's global telemetry setting
(`telemetry.telemetryLevel`) is enabled; you can also turn off just this
extension's analytics with `pdfStudio.telemetry.enabled`. Set
`pdfStudio.telemetry.debug` to see exactly what is sent.

## About

**Lynx PDF Studio** is built by Lynx DI. Explore more at
[lynxdi.com](https://lynxdi.com).

## License

Proprietary — Copyright © 2026 Lynx DI. All rights reserved. See [LICENSE](LICENSE).
Bundled third-party components remain under their own licenses (see [NOTICE](NOTICE)).
