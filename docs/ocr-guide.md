# OCR with PDF Studio — the guidelines

**Rule zero: never OCR a PDF before you have profiled it.**

Most files that arrive labelled "needs OCR" already carry a text layer — anything
exported from Word, a browser, an accounting package, or a report generator does.
OCR'ing those is slower, heavier, and *less accurate* than the text already in the
file. So the first operation is never `ocr`. It's `text_report`.

```
profile → decide → OCR only what needs it → validate
```

---

## Step 1 — Profile the file (always)

`text_report` walks every page and reports text coverage, which pages are
image-only, which are blank, the scripts present, and a recommended workflow.
It needs only the base Python backend (PyMuPDF) — no Tesseract, no model,
nothing to download.

```yaml
version: 1
kind: pdf
inputs:
  - input/document.pdf
operations:
  - text_report:
      to: output/coverage.md
      format: both # coverage.md to read + coverage.json to act on
      detail: full # per-page table
```

It writes the report and leaves the PDF untouched — no `output:` block needed.

**On a large document,** don't profile every page. Sample it:

```yaml
  - text_report:
      to: output/coverage.md
      format: both
      detail: summary # drop the per-page array
      sample: 20      # every 20th page — a fast estimate on a 4,000-page file
```

**To triage a whole folder,** point `inputs` at a glob — `input/*.pdf` — and the
workflow runs once per file.

## Step 2 — Read the recommendation, then choose

`text_report` ends with a verdict. Act on it:

| Verdict | What it means | Do this |
| --- | --- | --- |
| `text-complete` (~100% coverage) | Born-digital. The text is already there. | **Do not OCR.** Go to Step 3a. |
| `image-only` (~0% coverage) | A scan. Every page is pixels. | OCR the document — Step 3b. |
| mixed | Some pages scanned, some not | OCR *only the listed pages*, or use a mode/guard that skips text — Step 3c. |

## Step 3a — Has text already: just read it

The common case, and the whole reason you profiled. No OCR engine, no
dependencies, instant and lossless:

```yaml
operations:
  - extract_markdown:
      ocr: off # use the existing text layer; never rasterize
      to: output/document.md
```

Use `extract_text` for plain text, `extract_tables` for tables, `inspect_text`
when you need coordinates and fonts.

## Step 3b — A real scan: pick an engine by the job

| You want | Use | Output | Cost |
| --- | --- | --- | --- |
| A **searchable PDF** (still a PDF, text layer behind the image) | `ocr` (Tesseract) | PDF | free, CPU, fast |
| **Searchable text at scale** — thousands of pages | `extract_markdown: { engine: paddleocr-vl }` | Markdown | ~300 pg/min on GPU |
| **Faithful Markdown** — books, reports, figures preserved | `extract_markdown: { engine: marker }` | Markdown | slow (~5 pg/min) |
| **Real tables/forms** — financials, structured pages | `extract_markdown: { engine: mineru }` | Markdown + HTML tables | very slow; use on a few pages |
| **Typed fields** from a receipt or invoice | `extract_receipt` | JSON + CSV | needs a vision model |

The default workhorse:

```yaml
operations:
  - ocr:
      language: eng   # or "eng+fra"; must be installed in Tesseract
      mode: skip-text # only pages with no text — never destroys existing text
output:
  file: output/document-searchable.pdf
```

Each engine installs with one click from its row in the **Dependencies** view.
Full comparison and measured benchmarks: [examples/ocr-engines/README.md](../examples/ocr-engines/README.md)
and the OCR notes in the operation reference.

## Step 3c — Mixed documents and batches

Two safe mechanisms; prefer them over hand-listing pages.

**`mode: skip-text`** — page-level. OCRs only the pages that lack text, leaves
the rest byte-identical. Safe to run on any mixed file.

**`when:`** — document-level. Skips the op entirely when the file already has
text. This is what makes a folder-wide batch safe:

```yaml
inputs:
  - archive/*.pdf # runs the whole workflow once per file
operations:
  - ocr: { mode: skip-text }
    when: "has_text == false" # scans get OCR'd; digital files pass through
output:
  file: output/{stem}-searchable.pdf
```

`has_text` needs the Python backend. `when:` is a sibling key of the operation,
not a parameter inside it.

## Step 4 — Validate the output

Vision-model engines can enter a **repetition loop** — inventing content, or
repeating one line hundreds of times — which silently poisons a search index or
an agent's context. Measured failure rates: 0% for Tesseract, Marker, MinerU and
PaddleOCR-VL on a full document; 12% for Qwen3-VL; up to 17% on free hosted
endpoints.

Never ship raw OCR unchecked. Spot-check the output, or run the deterministic
guard in [examples/ocr-engines/README.md](../examples/ocr-engines/README.md#-validate-ocr-output--vlms-can-hallucinate-loops)
and retry failures on another engine.

---

## What not to do

- **Don't `force-ocr` a file that has text.** It rasterizes the page and re-guesses
  every character. Measured on a clean 1.9 KB invoice: 48 KB out (24× bigger),
  `sleeve` → `sieeve`, `$130.00` → `$136.00`, and a subtotal that no longer adds up.
- **Don't OCR to get data out of a form.** Use `extract_form` / `extract_fields` —
  the values are already structured.
- **Don't reach for a VLM engine to make a PDF searchable.** `ocr` keeps the file a
  PDF; the Markdown engines give you a different artifact.
- **Don't skip Step 1 because the file "looks scanned."** It costs a fraction of a
  second and zero dependencies to be sure.

## The pipeline, in one line

> `text_report` → extract directly if there's text → `paddleocr-vl` for scans at
> scale → validate → `marker` for faithful Markdown, `mineru` for hard tables.
