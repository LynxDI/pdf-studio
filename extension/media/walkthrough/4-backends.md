## Nothing required, more when you want it

The **bundled** engine (pdf-lib) needs zero installs — merge, split, pages, watermarks, stamps,
metadata, page numbers, images→PDF all work the moment you install the extension.

Everything heavier uses an **optional dependency** the extension auto-detects. The **Dependencies**
view colour-codes them: green when ready, amber with a one-click install hint when not.

| Dependency | Unlocks |
|---|---|
| **Python** (PyMuPDF, pikepdf, OCRmyPDF) | forms, extraction, true redaction, encryption, OCR, PDF/A |
| **LibreOffice** | Word/Excel/PowerPoint ⇆ PDF — needed for `create_form` from a `.docx` |
| **Chrome / Edge** | high-fidelity Markdown / HTML / URL → PDF (already on your machine) |
| **Ghostscript / qpdf** | deep compression, linearization |
| **Tesseract** | an OCR text layer |
| **Marker** | AI OCR: a scanned book → clean Markdown (optionally on a remote GPU) |
| **MarkItDown** | any file — Word, Excel, HTML, EPUB, CSV — to Markdown |
| **pyHanko** | digital signatures, RFC-3161 timestamps |

Nothing fails silently: until a dependency is present, its operations are reported **unsatisfied**
when the workflow compiles — you find out before you render, not during.

Everything runs **on your machine**. No account, no upload, no cloud. AI features (`summarize`,
`translate`, `semantic_search`) are opt-in and default to a local model via Ollama.
