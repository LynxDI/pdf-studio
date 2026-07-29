# Engineering notes — Q3

Shipped this quarter:

- **Mixed-input merge** — one workflow now combines PDFs, Office documents, Markdown and
  images without a conversion step per file type.
- **Page surgery** — `move_pages` and `swap_pages`, plus compact page ranges (`"5-8"`).
- **PowerPoint → PDF** for a whole folder, one file each or all merged.

## Risks

Conversion of Office formats depends on LibreOffice being installed on the machine that
renders. The Dependencies view reports this before a run, not during one.
