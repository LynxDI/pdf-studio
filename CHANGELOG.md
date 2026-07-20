# Changelog

All notable changes to Lynx PDF Studio are documented here.

## 0.17.5 — `replace_text`: find-and-replace, in place

The workflow-shaped answer to "can it edit a PDF?" — no canvas, one line per replacement,
batchable over a folder:

```yaml
- replace_text: { find: "ACME Corp", replace: "Initech LLC" }
```

- The matched text is **truly deleted** (redaction, not a cover-up), and the replacement lands
  on the **original baseline in the original size and colour**. `ignore_case`, `whole_word`,
  and `pages` refine the match; `replace: ""` deletes; `preview: true` reports every match and
  changes nothing.
- **Font honesty:** an embedded, subsetted original font cannot render *new* glyphs, so the
  replacement uses the closest base-14 look — serif originals map to Times, monospace to
  Courier, everything else to Helvetica, keeping bold/italic (read from the span's own flags,
  which are more reliable than subset font names). Use it for utility edits — re-dating a
  template, fixing a recurring typo, swapping an entity name — not typography-preserving ones.
- Matching is per **line** and literal: text that wraps across lines won't match, and the note
  says so when nothing is found. A replacement much wider than what it replaced is warned
  about, with the overflow measured in points.

## 0.17.4 — The whole form lifecycle: make one, fill one, read them all back

Lynx PDF Studio turns PDFs into **programmable build artifacts**: you edit an
**OpenPDF Workflow (OPW)** file — human-readable YAML — and a deterministic engine renders the
result through a `parse → validate → optimize → plan → render` pipeline. The workflow is the
source of truth; the PDF is a build artifact; **git is the undo stack**. Everything runs
**locally**. **79 operations across thirteen categories.**

This release closes the loop on forms. You can now **build** a fillable PDF from a Word
document, **fill** it (or any of 12 real government forms) from your own records, and **read**
a stack of completed ones back into a spreadsheet — all on your machine, nothing uploaded.

### Start here — a Get Started walkthrough

- **Help → Get Started → Lynx PDF Studio.** Four steps, each one command: render a PDF from a
  workflow · fill a real government form from your records · turn a Word doc into a fillable
  PDF and read the answers back as a CSV · light up the optional backends.

### Make a form — `create_form`

Every fillable form used to be one *someone else* authored. Now you make your own: write the
document in **Word** (or Markdown/HTML), type a marker where each field belongs, and get a real
AcroForm PDF. Word controls the layout; the fields are injected after conversion — so the same
operation works for Markdown and HTML too, and there's no OOXML parsing anywhere.

```yaml
inputs:  [onboarding.docx]
operations:
  - office_to_pdf: {}
  - create_form: { debug: true }
output:  { file: output/onboarding-fillable.pdf }
```

- **That's the whole config.** Tags are type names — `[[text]]`, `[[check]]`, `[[date]]`,
  `[[money]]`, `[[sign]]` — used as often as you like. You never invent a unique name: they're
  numbered in reading order (`checkbox_01`, `text_03`…), so tagging a 100-checkbox intake form
  is copy-paste. Fields **size themselves to their table cell** and get a visible border.
- **text · date · money · number · phone · ssn · zip · checkbox · dropdown · listbox ·
  signature.** A typed field is a plain box with a **tooltip** stating what it wants and a
  **length cap** — both work in every viewer and cannot fail. **A generated form contains no
  JavaScript**: a PDF can only police typing with JS, which Chrome/Edge/Preview mostly ignore
  and our own `sanitize` strips — while a picture validator will reject a date you typed
  correctly and throw it away. Validate in the pipeline instead, where nothing can be destroyed.
- **A generated codebook.** `form-map.json` records the text printed beside every field
  (`"near": "I/We would like any REFUND electronically deposited…"`), so you always know which
  `checkbox_47` is which question. `debug: true` outlines every field so you can see where they
  landed; `preview: true` dry-runs and writes no PDF.
- **It fails loudly rather than shipping a broken form.** A marker too long for its column is
  *clipped* by the renderer — a naive tool then creates no field **and** bakes a mangled
  `[[emplo` into the page while reporting success. The run stops and names the tag. Duplicate
  tags, undeclared tags, rotated pages, off-page and overlapping fields are all reported.
- **`[[sign]]` creates a real signature field** — hand it to `sign` (pyHanko) for a complete
  local signing pipeline, no cloud round-trip.
- Verified on a real 4-page accounting-firm tax worksheet: **117 fields** (95 checkboxes, 22
  text) across Yes/No tables, checklists, a quarterly-payments grid and contact rows — layout,
  logo and typography untouched.

### Fill a form — `fill_form`, now with 12 forms and a spreadsheet

- **12 real forms across 4 categories**, mapped to their actual field names so you don't have to
  know that a W-9's name box is `topmostSubform[0].Page1[0].f1_01[0]`: **Passport** (DS-11,
  DS-82) · **Tax** (1040, **Schedule C**, **Schedule SE**, W-9, **W-8BEN**, W-4, W-7 ITIN,
  1099-NEC) · **Employment** (I-9) · **Immigration** (I-765 EAD). The freelancer set chains:
  1099-NEC → Schedule C → Schedule SE fills end to end from one set of values, and W-9/W-8BEN
  are the U.S. and foreign-vendor counterparts you hand a payer.
- **Records from a spreadsheet.** A household has a `people.yaml`; a business has a CSV already
  exported from a system that holds the data. `records: vendors.csv` now works — one row per
  record, column headers as the field keys. Headers normalise the way humans title them
  (`First Name` → `first_name`), dotted headers nest so a flat sheet carries the address block
  (`address.city`), and RFC 4180 quoting, embedded newlines and Excel's BOM are handled.
- The pack handles the hard parts: shared-name **radio groups**, **split** fields (SSN across
  boxes, dates into M/D/Y), **dropdowns**, date masks, comb/`maxlen` truncation, and
  **multi-copy** forms (1099-NEC's four copies fill from one set of values).
- **Form packs record their provenance** — `source_url` + `captured`, the issuer's canonical URL
  for the blank and the date the field snapshot was taken, so a new revision can be diffed
  against what a pack was built from.

### Read them back — `extract_form`

- **The inverse of `fill_form`.** Point at one PDF or a whole folder (`inputs: ["intake/*.pdf"]`
  — all matches fold into **one table**) and get structured data out. Each PDF is auto-identified
  from its field signature, so a folder of mixed forms works.
- **JSON *and* CSV, every run.** Per-form JSON plus a combined `forms.json`, and **one CSV per
  form type** (`w9.csv`, `f1040.csv`) — unrelated schemas never share a table. A CSV's columns
  come from the pack in the form's own field order, so the **header is stable across runs** and
  a downstream table built once keeps working.
- **A form you built with `create_form` needs no pack at all** — nothing matches it, so its
  fields are read **raw** (field name → value) into `raw.csv`, which is exactly right because
  its field names *are* the keys. Template → fillable → filled → CSV, with nothing authored.
- **Bulk with stop/resume.** `forms.json` doubles as a ledger keyed by **content hash**: drop new
  files in and run again, and only the new or changed forms are read. Walk a 500-form backlog in
  as many sittings as you like.

### Read, search & understand

- **`semantic_search` — ask a PDF a question.** Find passages by *meaning*, not keywords, ranked
  **with page numbers**. Embeds with a **local** model (`nomic-embed-text` via Ollama); a repeat
  search reuses cached embeddings. Nothing leaves your machine.
- **`summarize` & `translate`** via a local LLM by default, or Claude with an API key;
  `translate: { layout: true }` keeps the layout. Opt-in behind `pdfStudio.allowAiRequests`.
- **Cleaner text extraction** (`extract_text: { clean: true }` strips running headers/footers,
  rejoins hyphen-split words, reflows hard wraps) and **AI OCR for scans (Marker)** with an
  optional **remote-GPU offload** over SSH.

### Dark mode & appearance

- **`recolor: { mode: dark }`** — a real dark mode for reading: light-on-dark text, while
  embedded **photos and logos stay normal** instead of becoming negatives. `invert` and
  `grayscale` too. **`scanner_effect`** makes a born-digital PDF look scanned.

### Redaction & security inspection

- **`redact` / `auto_redact` that truly delete.** Match by exact `text`, named PII **`patterns`**
  (`ssn`, `email`, `phone`, `credit_card`, `ein`, `ipv4`, `iban`), or custom `regex`.
  **`rasterize: true`** flattens to an image-only PDF so nothing hidden survives; `preview: true`
  lists every match first.
- **`extract_js`** reports embedded JavaScript for inspection; **`sanitize`** strips JS,
  metadata, embedded files, and links.

### Compare, convert & assemble

- **`compare_pdfs`** — page-aligned text diff plus a precise visual diff; `side_by_side: true`
  assembles one shareable `diff.pdf`.
- **Convert to/from PDF.** Office (docx/xlsx/pptx), HTML, Markdown, URL, `.eml`, EPUB, and images
  (PNG/JPEG/WEBP/TIFF/GIF/BMP/SVG, HEIC with pillow-heif) → PDF; PDF →
  DOCX/PPTX/XLSX/HTML/Markdown/SVG/EPUB.
- **`split_invoices`** — one file per invoice, named from the detected number/vendor/date.
- Merge, split, delete/reorder/rotate/flip/insert/extract pages, crop, scale, `n_up`, booklet,
  poster, watermark, stamp, `annotate`, metadata, bookmarks, tables, page numbers,
  `set_view_preferences`, compress, linearize, repair, PDF/A, OCR, encrypt/decrypt, permissions,
  and digital signatures (`sign` / `validate_signature` / `timestamp`).
- **Batch** a whole workflow over many files with a glob in `inputs` → per-input outputs, one bad
  file skipped and reported. An op can declare `consumesAllInputs`, so a glob feeds **one** run
  instead of running once per file — the mechanism behind `extract_form`'s single table.

### Rendering, UI & backends

- **Bundled pdf-lib** renders layout/stamps/watermarks/metadata and PNG/JPEG→PDF with **zero
  dependencies**; **live pdf.js preview** re-renders on save. Guided **Add Operation**, a
  searchable **Operations** panel, per-operation **Documentation**, a **PDF Fill** catalog, and a
  colour-coded **Dependencies** view for optional backends (Python/PyMuPDF, Ghostscript/qpdf,
  Tesseract, LibreOffice, Chrome/Edge, pyHanko, Marker, Calibre).

### Agent-native (MCP)

- A local **MCP server** exposes deterministic OPW helpers (`opw_validate`, `opw_compile`,
  `opw_optimize`, `opw_diff`, `opw_scaffold`, `opw_operations`) plus form tools (`form_list`,
  `form_fields`, `form_people`, `form_scaffold`). It **never renders or writes files**.
- A generated **agent map** (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`) teaches a coding agent the
  OPW vocabulary and ready recipes — redact-and-share, fill-a-form, make-a-form, ask-a-PDF, batch.

### Security & privacy

- **Untrusted-workflow hardening.** Input/output/asset paths (including the records file,
  `output.folder`, and batch globs) are confined to the project — no `..`/absolute/UNC escape;
  the Python interpreter is pinned; `pythonPath` / `allowRemoteRender` / `allowAiRequests` are
  machine-scoped; webviews use a strict nonce CSP; `encrypt`/`decrypt`/`sign` secrets use
  `${ENV_VAR}` and never touch a command line, log, or output. DPI is clamped so a crafted
  workflow can't request a memory-exhausting render. Hardened against a **four-part security
  review** (see `docs/security-review.md`).
- **Safe rendering of untrusted content.** HTML→PDF keeps the system browser's exploit sandbox
  **on** and strips `<script>`/embeds/handlers first; **`eml_to_pdf` blocks remote images by
  default** so an email can't phone home with a tracking pixel.
- **Private by design.** New projects auto-gitignore `people.yaml`, `*.people.yaml` and the
  embedding cache, and seed a `.gitattributes` (`*.pdf binary`) so git knows what it's storing.
  AI ops stay local (Ollama) unless you opt in. **Anonymous, opt-out telemetry** keyed only by
  `machineId` — **no** paths, contents, names, or personal data.

Verified end-to-end by a real VS Code integration harness (`npm run verify`): 145 engine tests,
a 25-test form-creation suite, and a live VS Code that installs the built extension and drives
its commands.
