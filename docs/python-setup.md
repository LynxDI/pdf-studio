# Python backend setup (optional ops + Marker)

The bundled **pdf-lib** backend needs nothing. The optional Python backend powers
extraction, redaction, OCR, forms, encryption, PDF/A, signatures, and the
Markdown engines. The extension resolves **one** Python interpreter for *all*
Python ops — either the first on PATH that can `import fitz`, or the one you set
in **`pdfStudio.pythonPath`**.

## Recommended: a dedicated virtual environment

Point the extension at a purpose-built venv so heavy ML deps (Marker pulls in
`torch` + Surya) **don't pollute your main Python** — installing `marker-pdf`
globally will happily replace a CUDA `torch` with a CPU build and break unrelated
tools (torchaudio, etc.).

### 1. Create the venv

```bash
python -m venv D:/tools/pdf-studio-venv        # any location you like
```

### 2. Install the full stack (one consistent, resolvable set)

```bash
D:/tools/pdf-studio-venv/Scripts/python -m pip install \
  --only-binary numpy "numpy==2.3.2" \
  PyMuPDF pymupdf4llm pikepdf pypdf reportlab \
  "ocrmypdf<17" "markitdown[pdf]" pyHanko marker-pdf
```

Verify:

```bash
D:/tools/pdf-studio-venv/Scripts/python -c "import fitz,pymupdf4llm,pikepdf,ocrmypdf,markitdown,marker,pyhanko; print('OK')"
```

### 3. Point the extension at it

Add to **user** `settings.json` (`pdfStudio.pythonPath` is machine-scoped):

```jsonc
{
  "pdfStudio.pythonPath": "D:/tools/pdf-studio-venv/Scripts/python.exe"
}
```

Reload VS Code. The **Dependencies** view should now show everything green.

## Gotchas learned the hard way (why the pins above)

- **`--only-binary numpy "numpy==2.3.2"`** — on **Python 3.13**, a fresh resolve
  can backtrack numpy to `1.26.4`, which has **no 3.13 wheel** → pip tries to
  compile it → fails (no C compiler on Windows). Pinning a 3.13-wheel numpy
  (2.3.2) stops the backtrack.
- **`ocrmypdf<17`** — `ocrmypdf` 17.x requires `pypdfium2>=5` + a newer
  `pdfminer-six`, but **Marker** (via `pdftext`) pins `pypdfium2==4.30.0`. They
  are mutually exclusive; a fresh venv errors with `ResolutionImpossible`.
  `ocrmypdf` **16.13** resolves cleanly with the Marker stack and is functionally
  equivalent for `ocr` / `ocr_first` / `pdf_to_pdfa`. (A global `pip install
  marker-pdf` "works" only because pip leaves the env in an inconsistent state.)
- **System tools still required** for some ops regardless of the venv:
  Ghostscript + qpdf (compress/linearize), Tesseract (OCR), LibreOffice (Office
  conversions). These are OS packages, not pip — see the Dependencies view for
  per-platform install hints.

### OCR languages (Tesseract tessdata)

The `ocr` op and `extract_markdown`'s OCR pre-pass use Tesseract, which needs a
`<lang>.traineddata` file per language. `eng` ships with most installs; others
(e.g. `hin` for Devanagari) must be added. The `ocr` op now **preflights** the
requested language and fails with an install hint if it's missing, and the
Dependencies panel lists what you have (from `tesseract --list-langs`).

- **Windows** (UB-Mannheim installer): re-run the installer and tick the language,
  or drop `<lang>.traineddata` into `C:\Program Files\Tesseract-OCR\tessdata\`.
- **macOS**: `brew install tesseract-lang`, or one file into `$(brew --prefix)/share/tessdata/`.
- **Linux**: `apt install tesseract-ocr-hin` (Debian/Ubuntu), etc.
- Best accuracy: the `tessdata_best` models from `github.com/tesseract-ocr/tessdata_best`.

`ocr: { optimize: 1..3 }` additionally needs **pngquant** and/or **jbig2enc** on
PATH; without them OCRmyPDF skips or errors on that optimization.

## Marker (best-quality scanned-book → Markdown)

`extract_markdown` / `pdf_to_markdown` with `engine: marker` uses Surya OCR +
layout models — dramatically better on scans (it re-reads the page images, fixing
mashed words / running heads / reading order) than the text-layer engines.

- **First run downloads models** (a few GB) and is slow.
- **CPU is slow**: ~minutes for a handful of pages; a full book runs for *hours*.
  For whole books on CPU, prefer `pymupdf4llm` with `ocr_first: true` +
  `margins: 50`. To use the GPU, install a CUDA `torch` **inside this venv** and
  Marker picks it up automatically.

## Quality range for scans (fast → best)

| Setting | Notes |
|---|---|
| `extract_markdown: {}` | pymupdf4llm on the existing text layer — fast; `ocr: auto` (default) OCRs only pages that lack text |
| `{ margins: 50 }` | clip top/bottom N pt → drop running heads/footers/page numbers |
| `{ ocr: force }` | re-OCR a clean text layer first (OCRmyPDF/Tesseract) — lossy; supersedes the old `ocr_first: true` |
| `{ engine: marker }` | Surya OCR + layout — best on scans, slow on CPU |
| `{ engine: marker, endpoint: "http://gpu:8800/marker/pdf" }` | remote Marker over HTTP — GPU quality with no local models; chunked + resumable (needs `pdfStudio.allowRemoteRender`) |

They compose, e.g. `extract_markdown: { engine: marker, margins: 50 }`.

### Benchmark quick reference (which engine to install)

From an independent 16-engine benchmark (OmniDocBench + a full 4,494-page PDF).
**TEDS** = table-structure fidelity (higher is better; 0 = tables flattened). The full
write-up — per-page-type picks, free NVIDIA cloud endpoints, failure rates — is in the
**OCR engines** example gallery README (Documentation panel → *ocr-engines*).

| engine | wired | TEDS (tables) | throughput (GPU) | VRAM | reach for it when |
|---|---|---:|---:|---:|---|
| **MinerU 2.5-Pro** (`engine: mineru`) | ✅ | **0.96** | ~98 pg/min | 2.4 GB | **best tables/forms/financials** |
| **PaddleOCR-VL** (`engine: paddleocr-vl`) | ✅ | 0.00 (flattens) | ~311 pg/min | 1.8 GB | fast **searchable text at scale** (a big archive) |
| **Marker** (`engine: marker`) | ✅ | 0.84 (markdown) | ~5 pg/min | GPU | **faithful Markdown + figures** (books, RAG) |
| **Qwen3-VL** (`extract_receipt`) | ✅ | 0.69 | 18 pg/min | ~10 GB | **receipt/invoice fields** → JSON/CSV |
| **Tesseract** (`ocr`) | ✅ | — | 40 pg/min (CPU) | 0 (CPU) | **zero-cost searchable PDF** from typed scans |

_Clean-text accuracy is a near-tie across all of these; the real differentiators are table
structure and speed. Throughput is on a **GPU** (batched); Tesseract is CPU-only. On CPU the VLM
engines are far slower — e.g. MinerU runs ~5 pg/min via its `transformers` backend (fine for a
few pages)._

### PaddleOCR-VL engine (local 0.9B doc-parser)

`extract_markdown: { engine: paddleocr-vl }` runs Baidu's **PaddleOCR-VL** (a 0.9B
vision-language document parser — strong on scans, tables, and formulas, and
**CPU-capable**). It's an alternative to Marker with a much smaller model.

Because PaddlePaddle is a heavy stack that conflicts with the PyMuPDF/marker pins,
it runs in its **own venv**, addressed by an env var — it never enters the main
sidecar venv:

```bash
python -m venv D:/LynxDI/paddle-venv          # a SEPARATE venv (Python 3.9–3.13)
D:/LynxDI/paddle-venv/Scripts/pip install "paddlepaddle==3.2.0" "paddleocr[doc-parser]"
setx PDFSTUDIO_PADDLE_PYTHON "D:/LynxDI/paddle-venv/Scripts/python.exe"   # restart VS Code
```

- First run downloads the ~0.9B model (a few hundred MB–GB), then caches it.
- CPU is fine (that's the point); set `$PDFSTUDIO_PADDLE_DEVICE=gpu` only on a
  supported CUDA GPU (compute capability ≥ 8.0 — a 4 GB Turing card can't serve it).
- If `$PDFSTUDIO_PADDLE_PYTHON` is unset, the sidecar tries its own interpreter and
  fails clearly if PaddleOCR isn't there. The engine falls back to `pymupdf4llm` on error.

### MinerU engine (local MinerU 2.5-Pro VLM — best tables)

`extract_markdown: { engine: mineru }` runs **MinerU 2.5-Pro** (`opendatalab/MinerU2.5-Pro`,
a 1.2B document VLM) — the benchmark's **table-structure leader** (real HTML tables/forms).
Like PaddleOCR-VL it's a heavy, pin-conflicty stack, so it runs in its **own venv** addressed
by an env var — never the main sidecar venv:

```bash
python -m venv D:/LynxDI/mineru-venv          # a SEPARATE venv (Python 3.10–3.13)
D:/LynxDI/mineru-venv/Scripts/pip install -U "mineru[core]"
setx PDFSTUDIO_MINERU_PYTHON "D:/LynxDI/mineru-venv/Scripts/python.exe"   # restart VS Code
```

- First run downloads the ~1.2B VLM (~2.4 GB), then caches it.
- **CPU-capable** via the `transformers` backend (no GPU needed) — but **slow**
  (~minutes/page), so it's best for a **handful of pages**. `mineru[core]` installs a CPU
  torch by default; for GPU, install a CUDA `torch` in this venv (the model fits in ~2.4 GB
  VRAM). For volume, run MinerU's vLLM backend on a Linux/CUDA box.
- MinerU does its **own** image OCR, so PDF Studio skips the OCRmyPDF pre-pass for it (no
  Tesseract needed). It falls back to `pymupdf4llm` if the venv/CLI is missing.
- If `$PDFSTUDIO_MINERU_PYTHON` is unset, the sidecar tries `mineru` on PATH.

## Receipt/invoice extraction with a vision model (`extract_receipt`)

`extract_receipt` reads receipts as **images** with a vision-language model
(Qwen3-VL) and writes structured fields — merchant, date, currency, subtotal,
tax, tip, total, and line items — to `receipts.json` + `receipts.csv`. Use it
where `extract_form` can't help: photos and scans with no AcroForm and no
reliable text layer.

**Nothing is installed into this venv.** The sidecar only rasterizes the page
(PyMuPDF) and POSTs it to an OpenAI-compatible endpoint over stdlib HTTP, so the
torch/vLLM stack can never collide with the `pypdfium2` / `ocrmypdf` pins above.
The model runs in its own process — on another machine if you like.

### Point it at a server

| Setting | Where |
|---|---|
| `endpoint` param, or `$PDFSTUDIO_VLM_ENDPOINT` | OpenAI-compatible base URL ending in `/v1` |
| `model` param, or `$PDFSTUDIO_VLM_MODEL` | model name (default `qwen3-vl-8b`) |
| **`pdfStudio.allowRemoteRender`** | **required** — page-image bytes go to the model server |

```yaml
version: 1
inputs: [receipts/*.pdf]          # a whole folder folds into ONE table
operations:
  - extract_receipt: { endpoint: "http://gpu:8801/v1", model: qwen3-vl-8b }
# no output: block — it writes its own files (default output/receipts/)
```

Re-runs are incremental: `receipts.json` doubles as a ledger keyed by content
hash, so an unchanged file costs **no model call** (`resume: false` re-reads all).

### Serving the model

```bash
# production — a GPU box (needs ~16-18 GB VRAM at fp16, ~8 GB at 4-bit)
vllm serve Qwen/Qwen3-VL-8B-Instruct --port 8801
```

**Hardware reality:** an 8B vision model does *not* fit on a small GPU. Check
`nvidia-smi` before assuming a local run — a 4 GB card (e.g. a T1000) is roughly
4× short even at 4-bit, and vLLM is Linux/CUDA-only and keeps the whole model in
VRAM. Serve it from a machine with a ≥16 GB NVIDIA GPU and point `endpoint` at it.

For a **CPU smoke test** of the wiring (slow — expect ~30 s–2 min per page, and
much weaker accuracy), any OpenAI-compatible vision server works:

```bash
ollama serve && ollama pull qwen2.5vl:3b
# then: extract_receipt: { endpoint: "http://localhost:11434/v1", model: qwen2.5vl:3b }
```

## NVIDIA free cloud endpoints — translate, semantic search & OCR with no local GPU

[**build.nvidia.com**](https://build.nvidia.com) hosts hundreds of models behind a **free**,
OpenAI-compatible API. Point PDF Studio at it and three capabilities work with **no local
model, no GPU, and nothing to install** — just an API key. This is the fastest way to try
`translate`, `semantic_search`, and vision OCR (`extract_receipt`). *(All three were verified
end-to-end against these endpoints: French translation, a 4096-dim embedding, and a receipt
transcription.)*

### Step 1 — get a free API key (2 minutes)

1. Open any model page, e.g. [riva-translate-4b](https://build.nvidia.com/nvidia/riva-translate-4b-instruct-v1_1),
   and **sign in** (free — Google/GitHub/email).
2. Click **"Get API Key"** (top-right of the code panel). It generates a key that starts with
   **`nvapi-`**. Copy it.
3. New accounts get free credits; the key works across *every* model on the site.

### Step 2 — set the key + endpoints, then restart VS Code

One key covers all three capabilities. The base URL is always
`https://integrate.api.nvidia.com/v1`. On **Windows** use `setx` (then fully restart VS Code so
it picks up the new environment); on **macOS/Linux** `export` them (from the shell you launch
`code` from, or your shell profile):

```powershell
setx NVIDIA_API_KEY           "nvapi-…"
# Translate:
setx PDFSTUDIO_LLM_ENDPOINT   "https://integrate.api.nvidia.com/v1"
setx PDFSTUDIO_LLM_MODEL      "nvidia/riva-translate-4b-instruct-v1.1"
# Semantic search (embeddings):
setx PDFSTUDIO_EMBED_ENDPOINT "https://integrate.api.nvidia.com/v1"
setx PDFSTUDIO_EMBED_MODEL    "nvidia/nv-embed-v1"
# OCR / vision (extract_receipt): set per-workflow (below) or globally:
setx PDFSTUDIO_VLM_ENDPOINT   "https://integrate.api.nvidia.com/v1"
setx PDFSTUDIO_VLM_MODEL      "meta/llama-3.2-90b-vision-instruct"
```

The key is read from `NVIDIA_API_KEY` (or a per-capability `PDFSTUDIO_{LLM,EMBED,VLM}_API_KEY`
override). For the embedders the extension sends the required `input_type` (query vs passage)
automatically — you don't configure that.

### Step 3 — turn on the gate + run

Sending bytes to the cloud is **off by default**. Enable the matching machine-scoped setting:

- `translate` / `semantic_search` → **`pdfStudio.allowAiRequests`**
- OCR (`extract_receipt`) → **`pdfStudio.allowRemoteRender`**

Then run a workflow. For OCR you can also set the endpoint/model inline (no env var needed):

```yaml
operations:
  - extract_receipt:
      endpoint: "https://integrate.api.nvidia.com/v1"
      model: "meta/llama-3.2-90b-vision-instruct"
```

`translate` and `semantic_search` need no per-op config — they read the `PDFSTUDIO_LLM_*` /
`PDFSTUDIO_EMBED_*` env vars above.

### Recommended models (verify the exact id on each page)

The config accepts *any* model id, so a NVIDIA rename never needs a code change — copy the id
from the model's page.

| Capability | Model | Page |
| --- | --- | --- |
| **Translate** | `nvidia/riva-translate-4b-instruct-v1.1` | [link](https://build.nvidia.com/nvidia/riva-translate-4b-instruct-v1_1) |
| **Embeddings** | `nvidia/nv-embed-v1` | [link](https://build.nvidia.com/nvidia/nv-embed-v1) |
| **Embeddings** | `nvidia/nemotron-3-embed-1b` | [link](https://build.nvidia.com/nvidia/nemotron-3-embed-1b) |
| **OCR / vision** | `meta/llama-3.2-90b-vision-instruct` | [image-to-text models →](https://build.nvidia.com/models?filters=usecase%3Ausecase_image_to_text) |
| **OCR / vision** | `nvidia/nemotron-nano-12b-v2-vl`, `google/paligemma`, `mistralai/…` | (same list) |

### Privacy & limits

- **Data leaves your machine** — that's why the gates above default off. Only the specific op's
  bytes are sent (translate/search send extracted *text*; OCR sends *page images*).
- These are **free, rate-limited preview endpoints** — great for trying a capability or light
  use, not a high-volume overnight batch. For that, **self-host** the model (vLLM / Ollama — see
  the sections above) and point the same env vars at `http://localhost:…/v1` (no key needed).
