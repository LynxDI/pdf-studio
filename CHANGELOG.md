# Changelog

All notable changes to Lynx PDF Studio are documented here.

## 0.10.3 — New form: USCIS I-765 (work permit / EAD) + Immigration category

Adds a **9th** fillable form — **USCIS Form I-765**, Application for Employment
Authorization (the work-permit / EAD application) — and a new **Immigration** category in
the PDF Fill catalog. Full coverage of Part 1 (reason for applying) and Part 2 (legal name,
mailing & physical addresses, A-Number, marital status, sex, SSN, country of citizenship,
place & date of birth, passport/travel document, last U.S. entry, current status, and the
eligibility-category code). Verified end-to-end with a copy-paste mock-up in the catalog.

## 0.10.2 — New form: IRS 1099-NEC (fills all copies at once)

Adds an **8th** fillable form — **IRS Form 1099-NEC** (Nonemployee Compensation). Full
coverage of the payer block, recipient block, account number, and the numbered boxes
(1a nonemployee comp, 1b–1d, 2–7 incl. the two-state rows). It's a multi-copy form, so
this ships a small engine feature: **one set of values fills every copy** (Copy A / 1 / B /
2) — enter the data once. The PDF Fill catalog shows a complete mock-up.

> **Note:** the downloadable **Copy A** (black ink) is *informational only* — the IRS
> can't accept it on paper. File by **e-file** or the official scannable **red-ink** form;
> print **Copy B/C** for the recipient. (Surfaced in the form's catalog doc.)

## 0.10.1 — New form: IRS W-7 (ITIN application)

Adds a **7th** fillable form — **IRS Form W-7**, the application for an Individual
Taxpayer Identification Number. Full single-page coverage: application type (new/renew),
reason for applying (a–h), name, mailing & foreign addresses, birth information, sex,
country of citizenship, identification documents (passport/license/USCIS), previous
ITIN/IRSN, and college/company details. Dates land correctly in the form's comb boxes.
Fill it from `people.yaml` or inline — the **PDF Fill** catalog shows a complete mock-up.

## 0.10.0 — PDF→SVG, viewer preferences, faster repeat searches

Gaps closed after a review of other PDF toolkits:

- **`render_pages` → SVG.** `format: svg` exports each page as **vector** graphics —
  infinite zoom, tiny files, no DPI to pick (PNG/JPG still the default). `text_as_path`
  keeps glyphs exact without the font, or emit selectable `<text>`.
- **`set_view_preferences` — control how a PDF opens.** Page layout (e.g. `TwoPageLeft`
  for a book spread), open mode (`FullScreen` for a kiosk/presentation, `UseOutlines` to
  reveal bookmarks), initial page + zoom (`fit` / `fit-width` / a percent), and window
  chrome (hide toolbar/menubar, fit/center window, show doc title).
- **Semantic search caches embeddings.** A repeat `semantic_search` on the same PDF now
  reuses the document's chunk embeddings (in the gitignored `.pdf-cache/`), so only the new
  query is embedded — subsequent searches are near-instant. `no_cache: true` opts out.

## 0.9.1 — Agent-map recipe for semantic search

The generated agent map (CLAUDE.md / AGENTS.md / GEMINI.md) now teaches coding agents
the **`semantic_search`** recipe — ask a PDF a question, run `ocr` first for scans, tune
`top_k`/`min_score` — so an agent can author it from a plain-English request.

## 0.9.0 — Semantic search, cleaner text extraction, page flip

**72 operations.** New capabilities:

- **`semantic_search` — ask your PDF a question.** Find passages by *meaning*, not
  keywords: a natural-language query returns the closest passages, ranked, **with page
  numbers**. It embeds the document with a **local** model (`nomic-embed-text` via Ollama
  by default), so nothing leaves your machine. Behind the `pdfStudio.allowAiRequests`
  setting; scanned PDF? run `ocr` first.
- **`extract_text` cleanup.** `clean: true` (or the individual `remove_headers_footers` /
  `fix_hyphenation` / `reflow` toggles) strips running headers/footers, rejoins
  hyphen-split words, and reflows hard-wrapped lines back into paragraphs — a big
  readability win on OCR'd or hard-wrapped documents. `page_markers: true` labels pages.
- **`flip_pages`.** Mirror pages horizontally or vertically — a true flip, not a rotation
  (for scans fed through a duplex feeder backwards, or transfer prints).
- **Security — HTML sanitized before print.** `html_to_pdf` / `markdown_to_pdf` /
  `url_to_pdf` / `eml_to_pdf` now strip `<script>`, `<iframe>`, event handlers,
  `javascript:` URLs, forms, and meta-refresh from the HTML before the browser renders it
  — layout/CSS/images are preserved. Complements the sandbox-on hardening from 0.7.9.
  (`sanitize: false` opts out for fully trusted HTML.)

## 0.8.0 — Programmable PDFs: fill forms, redact, compare, convert, automate

Lynx PDF Studio turns PDFs into **programmable build artifacts**: you edit an
**OpenPDF Workflow (OPW)** file — human-readable YAML — and a deterministic engine renders
the result through a `parse → validate → optimize → plan → render` pipeline. The workflow is
the source of truth; the PDF is a build artifact; **git is the undo stack**. Everything runs
**locally**. **70 operations across 13 categories.**

### Fill PDF forms — real government & tax forms, filled

- **`fill_form` — fill a real form without knowing its field names.** A per-form pack maps
  friendly keys to the PDF's actual AcroForm fields, handling the hard parts automatically:
  shared-name **radio groups** (`Sex → M/F`), **split** fields (SSN across three boxes, dates
  into M/D/Y), **dropdowns**, single-field date masks, and comb/`maxlen` truncation. Seeded
  with **6 forms across 3 categories** — DS-11 & DS-82 (passport), Form 1040 & W-9 (tax), W-4
  & I-9 (employment): `fill_form: { form: ds11, people: people.yaml, person: me }`.
- **Deep form coverage.** The **DS-11** passport application maps the **full form** (63
  fields) — applicant, both **parents**, **spouse** (via `relations.spouse`), marriage and
  **prior-passport history** (ever-applied, most-recent book/card name + status), occupation,
  travel plans, permanent address, and the complete emergency-contact block. Dates are
  **normalized to `MM/DD/YYYY`** however you type them, and a field can declare a `default`
  (DS-11's "Countries to be visited" auto-fills **none** when you leave it blank).
- **Correct, print-ready output.** Filled boxes show the form's own **check mark** (✓) on
  every ticked box, and filled government forms now **render identically in every viewer**.
  These forms are XFA-based, so `fill_form` drops the XFA layer and relies on the appearance
  streams it generates — fixing the classic **spaces-shown-as-`&`** corruption. It also
  **suggests `flatten: true`** to bake a locked, print-ready final. Add
  **`extract_pages`** to keep only the pages you submit (e.g. drop a form's instruction pages).
- **Two ways to supply data.** Draw from shared records (**`people:` + `person:`**) so one
  file fills many forms — or put **everything inline under `values:`** for a self-contained,
  copy-paste workflow. Explicit `values` always win over a record.
- **People / records — enter once, fill many.** Personal data lives in one shared, **local,
  auto-gitignored `people.yaml`** holding many persons linked by `relations` (spouse, parents,
  dependents). Each fill picks a `person`; forms that need relatives pull them by role. The
  same file fills every form — a household today, a business's patients/clients tomorrow.
- **PDF Fill catalog.** A **PDF Fill** node in the Documentation sidebar lists supported forms
  by category; each opens a field reference plus a **complete, self-contained mock-up
  workflow** you can copy, swap in your details, and Render. Data-driven, so new packs appear
  automatically.
- **Preview, sign, lock.** `preview: true` reports exactly what will be filled before you
  commit; `signature: { image, field }` stamps a signature; `flatten: true` bakes a locked,
  print-ready final. Default output stays **editable** for review.
- **Extensible** — a new form is a drop-in JSON pack (a `harvest-form` tool stubs it from any
  blank PDF), and a pack can ship a fully-worked `example`. Packs carry a field snapshot, so
  filling a changed PDF warns about a possible **form-revision mismatch**.

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

- Untrusted-workflow hardening: input/output/asset paths — **including the records/`people`
  file**, `output.folder`, and batch globs — are confined to the project (no `..`, absolute,
  drive-relative, or UNC escape); the Python interpreter is pinned; the system browser renders
  HTML/URL→PDF with its **security sandbox on**; Ghostscript runs with `-dSAFER`;
  `pythonPath` / `allowRemoteRender` / `allowAiRequests` are machine-scoped; webviews use a
  strict nonce CSP; `encrypt`/`decrypt`/`sign` secrets use `${ENV_VAR}` and stay out of files.
- **Anonymous, opt-out telemetry** (which features/operations are used) keyed only by
  `machineId` — **no** paths, contents, names, or personal data; honors VS Code's telemetry
  setting plus `pdfStudio.telemetry.enabled`.
- Hardened against a **four-part security review** (path confinement, process/secret handling,
  data egress, webview/PII) — see `docs/security-review.md`.

Verified end-to-end by a real VS Code integration harness (`npm run verify`).
