# Changelog

All notable changes to Lynx PDF Studio are documented here.

## 0.7.1 — Programmable PDFs: fill forms, redact, compare, convert, automate

Lynx PDF Studio turns PDFs into **programmable build artifacts**: you edit an
**OpenPDF Workflow (OPW)** file — human-readable YAML — and a deterministic engine renders
the result through a `parse → validate → optimize → plan → render` pipeline. The workflow is
the source of truth; the PDF is a build artifact; **git is the undo stack**. Everything runs
**locally**. **70 operations across 13 categories.**

### Fill PDF forms from your records

- **`fill_form` — fill a real form without knowing its field names.** A per-form pack maps
  friendly keys to the PDF's actual AcroForm fields, handling the hard parts automatically:
  shared-name **radio groups** (`Sex → M/F`), **split** fields (SSN across three boxes, dates
  into M/D/Y), **dropdowns**, single-field date masks, and comb/`maxlen` truncation. Seeded
  with **6 forms across 3 categories** — DS-11 & DS-82 (passport), Form 1040 & W-9 (tax), W-4
  & I-9 (employment): `fill_form: { form: ds11, people: people.yaml, person: me }`.
- **People / records — enter once, fill many.** Personal data lives in one shared, **local,
  auto-gitignored `people.yaml`** holding many persons linked by `relations` (spouse, parents,
  dependents). Each fill picks a `person`; forms that need relatives pull them by role. The
  same file fills every form — a household today, a business's patients/clients tomorrow.
- **PDF Fill catalog.** A **PDF Fill** node in the Documentation sidebar lists supported forms
  by category; each opens a field reference plus a copy-paste workflow. The `fill_form` doc
  page shows an example for **every** form. Data-driven, so new packs appear automatically.
- **Preview, sign, lock.** `preview: true` reports exactly what will be filled before you
  commit; `signature: { image, field }` stamps a signature; `flatten: true` bakes a locked,
  print-ready final. Default output stays **editable** for review.
- **Extensible** — a new form is a drop-in JSON pack (a `harvest-form` tool stubs it from any
  blank PDF). Packs carry a field snapshot, so filling a changed PDF warns about a possible
  **form-revision mismatch**.

### Redaction you can trust

- **`redact` / `auto_redact` that truly delete.** A plain black box in most apps leaves the
  text underneath extractable; ours removes the content. Match by exact `text`, named PII
  **`patterns`** (`ssn`, `email`, `phone`, `credit_card`, `ein`, `ipv4`, `iban`), or custom
  `regex`; `ignore_case` / `whole_word` for control. **`rasterize: true`** flattens to an
  image-only PDF so nothing hidden (text layer, metadata, off-page content) survives —
  the safest way to share. `preview: true` lists every match first.

### Compare, convert, and read

- **`compare_pdfs`.** Page-aligned text diff (an inserted/deleted page is reported as
  added/removed, not a cascade of "changed") plus a precise visual diff. `side_by_side: true`
  assembles one shareable `diff.pdf`; `tolerance` ignores anti-aliasing noise.
- **Convert to/from PDF.** Office (docx/xlsx/pptx), HTML, Markdown, URL, `.eml`, and images
  **to** PDF; PDF **to** DOCX/PPTX/XLSX/HTML/Markdown. **`pdf_to_epub`** builds a reflowable
  **EPUB for Kindle** (Calibre when installed, else a bundled text-to-EPUB builder).
- **`split_invoices`.** Split a multi-invoice PDF into one file per invoice (page-counter
  resets, header keywords, invoice-number changes; `detect: ai` for irregular bundles), each
  named from the detected number/vendor/date, plus a `_manifest.csv`.

### PDF Intelligence (AI) — private by default

- **`summarize` & `translate`.** Run the PDF's text through a language model for a Markdown
  summary or translation; `translate` with `layout: true` renders a **translated PDF that
  keeps the original layout** (Latin + CJK fonts). Local via Ollama unless you set
  `ANTHROPIC_API_KEY`; opt-in behind `pdfStudio.allowAiRequests`.
- **AI OCR for scans (Marker)** with an optional **remote-GPU offload** over SSH.

### Assemble, edit & automate

- Merge, split, delete/reorder/rotate/insert/extract pages, crop, scale, `n_up`, booklet,
  poster, watermark, stamp, **`annotate`** (text/highlight/note/shapes/image), metadata,
  bookmarks, tables, page numbers, compress, linearize, repair, encrypt/decrypt, permissions,
  PDF/A, OCR, and digital signatures (`sign` / `validate_signature` / `timestamp`).
- **Output can be a file or a folder**; **batch** a whole workflow over many files with a glob
  in `inputs` (`*`, `?`, `**`) → per-input outputs (`output.folder` or a templated
  `output.file`), one bad file skipped and reported.

### Rendering, UI & backends

- **Bundled pdf-lib** renders layout/stamps/watermarks/metadata with **zero dependencies**;
  **live pdf.js preview** re-renders on save. Guided **Add Operation**, a searchable
  **Operations** panel, per-operation **Documentation** pages, and a color-coded
  **Dependencies** view for optional backends (Python/PyMuPDF, Ghostscript/qpdf, Tesseract,
  LibreOffice, Chrome/Edge, pyHanko, Calibre).

### Agent-native (MCP)

- A local **MCP server** (`pdf-studio`) exposes deterministic OPW helpers — `opw_validate`,
  `opw_compile`, `opw_optimize`, `opw_diff`, `opw_scaffold`, `opw_operations` — plus form
  tools `form_list`, `form_fields`, `form_people`, `form_scaffold`. It **never renders or
  writes files**; execution stays local, and the PDF never leaves your machine.
- A generated **agent map** (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`) teaches a coding agent
  the OPW vocabulary and ready recipes (redact-and-share, fill-a-form, batch) so it can author
  a workflow straight from a plain-English request.

### Security & privacy

- Untrusted-workflow hardening: input/output/asset paths (incl. `output.folder`, batch globs,
  and the records file) are confined to the project; the Python interpreter is pinned;
  `pythonPath` / `allowRemoteRender` / `allowAiRequests` are machine-scoped; webviews use a
  strict nonce CSP; `encrypt`/`decrypt`/`sign` secrets use `${ENV_VAR}` and stay out of files.
- **Anonymous, opt-out telemetry** (which features/operations are used) keyed only by
  `machineId` — **no** paths, contents, names, or personal data; honors VS Code's telemetry
  setting plus `pdfStudio.telemetry.enabled`.

Verified end-to-end by a real VS Code integration harness (`npm run verify`).
