# OCR engines — a guided tour

PDF Studio has **four OCR paths**, each for a different job. This gallery demos all of them
against realistic sample PDFs so you can see what each produces and pick the right one.

## 0. ALWAYS check the file first — most PDFs don't need OCR

A huge share of "I need OCR" PDFs **already carry a text layer** (anything exported from
Word, a browser, a report generator…). OCR'ing those is slower, lossy, and pointless. So
before any engine, run **`text_report`** (the "pdf stats" op) — it profiles every page and
tells you what to do. Run [`00-check-first.opw.yaml`](00-check-first.opw.yaml) and compare:

| sample | text coverage | `text_report` recommendation |
| --- | --- | --- |
| `input/digital-invoice.pdf` (born-digital) | **100%** | `text-complete` — extract text directly, **do NOT re-OCR** |
| `input/scanned-letter.pdf` (a scan) | **0%** | `image-only` — OCR the whole document |
| `input/scanned-table.pdf`, `input/receipt.pdf` | 0% | image-only — OCR candidates |

`text_report` needs only the base Python backend (PyMuPDF) — no Tesseract, no model. On a
mixed file it even tells you **which pages** to OCR (see [`examples/page-stats`](../page-stats)).
Rule of thumb: **profile → decide → only then OCR.**

### Why it matters — what OCR does to a file that didn't need it

`input/digital-invoice.pdf` already has a perfect text layer. Force-OCR it anyway (the
mistake `text_report` prevents) and Tesseract *re-guesses* every character from a rasterized
image — the result is bigger, slower, and **wrong**:

| | born-digital original | after `ocr: { mode: force-ocr }` |
| --- | --- | --- |
| file size | **1.9 KB** | **48 KB** — 24× bigger (it's now a page image) |
| speed / deps | instant, none | 2.5 s, needs Tesseract |
| "Paper cups (sleeve)" | `sleeve` ✅ | `sieeve` ❌ |
| unit price | `18.00` ✅ | `18.06` ❌ |
| line amount | `130.00` ✅ | `136.00` ❌ |
| subtotal | `371.00` ✅ | `374.00` ❌ |

OCR turned a crisp, correct invoice into a bloated image whose **numbers no longer add up** —
`$130.00` became `$136.00`, the subtotal `$371` became `$374`. That is the cost of OCR'ing
text you already had. `text_report` catches it in a fraction of a second, with **zero
dependencies**:

> **Recommendation: `text-complete`** — already has a text layer — extract text directly,
> **do NOT re-OCR** · 100% coverage

**Moral: profile first. OCR is for pixels, not text.**

## Pick an engine

| You want… | Use | Output | Speed (CPU) | Install (one click in the Dependencies view) |
| --- | --- | --- | --- | --- |
| the file already has text | `extract_markdown: { ocr: off }` | Markdown | instant | base engine |
| a **searchable PDF** from a typed scan | `ocr` (Tesseract) | PDF + text layer | fast | **OCR (Tesseract + OCRmyPDF)** |
| a **faithful document → Markdown** from scans/books (keeps figures + tables) | `extract_markdown: { engine: marker }` | Markdown | slow | **Marker (Surya OCR)** |
| **fast searchable text at scale** from image-only pages/screenshots (~300 pg/min on GPU) | `extract_markdown: { engine: paddleocr-vl }` | Markdown | medium | **PaddleOCR-VL** |
| the **best tables/forms** (real HTML tables) from a **few pages** | `extract_markdown: { engine: mineru }` | Markdown | very slow | **MinerU 2.5-Pro** |
| **structured data** from a receipt/invoice | `extract_receipt` | JSON + CSV | medium | **Receipt OCR (Qwen3-VL)** |

Each backend installs from a single click on its row in the **Dependencies** view.

### Benchmark at a glance

Quick reference from the 16-engine benchmark (full numbers, per-page-type picks and
cloud endpoints in [**Benchmark: 16 engines, measured**](#benchmark-16-engines-measured) below).
**TEDS** = table-structure fidelity (0 = tables flattened). Clean-text accuracy is a near-tie
across all of these — the real differentiators are **table structure** and **speed**.

| engine | wired | TEDS (tables) | throughput (GPU) | VRAM | reach for it when |
| --- | :--: | ---: | ---: | ---: | --- |
| **MinerU 2.5-Pro** (`engine: mineru`) | ✅ | **0.96** | ~98 pg/min | 2.4 GB | **best tables/forms** |
| **PaddleOCR-VL** | ✅ | 0.00 (flattens) | ~311 pg/min | 1.8 GB | fast **searchable text at scale** |
| **Marker** | ✅ | 0.84 (markdown) | ~5 pg/min | GPU | **faithful Markdown + figures** |
| **Qwen3-VL** (`extract_receipt`) | ✅ | 0.69 | 18 pg/min | ~10 GB | **receipt/invoice fields** |
| **Tesseract** (`ocr`) | ✅ | — | 40 pg/min (CPU) | 0 (CPU) | **zero-cost searchable PDF** |

_Throughput is on a **GPU** (batched); Tesseract is CPU-only. On CPU the VLM engines are far
slower — e.g. MinerU runs ~5 pg/min via its `transformers` backend (fine for a few pages)._

## The workflows

| file | engine | demo input |
| --- | --- | --- |
| [`00-check-first.opw.yaml`](00-check-first.opw.yaml) | `text_report` — **run this first** | digital-invoice.pdf |
| [`01-ocr-searchable-pdf.opw.yaml`](01-ocr-searchable-pdf.opw.yaml) | `ocr` — Tesseract → searchable PDF | scanned-letter.pdf |
| [`02-markdown-marker.opw.yaml`](02-markdown-marker.opw.yaml) | `extract_markdown: marker` — Surya OCR + layout | scanned-table.pdf |
| [`03-markdown-paddleocr-vl.opw.yaml`](03-markdown-paddleocr-vl.opw.yaml) | `extract_markdown: paddleocr-vl` — 0.9B doc VLM | scanned-table.pdf |
| [`04-receipt-fields.opw.yaml`](04-receipt-fields.opw.yaml) | `extract_receipt` — Qwen3-VL → JSON/CSV | receipt.pdf |
| [`05-text-layer-fast.opw.yaml`](05-text-layer-fast.opw.yaml) | `extract_markdown: { ocr: off }` — no OCR needed | digital-invoice.pdf |

Open a workflow, read the header (each explains the engine and when to use it), and hit
**Render**. `02` and `03` use the **same** scanned table on purpose — render both and compare.

## Engine notes

- **Tesseract / OCRmyPDF** (`ocr`) — the workhorse. Adds an invisible searchable text layer
  behind the image and keeps the PDF a PDF. Fast, offline, deterministic; best for ordinary
  typed documents. `mode: skip-text` only touches pages that lack text.
- **Marker** (`engine: marker`) — Surya OCR + layout models re-read the page images and
  rebuild headings, reading order, and tables. Highest quality on complex scans and books;
  slow on CPU, downloads a few GB of models on first run.
- **PaddleOCR-VL** (`engine: paddleocr-vl`) — Baidu's 0.9B vision-language document parser.
  Strong on scans, tables, and formulas; CPU-capable and much smaller than Marker. Runs in
  its own venv so its heavy stack stays isolated.
- **MinerU 2.5-Pro** (`engine: mineru`) — the benchmark's **table-structure leader** (real HTML
  tables/forms, TEDS 0.96). A 1.2B document VLM that does its own image OCR — CPU-capable via
  `transformers` (no GPU needed) but **slow** (~minutes/page), so best for a **few pages**. Runs
  in its own venv (`$PDFSTUDIO_MINERU_PYTHON`); PDF Studio skips the OCRmyPDF pre-pass for it.
- **Qwen3-VL receipt extraction** (`extract_receipt`) — reads a receipt/invoice image and
  returns typed fields (merchant, date, totals, tax, line items) as JSON + CSV — data, not
  text. Served over a local vision-model endpoint (Ollama by default).

## No GPU? Cloud OCR on free NVIDIA vision models

The receipt/vision path (`extract_receipt`) doesn't have to run locally. [build.nvidia.com](https://build.nvidia.com)
hosts strong **image-to-text** models behind a **free**, OpenAI-compatible API — good OCR with
**no local model and no GPU**, just an API key. Verified working: `meta/llama-3.2-90b-vision-instruct`
transcribed a test receipt correctly.

```yaml
operations:
  - extract_receipt:
      endpoint: "https://integrate.api.nvidia.com/v1"
      model: "meta/llama-3.2-90b-vision-instruct"
```

Set `NVIDIA_API_KEY` (from any model page → **Get API Key**) and enable `pdfStudio.allowRemoteRender`
(page images go to the cloud). Good OCR-capable models: **`meta/llama-3.2-90b-vision-instruct`**
(best), `meta/llama-3.2-11b-vision-instruct`, `nvidia/nemotron-nano-12b-v2-vl`, `google/paligemma`
— browse the [image-to-text list](https://build.nvidia.com/models?filters=usecase%3Ausecase_image_to_text).
Free tier is rate-limited (fine for trying it / light use; self-host for volume). Full step-by-step:
the **AI models — NVIDIA free cloud endpoints** guide (Documentation panel, or `docs/python-setup.md`).

**What the benchmark found among the free endpoints:** on a 12-page subset, **`meta/llama-4-maverick`**
was the best hosted model (TEDS ≈ 0.77, text CER ≈ 0.20) but had a **~17% failure rate**;
`llama-3.2-11b-vision` *paraphrases* instead of transcribing (CER 0.69), `nemotron-nano-12b-vl` is
weakest on tables (0.46), and `ministral-14b` timed out on every page. Even free CPU **Tesseract beat
two of the four** hosted models on plain text, and **local MinerU/PaddleOCR-VL win outright** on the
same pages. Bottom line: the free tier (≈40 RPM + a ~1,000-credit cap) is for **small jobs and trials**
— it can't run a 4,494-page PDF that a local engine finishes in ~14 minutes. Use the cloud to avoid a
GPU install for a few pages; go local for volume.

## Benchmark: 16 engines, measured

An independent benchmark compared **16 OCR / document-parsing engines** — 12 local + 4 free
NVIDIA cloud endpoints — on a single consumer GPU, across three tests: **OmniDocBench**
(50 human-verified pages),
an on-domain 50-page sample, and **one full 4,494-page PDF** end-to-end. The headline metric is
**TEDS** (table-structure tree-edit similarity — it catches table-flattening that word-level
scores miss); alongside **CER** (character error ↓), **FlexCA** (order-independent word F1 ↑),
throughput (**pg/min**), VRAM, and failure rate. The **wired?** column marks what PDF Studio can
select today.

### Table structure & accuracy — OmniDocBench

| # | engine | wired? | TEDS↑ | CER↓ | FlexCA↑ | pg/min | VRAM | fail% |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | **MinerU 2.5-Pro** (1.2B, native pipeline) | ✅ | **0.957** | 0.385 | 0.775 | 3 | 2.4 GB | 0% |
| 2 | Docling (pipeline) | not yet | 0.853 | 0.308 | 0.677 | 9 | — | 6% |
| 3 | **Marker** (Surya OCR + layout) | ✅ `engine: marker` | 0.838 | 0.422 | 0.788 | 5 | — | 4% |
| 4 | dots.ocr (1.7B VLM) | not yet | 0.736 | 0.396 | 0.784 | 54 | 5.9 GB | 0% |
| 5 | olmOCR-2 (8B VLM) | not yet | 0.726 | 0.380 | 0.751 | 28 | 9.6 GB | 0% |
| 6 | Qwen3-VL-8B (8.8B VLM) | ✅ `extract_receipt` | 0.693 | 0.459 | 0.725 | 18 | 10.2 GB | 12% |
| 11 | **PaddleOCR-VL-1.6** (0.9B VLM) | ✅ `engine: paddleocr-vl` | 0.000 | 0.544 | 0.727 | 167 | 1.8 GB | 2% |
| 12 | **Tesseract 5** (CPU LSTM) | ✅ `ocr` | 0.000 | 0.585 | 0.695 | 40 | 0 GB | 0% |

_(DeepSeek-OCR, DeepSeek-OCR-2, Unlimited-OCR, dots.mocr omitted — all fast plain-text VLMs
whose table structure is broken, TEDS ≈ 0.02.)_

> **The `pg/min` here is from the 50-page accuracy runs** (single-document, not batched) — treat it
> as *relative only*, not real throughput. MinerU runs its slow `transformers` backend here (3 pg/min);
> on the batched full-document run below it reaches **98 pg/min** (vLLM) on the same GPU, PaddleOCR-VL
> **311**, Docling **77**.

### Throughput at scale — the full 4,494-page PDF

| engine | pg/min | full doc | fail% |
| --- | ---: | ---: | ---: |
| **PaddleOCR-VL-1.6** | 311 | **~14 min** | 3% |
| MinerU 2.5-Pro | 98 | ~46 min | 0% |
| Docling | 77 | ~59 min | 9% |

### Content fidelity — full doc vs the source text layer

Recall = fraction of the real words captured; precision = fraction of the model's words that are
real (penalizes noise / hallucination).

| engine | recall↑ | precision↑ | F1↑ | structure |
| --- | ---: | ---: | ---: | --- |
| **PaddleOCR-VL** | 0.985 | **0.772** | **0.866** | tables → markdown |
| **MinerU 2.5-Pro** | 0.987 | 0.765 | 0.862 | **932 HTML tables + 5,582 figures** |
| **Marker** | **0.988** | 0.763 | 0.861 | keeps figures (4,910) |
| dots.ocr | 0.985 | 0.744 | 0.848 | 844 HTML tables |
| Docling | 0.945 | 0.454 | 0.613 | noisy — half its tokens aren't real words |

**Bottom line for the wired engines:**

- **Fast searchable text at scale → `engine: paddleocr-vl`.** ~300 pg/min, 1.8 GB, top word
  recall — a 4,494-page archive becomes searchable in ~14 min. It **flattens complex tables**
  (TEDS 0), so it's for text, not structure.
- **Faithful document → Markdown → `engine: marker`.** Cleanest reconstruction, best recall,
  uniquely **keeps figures** — but slow (~5 pg/min) and emits markdown-pipe tables, not HTML.
- **Zero-cost clean text → `ocr` (Tesseract).** Competitive on ordinary typed text, 0 VRAM, 0%
  fail — no tables/layout. The VLM premium is real only on hard / scanned / table-heavy pages;
  on clean text the whole field bunches (FlexCA ~0.91–0.94).
- **Best table structure → `engine: mineru` (MinerU 2.5-Pro, TEDS 0.957).** The benchmark's clear
  table/forms/financials winner — real HTML tables, tiny at 2.4 GB, 0% fail. CPU-capable via
  transformers but slow (~minutes/page), so use it for a **handful of pages**; runs in its own venv
  (`$PDFSTUDIO_MINERU_PYTHON`, see [python-setup](../../docs/python-setup.md)).

### Best engine by page type

| Page type | Best (wired) | Benchmark leader (may not be wired) |
| --- | --- | --- |
| Image-only pages / screenshots | **PaddleOCR-VL** | PaddleOCR-VL |
| Maximum text recall | **Marker / PaddleOCR-VL** (tie ~0.985) | Marker 0.988 |
| Fastest at scale | **PaddleOCR-VL** (~300 pg/min) | PaddleOCR-VL |
| Long reports & books → Markdown | **Marker** | MinerU 2.5-Pro |
| Complex tables / forms / financials | **MinerU 2.5-Pro** (`engine: mineru`, TEDS 0.96) | Marker (markdown tables) |
| Ordinary typed docs (searchable PDF) | **`ocr` (Tesseract)** | — |
| Lowest cost / no GPU | **Tesseract** | Tesseract |

### ⚠️ Validate OCR output — VLMs can hallucinate loops

Some VLMs enter a **generative repetition loop** — e.g. inventing "Component D … Component Z"
and repeating one line hundreds of times — which silently poisons a search index or an LLM's
context. It shows up in the benchmark as a **failure rate**: 0% for MinerU, PaddleOCR-VL,
Marker and Tesseract on the full doc, but 12% for Qwen3-VL-8B, ~9% for Docling, and up to 17%
on the free hosted endpoints. **Never trust raw OCR unvalidated.** A cheap deterministic guard,
then retry with another engine, catches the common failures:

```python
def suspicious_ocr(text: str) -> bool:
    lines = [l.strip().lower() for l in text.splitlines() if l.strip()]
    if not lines:
        return True                                  # empty despite visible text
    if max(lines.count(l) for l in set(lines)) > 10:
        return True                                  # a line repeated >10× → loop
    words = text.lower().split()
    if len(words) > 100 and len(set(words)) / len(words) < 0.08:
        return True                                  # unique-token ratio too low
    return False
```

### This confirms: check `text_report` FIRST

The benchmark's #1 production recommendation is _"do not OCR every page automatically — the
PDF already contains native text on many pages, and OCRing them can make the result worse."_
That is exactly why [`00-check-first`](00-check-first.opw.yaml) leads this gallery. The
suggested production pipeline, using the engines PDF Studio wires in:

> **native text (`text_report`) → `paddleocr-vl` for scans at scale → validate
> (loop/completeness) → `marker` fallback for faithful Markdown + figures.**

(For hard tables/forms on a few pages, use **`engine: mineru`** — MinerU 2.5-Pro reconstructs
real HTML tables, the benchmark's structure winner. It's slow on CPU, so reserve it for the
pages that actually need it.)
