// Agent-map / chat-instructions CONTENT — the single source of truth for the
// OPW guidance we hand to coding agents.
//
// Deliberately vscode-free (only @pdf-studio/core) so it can be imported from
// TWO places:
//   1. the extension host, via agent-map.ts (writes CLAUDE.md/AGENTS.md/GEMINI.md
//      into a user workspace), and
//   2. build.mjs at package time, to generate the Copilot `chatInstructions`
//      markdown shipped in the VSIX — so Copilot users get byte-for-byte the same
//      onboarding as Claude Code / Codex / Gemini, from one source.
// Keep this module free of `vscode`/`node:fs`/`node:path` imports for (2) to work.

import { OPERATIONS, VERSION as CORE_VERSION } from "@pdf-studio/core";

/** Build the agent-map markdown. Lists the live operation vocabulary. */
export function buildAgentMap(opts: { extensionVersion: string }): string {
  const opRows = Object.values(OPERATIONS)
    .map((s) => `| \`${s.name}\` | ${s.capability} | ${s.summary} |`)
    .join("\n");

  return `# PDF Studio — Editing PDFs as Code

This workspace is a **PDF Studio** project. You edit PDFs here by editing an
**OpenPDF Workflow (OPW)** file — a plain, human-readable YAML program that a
deterministic engine applies to input documents to render an output PDF.
**Editing a PDF here = editing the \`.opw.yaml\`.** The workflow is the single
source of truth; the PDF is a build artifact, and **git is the undo stack**.

- **Workflow file(s):** \`*.opw.yaml\` (usually \`workflow.opw.yaml\`)
- **Inputs:** \`input/\` — source documents (immutable; never edited in place).
- **Assets:** \`assets/\` — images/stamps referenced by operations.
- **Output:** \`output/\` — rendered PDFs (regenerated; safe to delete).
- **Do NOT touch:** \`.pdf-cache/\` (proxies/thumbnails) and \`output/\` — regenerated.
- **PDF Studio extension:** v${opts.extensionVersion} · **engine (@pdf-studio/core):** ${CORE_VERSION}
- **MCP server:** \`pdf-studio\` (deterministic OPW helpers — wired via \`.mcp.json\`; it never renders).

## Prime directive
1. Edit the \`*.opw.yaml\` directly with **Read / Edit / Grep** — it is YAML.
2. Make **surgical** edits and **preserve unknown fields** — forward-compatible
   keys must survive an edit. Never reformat the whole file.
3. After **every** edit, call the **\`opw_validate\`** MCP tool and fix every error.
4. Prefer editing the workflow over touching the PDF. The PDF is output.

## The compiler pipeline

    workflow.opw.yaml
        │  parse
        ▼
    Validator      ← opw_validate: structural diagnostics (run after every edit)
        ▼
    Optimizer      ← behavior-preserving rewrites (opw_optimize)
        ▼
    Execution Plan ← opw_compile: which backend runs each op; what's unsatisfied
        ▼
    Renderer Adapter
        ▼
    pdf-lib (bundled)  ·  PyMuPDF / pikepdf / qpdf / Ghostscript (optional)
        ▼
    output/*.pdf

OPW is **not a PDF format** — it is a workflow layer above the content (PDF) and
below the execution engines. The same DSL is designed to target other document
kinds later (\`kind: pdf\` today).

## The OPW file you are editing

\`\`\`yaml
version: 1
kind: pdf                       # content domain (only "pdf" is wired today)
inputs:                          # ordered source documents, relative paths
  - input/contract.pdf
  - input/appendix.pdf
assets:                          # optional named assets used by operations
  logo: assets/logo.png
operations:                      # applied top-to-bottom; each is one key
  - merge: {}
  - delete_pages: { pages: [10, 11] }
  - rotate_pages: { pages: [1], degrees: 90 }
  - watermark: { text: INTERNAL, opacity: 0.15 }
  - set_metadata: { title: Contract, author: Legal }
output:
  file: output/contract_final.pdf   # ONE rendered PDF
\`\`\`

- **Pages are 1-based** everywhere in OPW.
- Any \`pages\` / \`from_pages\` / \`order\` list takes numbers **and compact ranges**:
  \`[1, "5-8", "10-last", "last"]\`. Prefer a range over spelling out every number —
  \`pages: ["300-800"]\`, not 501 integers. A malformed token is a validation error.
- **Page numbers are positional and operations renumber the document.** A page
  number means the page in that slot *when the op runs*, so an op written after
  \`merge\` / \`delete_pages\` / \`move_pages\` sees different numbering than one
  written before it. When you know a page number from reading the INPUT file, put
  the op **before** the first op that changes pagination.
- \`reorder_pages\` needs a **complete** permutation — every page exactly once. It
  is not a way to drop pages, and a partial list is refused. To move a few pages
  use \`move_pages: { pages: [2, "5-9"], after: 50 }\`, to exchange two use
  \`swap_pages: { a: 2, b: 10 }\`, to keep a subset use \`extract_pages\`.
- Operations run **in order**; think of it as a pipeline over one working document.
- \`merge\` builds the working document from **all** inputs; without it only the
  first input is used.

### Output: a file OR a folder

- \`output: { file: output/x.pdf }\` — the workflow renders **one** document.
- \`output: { folder: output/dir }\` — for operations that emit **many** files (e.g.
  \`split_invoices\` → one PDF per invoice), every emitted file is written into that
  directory. No single-PDF passthrough is produced.
- \`output\` may be **omitted entirely** when an operation already emits its own files.

\`\`\`yaml
# Split a bundled-invoices PDF into one PDF per invoice, named by invoice number.
version: 1
kind: pdf
inputs:
  - input/invoice-bundle.pdf
operations:
  - split_invoices: { name: "{invoice_number}", ocr_first: true }  # ocr_first for scans
output:
  folder: output/invoices          # each invoice PDF + a _manifest.csv land here
\`\`\`

### Splitting to fit a size limit

When someone says "these have to be under 5 MB to upload", **do not compute page ranges by
hand** — \`split\` has a size mode that measures each part:

\`\`\`yaml
version: 1
kind: pdf
inputs: [application.pdf]
operations:
  - compress: {}
  - split:
      max_size: "4.8MB"                 # headroom under a 5 MB cap
      name: "application-part-{i:02}"
output: { folder: output/parts }
\`\`\`

- Give \`max_size\` a **unit**: \`"5MB"\` = 5,000,000; \`"5MiB"\` = 5,242,880. Most upload
  validators check the binary one, so leave headroom rather than guessing which they meant.
  No hidden safety margin is applied.
- \`every: N\` splits by page COUNT and cannot honour a size limit — pages are not uniform.
  Only \`max_size\` gives a guarantee.
- A page too large to fit on its own is emitted alone with a warning; the run does not fail.
- \`name\` tokens: \`{stem} {name} {ext} {i} {start} {end} {n}\`, zero-padded as \`{i:03}\` —
  the same set a batch \`output.file\` uses. \`burst\` is \`split\` with \`every: 1\`.

### Batch: run the workflow over many files

A **glob** in \`inputs\` (\`*\`, \`?\`, or \`**\`) runs the whole workflow **once per matched
file**. The output must be per-input: an \`output.folder\` (each result named by the
input) or a **templated** \`output.file\` with \`{stem}\`/\`{name}\`/\`{ext}\`/\`{i}\`. One bad
file is skipped, not fatal.

\`\`\`yaml
version: 1
kind: pdf
inputs:
  - "invoices/*.pdf"               # BATCH: every match runs the ops below
operations:
  - compress: {}
  - watermark: { text: PAID }
output:
  folder: output/processed         # → output/processed/<input-name>.pdf per file
\`\`\`

**A folding op turns batch OFF.** \`merge\`, \`extract_form\`, \`extract_links\`,
\`extract_annotations\` and \`extract_receipt\` read every input together, so a glob feeds
them **ONE** run in sorted filename order rather than one run per file — and the output is
a plain \`output.file\`, not a templated one. This is the difference between "one PDF per
input" and "one PDF from all inputs":

\`\`\`yaml
inputs: ["docs/*.pdf"]
operations: [ { merge: {} } ]     # ← folds: ALL matches → ONE PDF
output: { file: output/combined.pdf }
\`\`\`

**Converting a folder of non-PDFs.** A creator that converts ONE document
(\`office_to_pdf\`, \`markdown_to_pdf\`, \`html_to_pdf\`, \`eml_to_pdf\`, \`epub_to_pdf\`)
composes with a fold: each input is converted first, then folded. So a folder of
PowerPoint decks goes either way, and the ONLY difference is whether \`merge\` is present:

\`\`\`yaml
# One PDF per deck.
inputs: ["decks/*.pptx"]
operations: [ { office_to_pdf: { from: pptx } } ]
output: { file: "output/{stem}.pdf" }
\`\`\`

\`\`\`yaml
# Every deck folded into ONE PDF, in sorted filename order (name them 01-, 02-, 03-).
inputs: ["decks/*.pptx"]
operations:
  - office_to_pdf: { from: pptx }
  - merge: {}
output: { file: output/course.pdf }
\`\`\`

\`office_to_pdf\` needs LibreOffice. Creators that read EVERY input at once
(\`images_to_pdf\`) or none (\`url_to_pdf\`) cannot be folded this way — putting one before
\`merge\` is a validation error (\`creator_before_fold\`).

**\`merge\` accepts MIXED types — do not add a conversion step per type.** Any input that
isn't a PDF is converted automatically, picked by its extension; PDFs pass through. So the
answer to "combine these PDFs, this Word doc and these photos" is a bare \`merge\`:

\`\`\`yaml
version: 1
kind: pdf
inputs:
  - cover.pdf                  # as-is
  - summary.docx               # → office_to_pdf   (LibreOffice)
  - chart.png                  # → images_to_pdf   (bundled)
  - notes.md                   # → markdown_to_pdf
operations:
  - merge: {}
output: { file: output/pack.pdf }
\`\`\`

\`inputs: [input/*]\` does the same for a whole folder of mixed files, in sorted filename
order. \`merge: { convert: false }\` restores strict PDF-only behaviour. \`opw_compile\`
lists any backend the conversions need, so check it before telling a user to install
something.

### Variables: make one workflow reusable (\`vars\`)

Declare \`vars:\` (scalar values) and reference them as \`\${name}\` in operation params and
the output path, so one workflow is a **template** you re-target by editing the values
(or a runtime override) instead of hand-editing every op. **Quote every \`\${...}\`** — an
unquoted \`\${\` starts a YAML flow-map. A whole-value ref (\`size: "\${n}"\`) keeps the
variable's TYPE (a number stays a number); an embedded ref (\`"\${client} report"\`) is
string-interpolated. Vars are **file-local** — they never read environment variables.

\`\`\`yaml
version: 1
kind: pdf
vars:
  client: acme
  label: CONFIDENTIAL
inputs:
  - input/report.pdf
operations:
  - watermark: { text: "\${label}" }
  - set_metadata: { title: "\${client} report" }
output:
  file: "output/\${client}-report.pdf"
\`\`\`

### Conditionals: run an op only when it's needed (\`when:\`)

Add a **\`when:\`** guard (a sibling key on the op) so it runs only when a predicate is
true. Predicates read **document facts** and \`vars\` as identifiers, with \`== != < <= > >=\`,
\`&& || !\`, parentheses, and literals (numbers, \`'strings'\`, \`true\`/\`false\`). **Quote the
expression.** The classic use is *skip OCR when the document already has a text layer*:

\`\`\`yaml
operations:
  - ocr: {}
    when: "has_text == false"        # only scans that lack a real text layer
  - convert_colors: { mode: gray }
    when: "pages > 20"               # only long documents
\`\`\`

Facts: \`pages\`, \`pdf_version\` (e.g. 1.7), \`encrypted\`, \`tagged\`, \`size_kb\` (bundled) ·
\`has_text\`, \`has_images\` (need the Python backend). Facts are a per-input snapshot; in
batch each file is judged independently. A skipped op is reported, not an error.

### Redact: hide personal info and share safely

When the user wants to **hide/redact** information (a name, account number, SSN,
address, an amount…), author an **\`auto_redact\`** — it permanently DELETES the
matched content (not just covers it). Match by:
- **\`text\`** — the EXACT strings the user gave (a list). Case-sensitive by default;
  add **\`ignore_case: true\`**, or **\`whole_word: true\`** so "Ann" ≠ "Anniversary".
- **\`patterns\`** — named PII shapes: \`ssn\`, \`email\`, \`phone\`, \`credit_card\`, \`ein\`,
  \`ipv4\`, \`iban\` (heuristics — always preview).
- **\`regex\`** — a custom pattern for a specific format.

Add **\`rasterize: true\`** to also flatten the whole document to an image-only PDF, so
nothing hidden (text layer, metadata, off-page content) can survive — the safest
thing to share. The render note reports any rule that matched nothing — tell the user
to verify. For a destructive op, **preview first**: set **\`preview: true\`** for a dry
run that writes \`output/redaction-preview.md\` (page + matched text + rule) and applies
NOTHING; the user reviews it, then you remove \`preview\` to apply. (To hide a region by
coordinates instead, use \`redact\` with \`rects: [[x,y,w,h]]\`, also with \`rasterize: true\`.)

\`\`\`yaml
# "Create a workflow to redact my name, account number, my email and any SSNs on
#  statement.pdf and give me a version that's safe to share."
#  → author this .opw.yaml, opw_validate, render. (Add preview: true first to verify.)
version: 1
kind: pdf
inputs:
  - input/statement.pdf
operations:
  - auto_redact:
      text: ["Jane Whitfield", "123456789"]   # ← the user's exact values to hide
      patterns: ["email", "ssn"]              # ← plus every email / SSN by shape
      ignore_case: true                        # match regardless of case
      rasterize: true                          # flatten to image → unrecoverable
      dpi: 150
output:
  file: output/statement-redacted.pdf
\`\`\`

### Mark text instead of deleting it

When the ask is to **highlight / flag / mark / call out** text rather than hide it, author a
**\`highlight\`** — the non-destructive twin of \`auto_redact\`, with the SAME matcher
(\`text\`, \`patterns\`, \`regex\`, \`ignore_case\`, \`whole_word\`, \`preview\`). Do NOT reach for
\`annotate\` for this: that one needs the page number up front and only matches a literal
string on that one page. \`highlight\` sweeps the whole document (or just \`pages\`).

- **\`style\`** — \`highlight\` (default), \`underline\`, \`strikeout\`, \`squiggly\`, \`box\`.
- **\`color\`** / **\`opacity\`** — any \`"#RRGGBB"\`; each style has a sensible default.
- **\`note\`** / **\`author\`** — a popup comment on every mark, for a reviewer.

The marks are real PDF annotations: \`extract_annotations\` pulls them back out and
\`remove_annotations\` clears them. \`flatten: true\` bakes them into the page permanently
(and both of those ops stop seeing them). Matching is per visual line — a phrase broken
across a line break won't match, so search for a fragment that fits on one line.

\`\`\`yaml
# "Highlight every mention of Confidential and any email address in the contract,
#  and leave a note on each one."
version: 1
kind: pdf
inputs:
  - input/contract.pdf
operations:
  - highlight:
      text: ["Confidential"]
      patterns: ["email"]
      style: highlight
      color: "#ffd400"
      ignore_case: true
      note: "flagged for review"
output:
  file: output/contract-marked.pdf
\`\`\`

### Fill a PDF form (from your records)

To fill a known form (passport, tax, HR…), use **\`fill_form\`** — you never type raw
AcroForm field names. Personal data lives in one shared, **local, gitignored**
\`people.yaml\` (many persons, linked by \`relations\`); each fill picks a \`person\`.

1. **Discover** the form + its fields with the MCP tools: \`form_list\` → \`form_fields\`.
   Get a starter records file with \`form_people\` (or run "Create People (records) File").
2. **Author** a \`people.yaml\` with the user's details (SSN, DOB, address…). Prefer
   \`people:\`+\`person:\` over inline \`values:\` so PII stays out of the workflow file.
3. **Fill:** \`fill_form: { form, people, person }\`. The form pack maps friendly keys to
   the real fields (checkboxes, radio groups, split SSN/date boxes). Add \`values:\` for
   form-specific fields, \`roles:\` to bind relatives (spouse/parents), \`signature:\` +
   \`flatten: true\` for a locked final. **Run with \`preview: true\` first** for a dry-run
   report of exactly what will be filled.

\`\`\`yaml
# "Fill the DS-11 passport application for me from my details."
version: 1
kind: pdf
inputs:
  - input/ds11_pdf.pdf
operations:
  - fill_form:
      form: ds11              # see form_list; f1040 (tax) also supported
      people: people.yaml     # your local, gitignored records
      person: me              # whose info fills it (pulls parents/spouse via relations)
      # preview: true          # dry-run report first (recommended)
      # flatten: true          # bake a locked, print-ready final
output:
  file: output/ds11-filled.pdf
\`\`\`

### Make a template into a fillable PDF (create_form)

**\`create_form\`** turns a document the user ALREADY OWNS (Word/Markdown/HTML) into a real
fillable PDF. The author types a marker where each field belongs; a conversion op renders the
layout, then create_form deletes each marker and puts an AcroForm field in its place. Put a
conversion op FIRST — forgetting it is the most common mistake.

**Prefer the TYPE-TOKEN form: \`[[text]]\`, \`[[check]]\`, \`[[date]]\`, \`[[sign]]\`.** Repeat them
freely — they're auto-numbered in reading order (text_01, checkbox_01, checkbox_02…), so there
is nothing to name and NO config file. Use a named tag (\`[[employee_name]]\`) only when the
field name itself must be meaningful.

\`\`\`yaml
# "Make this onboarding Word doc fillable."
version: 1
kind: pdf
inputs:
  - onboarding.docx
operations:
  - office_to_pdf: {}          # needs LibreOffice; use markdown_to_pdf / html_to_pdf for those
  - create_form:
      debug: true              # a copy with each field outlined, to check placement
      # preview: true          # dry run: writes the field map, renders no PDF
output:
  file: output/onboarding-fillable.pdf
\`\`\`

Fields fill their table cell automatically and get a visible border. For types/tooltips/choices,
add a sidecar YAML keyed by tag (named tags only):

\`\`\`yaml
# form-fields.yaml — types: text|date|checkbox|dropdown|listbox|signature
fields:
  employee_name: { type: text, required: true, tooltip: "Legal name" }
  department:    { type: dropdown, choices: [Engineering, Sales] }
  signature:     { type: signature }
\`\`\`

**KEEP TAGS SHORT.** A marker that doesn't fit its column WRAPS or gets clipped by the renderer;
create_form then fails the run rather than ship a form with a missing field and a mangled
\`[[emplo\` on the page. In a tight table cell, also set the marker's font small in Word — it's
deleted anyway, and the field is sized to the CELL, not the marker. Radio groups aren't
supported (use a dropdown, or a checkbox per option).

**The tag key becomes the PDF field name**, so the whole lifecycle needs no form pack:

\`\`\`yaml
  - fill_form: { fields: { text_01: "Jane Whitfield", checkbox_01: "Yes" } }
\`\`\`
…and \`extract_form\` reads a create_form-built PDF RAW (field name → value) into \`raw.csv\`.

### Read filled forms back out to data (bulk, resumable)

**\`extract_form\`** is the inverse of \`fill_form\`: the same pack that fills a form reads one
back, so any supported form → structured data with no extra setup. A glob folds every match
into ONE table (it is NOT batched), so this works for a single form or a 500-form backlog.

\`\`\`yaml
# "Turn the folder of filled W-9s and W-8BENs into a CSV for our vendor system."
version: 1
kind: pdf
inputs:
  - "intake/*.pdf"            # one file or a whole folder; mixed forms are fine
operations:
  - extract_form:
      to: output/extracted    # → <name>.json per form + forms.json + one CSV per form type
      # form: w9              # omit to auto-detect each PDF by its field signature
      # resume: false         # default true: re-runs read only new/changed files
output: {}                    # extract_form emits its own files
\`\`\`

Re-running after dropping new files in extracts only those and merges them into the table
(\`forms.json\` is the ledger, keyed by content hash). Dates come back as \`YYYY-MM-DD\` and split
SSNs as digits. A flattened PDF has no fields left — extract BEFORE \`flatten: true\`.

### Ask a PDF a question (semantic search)

When the user wants to **find where a PDF talks about something** — by meaning, not exact
words ("where does it cover late-cancellation refunds?") — use **\`semantic_search\`**. It
embeds the document with a **local** model and writes a ranked Markdown report of the
closest passages, each **with its page number**. Nothing leaves the machine.

- Needs the **\`pdfStudio.allowAiRequests\`** setting on, and a local **Ollama** with an
  embedding model: \`ollama pull nomic-embed-text\`. (\`OLLAMA_HOST\` can point at another
  box; \`model:\` overrides the embedding model.)
- **Scanned PDF?** It has no text layer — run **\`ocr\`** first (same workflow, earlier step).
- Tune \`top_k\` (how many passages) and \`min_score\` (drop weak matches). Read-only: the
  PDF is never modified; results go to \`to\` (default \`output/search-results.md\`).

\`\`\`yaml
# "Find the passages in this contract about late-cancellation refunds."
version: 1
kind: pdf
inputs:
  - input/contract.pdf
operations:
  # - ocr: {}                 # uncomment first if this is a scan (no text layer)
  - semantic_search:
      query: refund policy for late cancellations
      top_k: 5
output:
  file: output/contract.pdf   # unchanged; passages → output/search-results.md
\`\`\`

## Operation vocabulary

| operation | capability | summary |
|-----------|------------|---------|
${opRows}

## Backends & dependencies — verify before recommending an install

\`opw_compile\` only resolves against the **bundled pdf-lib** backend, so it marks
**every** Python-, LibreOffice-, or CLI-backed op as \`UNSATISFIED\` even when that
backend is installed. **Its "unsatisfied" list is not an install list** — it tells
you which backend an op *needs*, not what is actually missing on this machine.

**Live source of truth for what's installed:** the **Dependencies** section of the
PDF Studio sidebar (green = available + version · yellow = missing, click to
install). Check it — or run the probe in the last column — and recommend
installing **only** what is genuinely missing. Every op maps to one backend:

| backend | unlocks (examples) | verify it's installed |
|---------|--------------------|-----------------------|
| **pdf-lib** (bundled) | merge, split, rotate, delete, watermark, metadata, crop, stamp, n_up, overlay | always available — zero install |
| **Python** (PyMuPDF/pikepdf/…) | extract_text, extract_markdown, redact, ocr, encrypt/decrypt, flatten, replace_image, fill_field, linearize | \`python -c "import fitz, pikepdf"\` |
| **LibreOffice** (soffice) | office_to_pdf, **pdf_to_docx**, pdf_to_pptx, pdf_to_xlsx | \`soffice --version\` (Windows: also \`%ProgramFiles%\\LibreOffice\\program\\soffice.exe\`) |
| **Chrome/Edge** | html_to_pdf, markdown_to_pdf, url_to_pdf (high fidelity) | Windows ships Edge; else \`google-chrome --version\` |
| **qpdf / Ghostscript** | deep compress, linearize | \`qpdf --version\` · \`gs --version\` (Windows: \`gswin64c\`) |
| **Tesseract** | ocr engine (ocrmypdf shells out to it); \`ocr\` supports mode skip-text/redo-ocr/force-ocr + a language preflight | \`tesseract --version\` · installed languages: \`tesseract --list-langs\` |
| **pillow-heif** | HEIC/HEIF (iPhone photos) in \`images_to_pdf\` — Pillow cannot decode them without it | \`python -c "import pillow_heif"\` |
| **ffmpeg** | \`video_to_pdf\` — sample a video into timestamped frames, one per page | \`ffmpeg -version\` |

The bundled **pdf-lib** backend covers every structural op with zero install; the
optional backends above only need installing for the specific ops they unlock —
so match the missing backend to the op, don't blanket-\`pip install\`.

The Dependencies view groups them by how much they matter, and so should any advice
you give:

- **Bundled** — pdf-lib. 25 operations, nothing to install.
- **Recommended** — Python + PyMuPDF + pikepdf. Unlocks 66 more. This is the one
  install worth suggesting unprompted.
- **Per-feature** — Ghostscript, qpdf, Tesseract, LibreOffice, Chrome/Edge, ffmpeg,
  pillow-heif, pyHanko, MarkItDown. Suggest ONE, only when the user's workflow needs it.
- **Heavy · opt-in** — Marker, PaddleOCR-VL, Qwen3-VL. Gigabyte-scale models, usually
  wanting a GPU. Never suggest these unless the user asks for AI-grade OCR by name.

## MCP tools (\`pdf-studio\`) — deterministic, no rendering
- **\`opw_validate({ opw })\`** — structural diagnostics. **Run after every edit.**
- **\`opw_compile({ opw })\`** — preview the execution plan + unsatisfied capabilities.
- **\`opw_optimize({ opw })\`** — behavior-preserving rewrites.
- **\`opw_diff({ before, after })\`** — semantic diff between two revisions.
- **\`opw_operations()\`** — list the operation vocabulary.
- **\`opw_scaffold({ inputs, output, operations })\`** — generate a starter workflow.
- **\`form_list({ category? })\`** — list supported fillable forms (passport, tax, …).
- **\`form_fields({ form })\`** — a form's fillable fields + a copy-paste workflow.
- **\`form_people()\`** — a starter \`people.yaml\` records file (PII; gitignored).
- **\`form_scaffold({ form, input, people?, person? })\`** — generate a fill_form workflow.

## Rendering & preview
- The extension renders **locally**: **PDF Studio: Render Workflow** (or the ▶ in
  the sidebar / editor title) → writes \`output/…\`. A preview opens in-editor.
- Just edit + \`opw_validate\`; the extension renders. **The MCP never renders.**

## Do NOT
- Reformat or rewrite the whole \`.opw.yaml\` — make surgical edits; unknown fields must survive.
- Edit the binary PDF directly — edit the workflow and re-render.
- Invent operation names — only those in the table above exist (see \`opw_operations\`).
- Assume advanced ops work without a backend — check \`opw_compile\` for unsatisfied capabilities.

---
_Generated by the PDF Studio VS Code extension. Written as CLAUDE.md, AGENTS.md,
and GEMINI.md (byte-identical) so Claude Code / Codex / Gemini auto-load it._
`;
}
