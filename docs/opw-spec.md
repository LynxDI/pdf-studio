# OpenPDF Workflow (OPW) — Specification v1

**Status:** Draft · Reference implementation: `@pdf-studio/core`

OPW is an open, human-readable, deterministic specification for **document
transformations**. An OPW file describes how to transform one or more input
documents into an output document. It is renderer-agnostic: any conforming engine
that implements the operation capabilities produces the same result.

OPW is a **workflow layer**, not a document format. It does not store document
content; it stores the *program* that transforms content.

---

## 1. File format

- Encoding: UTF-8 text.
- Syntax: YAML 1.2 (JSON is a valid subset). Recommended extension: `.opw.yaml`.
- A single top-level mapping.

## 2. Top-level schema

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `version` | integer | yes | Schema version. `1` today. |
| `kind` | string | no (default `pdf`) | Content domain. Only `pdf` is defined in v1. |
| `inputs` | string[] | yes | Ordered input document paths, relative to the file. |
| `vars` | map<string,scalar> | no | Declared variables, referenced as `${name}` in params and output paths (see §2.3). |
| `assets` | map<string,string> | no | Named assets (images/stamps) referenced by operations. |
| `operations` | Operation[] | yes | Ordered transformation program. |
| `output` | Output | no* | Output target — a `file` or a `folder`. *Required unless an operation emits its own files (see §2.1). |

Unknown top-level keys **must be preserved** by conforming editors (forward
compatibility). The reference implementation stores them under `workflow.extra`.

### 2.1 Output

The output target is either a single **file** or a **folder** (relative paths):

```yaml
output:
  file: output/final.pdf     # ONE rendered document
```

```yaml
output:
  folder: output/invoices    # a DIRECTORY: every file an operation emits lands here
```

A bare string is also accepted as the file form: `output: output/final.pdf`.

`output` may be **omitted entirely** when the workflow contains an operation that
emits its own files (e.g. `split_invoices`) — such an operation declares
`emitsFiles` and already produces output, so a single `output.file` would be a
redundant passthrough. When both `output.folder` and a per-op destination (e.g.
`split_invoices.to`) are present, `output.folder` wins.

### 2.1.1 Batch (glob inputs)

An `inputs` entry containing a glob metacharacter (`*`, `?`, or a `**` segment) puts
the workflow in **batch mode**: the operation program runs **once per matched file**,
independently. An op that consumes every input at once (`merge`, `extract_form` — the
`consumesAllInputs` ops) suppresses batch mode instead: the glob expands into a
**single** run's inputs, in sorted filename order. The output must be per-input — an
`output.folder` (each result written as `<folder>/<input-stem>.<ext>`; a file-emitting
op's artifacts land under `<folder>/<input-stem>/`) or a **templated** `output.file`
with `{stem}` / `{name}` / `{ext}` / `{i}` (1-based index). A bare `output.file` in
batch mode is a validation error (outputs would collide). One input that fails to
render is skipped (recorded), not fatal. Glob expansion happens at **execution time**
(it needs the filesystem), so `validate`/`compile` treat the glob as a literal input.

```yaml
inputs:
  - "invoices/*.pdf"     # each match runs the ops below
operations:
  - compress: {}
output:
  folder: output/small   # → output/small/<name>.pdf per input
```

A folding op reads the run's **inputs**, not the working document, so an operation placed
before it would otherwise be discarded. Operations that create a PDF from **one** non-PDF
document (`office_to_pdf`, `markdown_to_pdf`, `html_to_pdf`, `eml_to_pdf`, `epub_to_pdf` —
the `perInputCreator` ops) are therefore applied **once per input first**, and their results
become the run's inputs; the folding op then sees PDFs. This is what makes "a folder of
PowerPoint decks into one PDF" a single workflow:

```yaml
inputs:
  - "decks/*.pptx"       # folded (merge) → converted per deck, then combined
operations:
  - office_to_pdf: { from: pptx }
  - merge: {}
output:
  file: output/course.pdf
```

Creators that consume every input at once (`images_to_pdf`) or none (`url_to_pdf`) cannot be
applied per file; placing one before a folding op is a validation error
(`creator_before_fold`).

`merge` goes further: it accepts **mixed** input types. Any input that is not a PDF (sniffed
by header, not extension) is converted by the operation whose `inputExtensions` claim its
extension, and PDFs pass through unchanged — so one `merge` combines a `.pdf`, a `.docx`,
some `.png`s and a `.md`. Set `convert: false` to require every input to already be a PDF.
An input whose extension no operation claims is an error naming the file. Because the
conversion is implied by the inputs rather than written as a step, `compile` reports any
backend it would need (e.g. LibreOffice for `.docx`) in `unsatisfied`.

```yaml
inputs:
  - cover.pdf              # used as-is
  - summary.docx           # → office_to_pdf   (LibreOffice)
  - chart.png              # → images_to_pdf   (bundled)
  - notes.md               # → markdown_to_pdf
operations:
  - merge: {}
output:
  file: output/pack.pdf
```

### 2.2 Operations

Each operation is a **single-key mapping** from an operation name to its
parameters. `{}` denotes no parameters. A bare string (`- merge`) is accepted as
the no-param form.

```yaml
operations:
  - merge: {}
  - delete_pages: { pages: [10, 11] }
  - rotate_pages: { pages: [1], degrees: 90 }
```

**Pages are 1-based** throughout OPW. Operations apply in order to a single
"working document." `merge` builds the working document from all inputs; without
it, only the first input is used.

#### Page lists

Every parameter that addresses pages (`pages`, `from_pages`, `order`) takes a
list whose items are page numbers, compact ranges, or both:

| Token | Means |
| --- | --- |
| `7` or `"7"` | page 7 |
| `"5-8"` | pages 5, 6, 7, 8 |
| `"8-5"` | pages 8, 7, 6, 5 — descending, for ops where order matters |
| `"10-last"` | page 10 through the final page |
| `"last"` | the final page |

```yaml
- delete_pages: { pages: [1, "5-8", "last"] }
```

Quote any token containing a hyphen — bare `5-8` is a YAML string here, but
quoting keeps the intent obvious and survives reformatting. A malformed token
(`"5-8-10"`, `"five"`) is a validation **error**, never a silently ignored entry.
Page numbers outside the document are dropped rather than failing the run, so one
stray number can't abort a 500-file batch.

**Page numbers are positional, and operations renumber the document.** A page
number means "the page in that position *at the point the operation runs*", not
a stable identity. So an op written after `delete_pages` or `merge` sees
different numbering than one written before it. Tooling that turns a click on a
page into an operation must place that operation before the first op that
renumbers — the registry marks those with `changesPagination`.

### 2.3 Variables

A workflow may declare `vars` — a mapping of names to **scalar** values (string,
number, or boolean) — and reference them with `${name}` inside operation
parameters and `output.file` / `output.folder`. This makes one file a reusable
**template**: edit the values, or override them at run time, to render the same
program for a different job.

```yaml
version: 1
vars:
  client: acme
  mark_size: 9
inputs: [input/report.pdf]
operations:
  - watermark: { text: "${client}" }
  - stamp: { text: "Prepared for ${client}", x: 40, y: 20, size: "${mark_size}" }
output:
  file: "output/${client}-report.pdf"
```

- **Typed vs. string.** A *whole-value* reference (`size: "${mark_size}"`) keeps the
  variable's native type — a numeric var stays a number and passes numeric
  validation. An *embedded* reference (`"Prepared for ${client}"`) is
  string-interpolated.
- **Quoting.** Always quote a `${…}` reference in YAML — an unquoted `${` begins a
  flow-map and is a parse error.
- **Overrides.** A runner may supply overrides that win over the file's defaults
  (the reference implementation: `runWorkflow(wf, { vars })`). Scope is: params +
  output paths (not `inputs`/`assets` in v1).
- **Undeclared references** are left **literal**; when a `vars` block is present the
  validator warns about them (a likely typo).
- **Security.** Variables are **file-local** — resolution never reads the
  environment. The only env-reading path is `${ENV}` in the password params
  (`password`/`user_password`/`owner_password`), resolved at execution; a declared
  var of the same name takes precedence.
- Resolution happens **before** validate/optimize/compile, so a plan is diffable and
  hashable with concrete values.

### 2.4 Conditional guards (`when:`)

An operation may carry a **sibling `when:` key** — a predicate that must be truthy for
the op to run. It turns a linear program into one with conditional logic (the Preflight
*condition → fixup* parallel).

```yaml
operations:
  - convert_colors: { mode: gray }
    when: "pages > 20"            # only long documents
  - decrypt: { password: "${pw}" }
    when: "encrypted == true"
  - watermark: { text: DRAFT }
    when: "env != 'prod'"         # env is a workflow variable
```

- **Predicate language.** A tiny, safe expression grammar evaluated by a hand-written
  parser — **no `eval`, no function calls, no property access**. Supports comparisons
  (`== != < <= > >=`), boolean logic (`&& || !`), parentheses, and literals
  (numbers, `'quoted strings'`, `true`/`false`). Identifiers resolve to **document
  facts** or declared **vars**. Quote a `when:` value in YAML.
- **Document facts.** Computed from the input document. **Bundled** (zero-install):
  `pages`, `pdf_version` (e.g. `1.7`), `encrypted`, `tagged`, `size_kb`. **Content facts**
  (need the Python backend, which inspects the document): `has_text`, `has_images` — a
  guard using one errors clearly if Python is unavailable. Fact names are reserved — they
  win over a same-named var.
- **Evaluation model.** Facts are a **snapshot of the input document**, read once at run
  start; guards are evaluated against that snapshot (facts do not reflect changes an
  earlier op made). In **batch** (glob inputs) the snapshot — and thus each guard — is
  per input, so a workflow can branch file by file.
- **Skipped ops** are reported in the run result (they are not silently dropped).
- **Validation.** A malformed expression is an error; an identifier that is neither a
  known fact nor a declared var is a warning (it may be a runtime-only override var).
- Guards are **per operation** in v1 (no block/group form yet).

---

## 3. Operation vocabulary (v1)

Each operation maps to a **capability** an engine must implement.

| Operation | Capability | Params | Summary |
|-----------|------------|--------|---------|
| `merge` | merge | `interleave: bool` | Combine all inputs: concatenated in order, or with `interleave` alternating their pages round-robin (short inputs padded with blanks). Also written as `interleave`. |
| `split` | split | `ranges: string[]` \| `every: int` | Split into multiple outputs by page range. |
| `split_invoices` | split_invoices | `name`, `to`/`output.folder`, `ocr_first`, `starts: int[]` | Split a bundled-invoices PDF into one PDF per detected invoice (emits files). |
| `delete_pages` | delete_pages | `pages`* | Remove pages. |
| `reorder_pages` | reorder_pages | `order`* | Permute pages — must list EVERY page exactly once. |
| `move_pages` | move_pages | `pages`*, `after` \| `before` | Move pages to a new position; everything else stays put. |
| `swap_pages` | swap_pages | `a: int`*, `b: int`* | Exchange two pages. |
| `rotate_pages` | rotate_pages | `pages`, `degrees: int`* | Rotate by a multiple of 90. |
| `insert_blank` | insert_blank | `at: int`*, `size` | Insert a blank page. |
| `extract_pages` | extract_pages | `pages`* | Keep only these pages. |
| `watermark` | watermark | `text` \| `image`, `opacity`, `pages`, `rotate` | Stamp watermark. |
| `set_metadata` | set_metadata | `title`,`author`,`subject`,`keywords`,`creator`,`producer` | Set metadata. |
| `compress` | compress | `quality: int` | Reduce size. |
| `extract_text` | extract_text | `to` | Extract text to a sidecar (needs text backend). |
| `extract_images` | extract_images | `to` | Extract images (needs PyMuPDF/pikepdf). |
| `replace_image` | replace_image | `selector`*, `image`* | Replace an image object (needs backend). |
| `redact` | redact | `page`*, `rects`* | Permanently remove regions (needs PyMuPDF). |
| `ocr` | ocr | `language` | Add a searchable text layer (needs OCR backend). |

`*` = required. `set_metadata` aliases `metadata`; `compress` aliases
`compress_images`.

---

## 4. Execution semantics

An engine MUST:

1. **Validate** the workflow (schema + per-operation parameters). Reject on error.
2. Load `inputs` into a working-document context (working document = first input).
3. Apply each operation in order, transforming the working document.
4. Write output: if `output.folder` is set, write every emitted file into that
   directory (by basename) with no passthrough; else write the working document to
   `output.file` and any side artifacts (split parts, extracted text/images)
   alongside it. A workflow with no `output` but a file-emitting operation writes
   only that operation's files.

An engine MAY apply behavior-preserving **optimizations** (e.g. coalescing
metadata) provided the output is identical.

Capabilities the engine cannot satisfy MUST be reported (not silently skipped);
the reference implementation reports them as an `unsatisfied` set in the compiled
plan and skips them at execution with a note.

---

## 5. Conformance

A conforming OPW engine:

- parses the schema in §2 and preserves unknown top-level keys,
- implements a declared subset of the capabilities in §3 (at minimum `merge`,
  `delete_pages`, `rotate_pages`, `reorder_pages`, `extract_pages`, `watermark`,
  `set_metadata`),
- produces deterministic output for a given (workflow, inputs) pair, and
- reports unsatisfiable operations rather than failing silently.

---

## 6. Extensibility

`kind` reserves the document domain. Future versions may define `pptx`, `docx`,
`svg`, `image`, or `video` kinds, each dispatching operations to a domain-specific
backend. Operations are capability-oriented so a capability (e.g. `watermark`) can
be defined across kinds. This is what makes OPW a general document-transformation
DSL rather than a PDF-only format.
