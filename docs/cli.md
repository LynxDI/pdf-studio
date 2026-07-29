# `opw` — the command-line runner (for CI, servers & automation)

**You don't need this inside VS Code.** In the editor you already render a workflow with
the ▶ **Render** button (or by saving the `.opw.yaml`). The `opw` CLI is the *same engine*
for the places VS Code can't run — a **CI pipeline, a headless server, a cron job, a Docker
image, or a plain terminal**.

One engine, three front-ends, three audiences:

| Front-end | Who it's for | How a render is triggered |
|---|---|---|
| **This VS Code extension** | a person editing a workflow | click ▶ Render (or save) |
| **MCP server** | an AI coding agent | the agent calls `opw_validate`, etc. |
| **`opw` CLI** | **automation / servers / scripts** | `opw render workflow.opw.yaml` |

## Commands

```bash
opw render   workflow.opw.yaml     # validate, then render to its output
opw validate workflow.opw.yaml     # structural diagnostics only (exit 1 on errors)
opw compile  workflow.opw.yaml     # print the execution plan + which backend runs each op
opw ops [--json]                   # list the whole operation vocabulary
opw doctor [--json]                # which backends are installed, and how to get the rest
opw --help
```

Exit codes are CI-friendly: `0` on success, `1` on validation errors or a failed render.

## Dependencies — the same model as this extension, minus the GUI

- **The bundled pdf-lib backend needs nothing installed.** merge, split, rotate, delete,
  watermark, stamp, metadata, crop, n-up… all run out of the box.
- **The heavier ops need an optional backend** (Python/PyMuPDF, LibreOffice, Chrome/Edge,
  qpdf, Ghostscript, Tesseract) — exactly the ones the **Dependencies** view lists here.
  You (or your CI) install them; the CLI **finds** them and **degrades gracefully**: an op
  whose backend is missing is reported by `opw compile` / `opw doctor`, never a crash.
- **The Python helper (`pdf_exec.py`) ships with the CLI** — no separate install for the
  script itself, only the Python interpreter + libraries.

### Pointing the CLI at Python

Python-backed ops (extract_text, redact, ocr, forms, extract_markdown, …) need a
PyMuPDF-capable interpreter. The CLI resolves it in this order:

1. `--python <path>` flag
2. the `PDFSTUDIO_PYTHON` environment variable
3. auto-detect `python3` / `python` on `PATH`

```bash
opw doctor --python /path/to/venv/bin/python          # confirm it's found
PDFSTUDIO_PYTHON=/path/to/venv/bin/python opw render scan.opw.yaml
```

Other toggles mirror this extension's settings: `--allow-ai` / `PDFSTUDIO_ALLOW_AI`
(let summarize/translate call a model), `--allow-remote` / `PDFSTUDIO_ALLOW_REMOTE`
(let a `remote:` op offload over SSH).

## Typical scenarios

**1. Regenerate a PDF in CI on every change** — the payoff of "PDFs as code": the
workflow is committed to the repo, and the PDF is rebuilt reproducibly with no human.

```yaml
# .github/workflows/pdf.yml
- run: pip install pymupdf pikepdf      # only if the workflow uses Python-backed ops
- run: npx opw render report.opw.yaml   # same inputs → byte-identical PDF
```

**2. A nightly server job** — watermark + compress the day's invoices on a headless box:

```bash
0 2 * * *  opw render /srv/invoices/nightly.opw.yaml
```

**3. A validation gate** — fail a build (or a pre-commit hook) if a workflow is malformed:

```bash
opw validate workflows/*.opw.yaml
```

**4. A Docker step** — a container with Node + `opw` (+ Python) becomes a reusable
PDF-processing stage in a larger pipeline.

## Getting the CLI

The CLI lives in the PDF Studio toolchain as the `@pdf-studio/cli` package (bin: `opw`).
Build it from the monorepo (`cd cli && npm run build`), which produces a self-contained
`dist/index.cjs` you can run with Node anywhere — it inlines the engine and copies the
Python helper alongside itself, so it carries no dependency on the editor.
