# OCR engine performance report

An independent benchmark of **16 OCR / document-parsing engines** — 12 that run locally +
4 free NVIDIA cloud endpoints — measured on a single consumer GPU. It backs
the engine-selection guidance in Lynx PDF Studio's OCR docs. Last updated **2026-07-25**.

## What this measures

Three complementary tests:

1. **OmniDocBench** — 50 diverse, human-verified pages (the published, labelled set).
2. **On-domain** — a 50-page sample of a real mixed PDF (scanned quiz screenshots + born-digital pages).
3. **Full-document** — one **4,494-page** PDF end-to-end, for throughput and whole-doc fidelity.

Metrics:

| metric | meaning |
| --- | --- |
| **TEDS** ↑ | Tree-Edit-Distance similarity of **table structure** — the headline. Catches table-flattening that word-level scores miss (0 = tables flattened). |
| **CER** ↓ | Character error rate on text. |
| **FlexCA** ↑ | Order-independent bag-of-words F1 (the CER–FlexCA gap is reading-order/markup, not recognition). |
| **pg/min** | Throughput (batched, offline). |
| **VRAM** | Peak GPU memory. `0` = CPU-only. |
| **fail%** | Pages that errored or degenerated into a repetition loop. |

> **Clean-text accuracy is a near-tie** across all serious engines (FlexCA ~0.91–0.94 on ordinary
> pages). The real differentiators are **table structure** and **speed**.

## What Lynx PDF Studio wires in

| engine | how to select it | role |
| --- | --- | --- |
| **MinerU 2.5-Pro** | `extract_markdown: { engine: mineru }` | best table/form structure (real HTML tables) |
| **PaddleOCR-VL** | `extract_markdown: { engine: paddleocr-vl }` | fast searchable text at scale |
| **Marker** (Surya) | `extract_markdown: { engine: marker }` | faithful Markdown + figures |
| **Tesseract** | `ocr` | zero-cost searchable PDF from typed scans |
| **Qwen3-VL** | `extract_receipt` | receipt/invoice fields → JSON/CSV |

dots.ocr, olmOCR-2 and Docling are measured below but **not yet wired in**. MinerU runs the
1.2B VLM in its own venv (`$PDFSTUDIO_MINERU_PYTHON`); it's CPU-capable (slow, best for a few
pages) and needs no GPU — see [python-setup](python-setup.md) or the OCR-engines example gallery.

## 1 · Table structure & accuracy — OmniDocBench

| # | engine | wired | TEDS ↑ | CER ↓ | FlexCA ↑ | pg/min | VRAM | fail% |
| ---: | --- | :--: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | **MinerU 2.5-Pro** (1.2B, native pipeline) | ✅ | **0.957** | 0.385 | 0.775 | 3 | 2.4 GB | 0% |
| 2 | Docling (pipeline) | not yet | 0.853 | 0.308 | 0.677 | 9 | — | 6% |
| 3 | **Marker** (Surya OCR + layout) | ✅ | 0.838 | 0.422 | 0.788 | 5 | — | 4% |
| 4 | dots.ocr (1.7B VLM) | not yet | 0.736 | 0.396 | 0.784 | 54 | 5.9 GB | 0% |
| 5 | olmOCR-2 (8B VLM, FP8) | not yet | 0.726 | 0.380 | 0.751 | 28 | 9.6 GB | 0% |
| 6 | Qwen3-VL-8B (8.8B VLM, FP8) | ✅ (`extract_receipt`) | 0.693 | 0.459 | 0.725 | 18 | 10.2 GB | 12% |
| 7 | dots.mocr (3B VLM) | not yet | 0.693 | 0.674 | 0.517 | 68 | 5.9 GB | 0% |
| 8 | DeepSeek-OCR-2 (~3B VLM) | not yet | 0.022 | 0.465 | 0.661 | 58 | 6.3 GB | 0% |
| 9 | DeepSeek-OCR (3B MoE VLM) | not yet | 0.022 | 0.461 | 0.640 | 62 | 6.2 GB | 2% |
| 10 | Unlimited-OCR (VLM) | not yet | 0.022 | 0.588 | 0.629 | 57 | 6.2 GB | 2% |
| 11 | **PaddleOCR-VL-1.6** (0.9B VLM) | ✅ | 0.000 | 0.544 | 0.727 | 167 | 1.8 GB | 2% |
| 12 | **Tesseract 5** (CPU LSTM) | ✅ (`ocr`) | 0.000 | 0.585 | 0.695 | 40 | 0 GB | 0% |

`TEDS ≈ 0.02` (DeepSeek-OCR / -2, Unlimited-OCR) and `0.00` (PaddleOCR-VL, Tesseract) mean the
engine reads text well but does **not** reconstruct table structure.

> **Reading `pg/min` in this table:** it comes from the 50-page **accuracy** runs — single-document,
> *not* batched, and not throughput-optimized — so treat it as **relative only**, not the engines'
> real speed. MinerU in particular runs its slow `transformers` backend here (3 pg/min). For real
> batched throughput on the **same GPU**, see §2 below: MinerU reaches **98 pg/min** (vLLM),
> PaddleOCR-VL **311**, and Docling **77**. (Absolute pg/min is conservative — flash-attn was
> unavailable, so runs used Torch SDPA.)

## 2 · Throughput at scale — the full 4,494-page PDF

| engine | pg/min | est. full doc | fail% |
| --- | ---: | ---: | ---: |
| **PaddleOCR-VL-1.6** | 311 | **~14 min** | 3% |
| MinerU 2.5-Pro | 98¹ | ~46 min | 0% |
| Docling | 77 | ~59 min | 9% |

¹MinerU's 98 pg/min uses its **vLLM** backend (Linux/CUDA); the Windows/`transformers` backend is ~5 pg/min.

## 3 · Whole-document content fidelity

Measured against the source PDF's own text layer (2,733 born-digital pages). **Recall** =
fraction of the real words captured; **precision** = fraction of the model's words that are real
(penalizes noise / hallucination).

| engine | recall ↑ | precision ↑ | F1 ↑ | structure |
| --- | ---: | ---: | ---: | --- |
| **PaddleOCR-VL** | 0.985 | **0.772** | **0.866** | tables → markdown |
| **MinerU 2.5-Pro** | 0.987 | 0.765 | 0.862 | **932 HTML tables + 5,582 figures** |
| **Marker** | **0.988** | 0.763 | 0.861 | keeps figures (4,910) |
| dots.ocr | 0.985 | 0.744 | 0.848 | 844 HTML tables |
| Docling | 0.945 | 0.454 | 0.613 | noisy — half its tokens aren't real words |

Text recall is a 4-way tie (~0.985–0.988). **MinerU wins structure** (most HTML tables *and* the
most preserved figures). **Docling is the noisy outlier** (precision 0.45).

## 4 · Free NVIDIA cloud endpoints (no local GPU)

`build.nvidia.com` hosts vision models behind a free, OpenAI-compatible API — usable via
`extract_receipt: { endpoint: "https://integrate.api.nvidia.com/v1", model: … }`. Scored on a
12-page subset, with two local engines for reference:

| # | model | host | TEDS ↑ | CER ↓ | FlexCA ↑ | fail% |
| ---: | --- | --- | ---: | ---: | ---: | ---: |
| 1 | **MinerU 2.5-Pro** | local | **0.983** | 0.103 | 0.898 | 0% |
| 2 | **Llama-4-Maverick** (17B×128E) | NVIDIA API | 0.770 | 0.199 | 0.859 | 17% |
| 3 | Llama-3.2-11B-Vision | NVIDIA API | 0.567 | 0.693 | 0.735 | 8% |
| 4 | Nemotron-Nano-12B-VL | NVIDIA API | 0.460 | 0.408 | 0.761 | 8% |
| 5 | Tesseract 5 | local | 0.000 | 0.197 | 0.820 | 0% |
| 6 | Ministral-14B | NVIDIA API | 0.000 | 0.959 | 0.009 | 100% |

- **Best free endpoint: Llama-4-Maverick** — but a ~17% failure rate, and it's rate/credit-capped.
- Llama-3.2-11B *paraphrases* instead of transcribing (high CER); Nemotron-Nano is weakest on
  tables; Ministral-14B timed out on every page.
- **Local still wins**, and free CPU Tesseract beats two of four hosted models on text. The free tier
  (~40 RPM + a ~1,000-credit cap) is for **small jobs and trials** — it cannot run a 4,494-page PDF
  that a local engine finishes in ~14 minutes.

## Which engine, by page type

| Page type | Best (wired) | Benchmark leader (may not be wired) |
| --- | --- | --- |
| Image-only pages / screenshots | **PaddleOCR-VL** | PaddleOCR-VL |
| Maximum text recall | **Marker / PaddleOCR-VL** (~0.985 tie) | Marker (0.988) |
| Fastest at scale | **PaddleOCR-VL** (~300 pg/min) | PaddleOCR-VL |
| Long reports & books → Markdown | **Marker** | MinerU 2.5-Pro |
| Complex tables / forms / financials | **MinerU 2.5-Pro** (`engine: mineru`, TEDS 0.96) | Marker (markdown tables) |
| Ordinary typed docs (searchable PDF) | **`ocr`** (Tesseract) | — |
| Lowest cost / no GPU | **Tesseract** | Tesseract |

**Bottom line:** don't OCR pages that already have text (run `text_report` first). For scans,
**PaddleOCR-VL** is the fast searchable-text workhorse and **Marker** the faithful-Markdown choice;
**Tesseract** is the zero-cost baseline. When table structure is critical, **`engine: mineru`**
(MinerU 2.5-Pro) leads the field — CPU-capable but slow, so best for a handful of pages.

## Validate OCR output

Some VLMs enter a **repetition loop** (repeating one line hundreds of times), which silently poisons
a search index or an LLM's context. It shows up as the failure rate above: 0% for MinerU,
PaddleOCR-VL, Marker and Tesseract, but 12% for Qwen3-VL-8B, ~9% for Docling, and up to 17% on the
free hosted endpoints. Never trust raw OCR unvalidated — a cheap deterministic guard (a line
repeated >10×, or a unique-token ratio that's too low) catches the common failures; retry with
another engine.

---

*Methodology: CER/WER via jiwer (pinned); FlexCA = order-independent bag-of-words F1; TEDS via
apted + lxml. Throughput is offline/batched under Torch SDPA (flash-attn unavailable on the test box,
so absolute pg/min is conservative). OmniDocBench ground truth carries ~12% audited label noise —
treat small deltas cautiously.*
