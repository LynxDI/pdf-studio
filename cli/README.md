# `opw` — the OpenPDF Workflow CLI

Run the **same `@pdf-studio/core` engine** the VS Code extension uses, with no editor —
render / validate / compile a `.opw.yaml`, list the operation vocabulary, and probe
backends. Built for **CI, cron, and headless servers**: regenerate a PDF from its
workflow in a pipeline, exactly and reproducibly.

```bash
opw render   workflow.opw.yaml     # validate, then render to its output
opw validate workflow.opw.yaml     # structural diagnostics (exit 1 on errors)
opw compile  workflow.opw.yaml     # execution plan + which backend runs each op
opw ops [--json]                   # the full operation vocabulary
opw doctor [--json]                # what backends are installed / how to get the rest
```

## Dependencies — same model as the extension, minus the GUI

- **Bundled pdf-lib backend → zero install.** merge, split, rotate, delete, watermark,
  stamp, metadata, crop, n-up… all run with nothing installed.
- **Optional backends** (Python/PyMuPDF, LibreOffice, Chrome/Edge, qpdf, Ghostscript,
  Tesseract) — *you* (or CI) install them; the CLI **finds** them and **degrades
  gracefully**. An op whose backend is missing is reported by `opw compile` /
  `opw doctor`, never a crash.
- **The `pdf_exec.py` sidecar ships with the CLI** (`dist/python/pdf_exec.py`) — no
  separate install for the script itself.

### Pointing at Python

The Python-backed ops (extract_text, redact, ocr, forms, …) need a PyMuPDF-capable
interpreter. The CLI resolves it in this order:

1. `--python <path>` flag
2. `$PDFSTUDIO_PYTHON`
3. auto-detect `python3` / `python` on `PATH`

```bash
opw doctor --python /path/to/venv/bin/python     # verify it's found
PDFSTUDIO_PYTHON=/path/to/venv/bin/python opw render scan.opw.yaml
```

Other env vars mirror the extension's settings: `PDFSTUDIO_ALLOW_AI` /
`--allow-ai` (permit summarize/translate to call a model), `PDFSTUDIO_ALLOW_REMOTE` /
`--allow-remote` (permit `remote:` SSH offload), `PDFSTUDIO_PADDLE_PYTHON`,
`PDFSTUDIO_VLM_ENDPOINT`, `PDFSTUDIO_VLM_MODEL`.

## CI example

```yaml
# .github/workflows/pdf.yml
- run: pip install pymupdf pikepdf         # only if the workflow uses Python-backed ops
- run: npx opw render report.opw.yaml      # deterministic: same inputs → same PDF
```

## Build

```bash
cd cli && npm run build      # tsc -b + esbuild → dist/index.cjs (+ dist/python/pdf_exec.py)
node dist/index.cjs --help
```

The bundle is self-contained (core + pdf-lib inlined); the sidecar is copied from
`extension/resources/python/pdf_exec.py` (one source of truth).
