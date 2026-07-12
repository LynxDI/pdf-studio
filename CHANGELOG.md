# Changelog

All notable changes to Lynx PDF Studio are documented here.

## 0.2.15 — Settings shortcut in the view header

- **Gear icon** in the Lynx PDF Studio view header opens this extension's
  settings directly (scoped to `pdfStudio.*`) — a one-click path to toggles like
  `allowRemoteRender`, telemetry, and the Python path.

## 0.2.14 — Remote GPU rendering for Marker

- **Run Marker on a GPU box over SSH.** `extract_markdown` / `pdf_to_markdown`
  now take a `remote` parameter (`"user@host"`): the PDF is uploaded, Marker
  (Surya OCR + layout) runs there on the GPU, and the Markdown is downloaded —
  **minutes on a 4090 vs hours on a CPU** for a scanned book. Marker is
  auto-installed on the box on first use; VRAM-safe batch sizes let it share a
  partly-occupied card.

  ```yaml
  operations:
    - extract_markdown: { engine: marker, remote: user@gpu-box.local }
  ```

- **Off by default, opt-in via `pdfStudio.allowRemoteRender`** (machine-scoped, so
  a workspace can't enable it) — remote render runs commands on another machine
  over SSH, so it's disabled until you turn it on. Requires key-based SSH and
  `scp` on PATH; the host is validated against `user@host` to block shell
  injection. A `remote` param with the setting off fails with a clear message
  rather than silently falling back to slow CPU rendering.

## 0.2.7 — Anonymous usage analytics (opt-out)

- **Usage analytics (GA4)** to learn which features and operations are used most,
  so high-use ones can be prioritized. Events: `feature_used`, `operation_added`,
  `operation_used`, `workflow_rendered`, `activated` — anonymous, keyed only by
  `vscode.env.machineId`; **no** file paths, contents, names, or personal data.
- **On by default, easy to turn off:** respects VS Code's global
  `telemetry.telemetryLevel`, plus a dedicated `pdfStudio.telemetry.enabled`
  toggle. `pdfStudio.telemetry.debug` logs exactly what is sent.

## 0.2.6 — Convert any file to Markdown

- **Convert File to Markdown** — a new command (Explorer right-click on any
  supported file, or the palette) that turns Word / PowerPoint / Excel / HTML /
  EPUB / CSV / images and more into Markdown via Microsoft **MarkItDown**. A
  standalone utility (not an OPW op); MarkItDown is an optional, auto-detected
  backend with a one-click install prompt.

## 0.2.5 — PDF → Markdown + Marketplace listing

- **`pdf_to_markdown`** — convert a PDF to a Markdown (`.md`) file, discoverable
  under **Convert from PDF** (alias: `pdf_to_md`). Reuses the same engine as
  `extract_markdown` (pymupdf4llm / markitdown / PyMuPDF). OPW is now at **63 ops**.
- **Marketplace listing** — a visual README (hero, an in-action shot, the Operations
  panel, and the guided flow), with images and public docs hosted at
  [github.com/LynxDI/pdf-studio](https://github.com/LynxDI/pdf-studio).

## 0.2.3 — Three more operations

A second pass over Stirling-PDF surfaced three genuinely useful gaps, now ported
(OPW is at **62 operations**):

- **`pdf_info`** — write a read-only report of the PDF (page count, per-page
  size/rotation, metadata, encryption, fonts, image/field/annotation counts) to
  JSON. Great for inspection, agents, and CI. (PyMuPDF.)
- **`pdf_to_html`** — convert a PDF to HTML via the existing LibreOffice backend.
- **`single_page`** — combine every page into one tall page, stacked
  top-to-bottom, with an optional `gap`. (Bundled pdf-lib, no dependency.)

The remaining Stirling tools either need a heavy/niche dependency (OpenCV,
FFmpeg, Calibre, RAR, veraPDF) or would rasterize/degrade the text layer, so they
stay out of scope.

## 0.2.2 — Hardening

Follow-ups from the production-readiness review (non-blockers):

- **Security.** Path confinement now also rejects Windows drive-relative (`C:x`),
  drive-absolute, and UNC paths. Page numbers are validated 1-based for every op,
  so a `0`/negative can't silently edit the wrong page. A trust model is
  documented in `docs/security.md` (untrusted-workflow guidance for `url_to_pdf`/
  `html_to_pdf`, symlinks, and the sidecar's working directory).
- **Robustness.** Auto-render-on-save is coalesced per file (a slow render can't
  clobber newer output); the adapter registry is cached so backend probes aren't
  re-spawned every save; dependency probing is de-duplicated and skipped on
  startup when the window has no OPW project; the headless browser's whole process
  tree is killed on timeout; Read as Markdown fails gracefully on a missing file.
- **Safety.** `.mcp.json` setup refuses to overwrite a present-but-malformed file
  (previously it could drop your other servers).
- **Tests.** The `.opw.yaml` operation editor moved into core with unit tests
  (insert/remove, comment + CRLF preservation); added an extension unit-test lane
  (`.mcp.json` merge). 79 core + 7 MCP + 6 extension unit + 25 integration.

## 0.2.0 — First public release

Lynx PDF Studio turns PDFs into programmable build artifacts: you edit an
**OpenPDF Workflow (OPW)** file — human-readable YAML — and a deterministic engine
renders the PDF through a `parse → validate → optimize → plan → render` pipeline.

**Authoring**

- **59 operations** across twelve categories — pages & layout, stamps & overlays,
  metadata/bookmarks/tables, text·image·Markdown extraction, redaction & cleanup,
  forms, encryption & permissions, optimize/repair/archival, convert to/from PDF,
  and digital signatures.
- **Guided Add Operation** — pick an operation and fill its parameters with native
  controls (enum dropdowns, validated number inputs, list inputs, an optional-param
  multi-select) instead of hand-typing raw YAML.
- **Operations panel** — a searchable sidebar list of every operation, grouped by
  category; click to open docs, ＋ to add to the workflow.
- **Documentation** — a per-operation page for each op with a parameter table and a
  complete, copy-pasteable example workflow, plus a full Markdown reference.

**Rendering & preview**

- **Bundled pdf-lib backend** runs page layout, stamps, watermarks, page numbers,
  metadata, and image→PDF with zero external dependencies.
- **Live preview** via a built-in pdf.js viewer; the output re-renders on save.
- **Markdown / HTML / URL / .eml → PDF** render through a system Chrome or Edge in
  headless print mode for high fidelity (no bundled browser), falling back to
  WeasyPrint and a pure-Python engine so they always work.

**Optional backends** (auto-detected, shown in a color-coded Dependencies view):

- **Python** (PyMuPDF / pikepdf / OCRmyPDF / pymupdf4llm) — extraction, true
  redaction, sanitize, forms, encryption, OCR, PDF/A.
- **Ghostscript / qpdf** — deep compression and linearization.
- **Tesseract** — OCR text layer for scanned PDFs.
- **LibreOffice** — Office ⇆ PDF conversion (docx/xlsx/pptx/odt).
- **Chrome / Edge** — high-fidelity Markdown / HTML / URL rendering.
- **pyHanko** — digital signatures, signature validation, and RFC-3161 timestamps.

**Agent-native**

- A **local MCP server** exposes deterministic OPW helpers (`opw_validate`,
  `opw_compile`, `opw_optimize`, `opw_diff`, `opw_scaffold`, `opw_operations`). It
  never renders and never writes files; execution stays local in the extension.
- **Generated agent map** (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`) teaches a
  coding agent your project.

**Security & robustness**

- Untrusted-input hardening: workflow paths are confined to the project directory
  (no `..`, no absolute paths), the Python interpreter is pinned to its absolute
  path, `pdfStudio.pythonPath` is machine-scoped, and webviews use a strict nonce
  CSP with no remote resources.
- Secrets for `encrypt` / `decrypt` / `sign` use `${ENV_VAR}` substitution and stay
  out of the `.opw.yaml`.
- Creator operations (Markdown/HTML/… → PDF) are validated to run first with a
  matching input, so they can't be fed a working PDF by mistake.

Verified end-to-end by a real VS Code integration harness (`npm run verify`).
