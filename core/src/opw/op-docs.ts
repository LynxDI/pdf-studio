// Per-operation usage guidance + a concrete example. Surfaced in the extension's
// "Add Operation" input box and in the MCP `opw_operations` listing, so both
// humans and agents know how to actually use each op — what input it expects,
// which params matter, and a ready-to-edit example. The op registry
// (operations.ts) stays the source of truth for names/params; this adds the
// human-facing "how do I use it".
//
// GENERATED helper note: the example/inputs/output/result fields were authored to
// be complete, copy-pasteable workflows and validated against parse+validate.

export interface OpDoc {
  /** 1–2 sentences: what it does, what INPUT it expects, and the key params. */
  usage: string;
  /** A ready-to-use YAML flow-style params string (drop-in default). */
  example: string;
  /** Sample inputs for the full-workflow doc example. Omit to default to a
   *  single `input.pdf`; use `[]` for source-less ops (url_to_pdf). */
  inputs?: string[];
  /** Operations the example must run FIRST, as `name: params` strings. Some ops only make
   *  sense downstream of another — create_form needs a converter to have rendered the
   *  template — and an example that can't be pasted and run is worse than none. */
  before?: string[];
  /** Operations the example must run AFTER, as `name: params` strings. Some ops are only
   *  half an answer on their own — a cover page fixes the thumbnail, but the shelf title
   *  comes from set_metadata — and the canonical example should model the whole pattern
   *  (the validator warns about exactly this omission). */
  after?: string[];
  /** Sample `output.file` for the full-workflow doc example. */
  output?: string;
  /** Omit the `output:` block entirely. For ops that write their own files to a `to` param
   *  (extract_form), naming an `output.file` would imply a passthrough document that never
   *  gets produced. */
  noOutput?: boolean;
  /** One concise sentence describing the concrete result of the example. */
  result?: string;
  /** Extra named, copy-pasteable workflows beyond the single-op example — for ops whose
   *  real use is a recipe rather than one line (a folder of .pptx → one PDF per deck, or
   *  every deck folded into one). Rendered after the main example, in both the op's
   *  documentation page and the committed operations reference. */
  recipes?: { title: string; description: string; yaml: string }[];
}

/**
 * Search-only synonyms, per operation. People hunt for an operation by the thing they
 * have — "powerpoint", "pptx", "slides" — not by its name or by whatever words happen to
 * appear in its description. Relying on prose means `office_to_pdf` is unreachable by
 * "powerpoint" (its usage says "Office document") while `pdf_to_pptx` is findable, which
 * is exactly backwards for someone holding a deck.
 *
 * These are NOT valid YAML spellings (that's `aliases` in the registry) — they only widen
 * what the Operations panel's filter matches. Add freely: file extensions, product names,
 * and the plain-English verb someone would type.
 */
export const SEARCH_KEYWORDS: Record<string, string[]> = {
  // --- Convert to/from PDF: the app and format names people actually type ---
  office_to_pdf: ["powerpoint", "power point", "ppt", "pptx", "slides", "slide deck", "deck", "presentation", "lecture",
    "word", "doc", "docx", "excel", "xls", "xlsx", "spreadsheet", "office", "libreoffice", "openoffice",
    "odt", "ods", "odp", "rtf", "convert"],
  pdf_to_pptx: ["powerpoint", "power point", "ppt", "pptx", "slides", "deck", "presentation", "convert"],
  pdf_to_docx: ["word", "doc", "docx", "editable", "convert"],
  pdf_to_xlsx: ["excel", "xls", "xlsx", "spreadsheet", "sheet", "convert"],
  pdf_to_html: ["html", "web page", "website", "convert"],
  pdf_to_epub: ["epub", "ebook", "kindle", "reader", "convert"],
  epub_to_pdf: ["epub", "ebook", "kindle", "convert"],
  images_to_pdf: ["image", "images", "photo", "photos", "picture", "jpg", "jpeg", "png", "webp", "tiff", "heic",
    "heif", "iphone", "svg", "psd", "photoshop", "scan", "vector"],
  video_to_pdf: ["video", "mp4", "mov", "movie", "recording", "frames", "contact sheet", "storyboard",
    "screenshots", "footage", "lecture", "screen recording", "ffmpeg", "thumbnails"],
  markdown_to_pdf: ["markdown", "md", "readme", "notes"],
  html_to_pdf: ["html", "htm", "web page", "webpage"],
  url_to_pdf: ["url", "link", "web page", "website", "archive", "snapshot"],
  eml_to_pdf: ["email", "e-mail", "eml", "outlook", "message", "inbox"],
  // --- Everything else, keyed on the word a newcomer reaches for first ---
  merge: ["combine", "join", "concatenate", "append", "together", "one file", "interleave", "alternate",
    "mixed", "anything", "different types", "docx", "word", "pptx", "powerpoint", "images", "markdown", "convert"],
  split: ["separate", "burst", "divide", "chop", "break apart", "max size", "file size limit", "upload limit",
    "5mb", "under 5 mb", "too big", "size limit", "attachment limit", "chunks", "parts", "e-filing"],
  compress: ["shrink", "reduce", "smaller", "size", "optimize", "optimise", "max size", "file size limit",
    "under 5 mb", "too big", "email limit", "upload limit", "target size", "downsample"],
  encrypt: ["password", "protect", "secure", "lock"],
  decrypt: ["password", "unlock", "remove password", "unprotect"],
  redact: ["black out", "censor", "hide", "remove text", "confidential"],
  auto_redact: ["black out", "censor", "pii", "personal", "ssn", "gdpr"],
  watermark: ["draft", "confidential", "stamp", "overlay", "background"],
  n_up: ["2-up", "4-up", "handout", "handouts", "slides per page", "multiple pages per sheet", "print"],
  booklet: ["print", "fold", "saddle stitch", "imposition"],
  ocr: ["scan", "scanned", "searchable", "text layer", "tesseract", "recognize", "recognise"],
  extract_text: ["copy text", "get text", "plain text", "txt"],
  extract_images: ["photos", "pictures", "save images", "embedded images", "pull images out"],
  // "render_pages" is not what anyone converting a PDF types — they type "png".
  render_pages: ["png", "jpg", "jpeg", "image", "images", "picture", "thumbnail", "screenshot",
    "preview", "rasterize", "svg", "pdf to png", "pdf to jpg", "pdf to image", "convert to image", "export"],
  pdf_to_png: ["png", "image", "images", "picture", "thumbnail", "screenshot", "transparent", "convert", "export"],
  pdf_to_jpg: ["jpg", "jpeg", "image", "images", "photo", "thumbnail", "convert", "export"],
  rotate_pages: ["turn", "orientation", "landscape", "portrait", "sideways", "upside down"],
  delete_pages: ["remove pages", "drop pages", "erase pages"],
  extract_pages: ["keep pages", "take pages", "subset", "pull out"],
  fill_form: ["form", "fill in", "acroform", "application"],
  create_form: ["fillable", "form fields", "make form"],
  flatten: ["lock form", "make read only", "freeze"],
  sign: ["signature", "digital signature", "certificate", "esign"],
  set_metadata: ["title", "author", "properties", "subject"],
  title_page: ["cover", "cover page", "front page", "title", "frontispiece", "kindle", "ebook",
    "e-reader", "thumbnail", "book", "divider", "section divider", "first page"],
  insert_pages: ["insert pdf", "add pages", "cover pdf", "prepend", "put in front"],
  add_page_numbers: ["pagination", "numbering", "folio"],
};

export const OP_DOCS: Record<string, OpDoc> = {
  // --- Pages & layout ---
  merge: {
    usage: "Combines the workflow's `inputs` into one PDF. Either list files in order (`inputs: [a.pdf, b.pdf]`), or point at a whole folder with a glob (`inputs: [docs/*.pdf]`) to merge every matching file in **sorted filename order** — that's why zero-padded names (part_000001.pdf) matter for a re-merge.\n\n**Inputs don't have to be PDFs.** A Word document, a PowerPoint deck, images, Markdown, HTML, an email or an EPUB are converted to PDF first — the converter is chosen from each file's extension — and PDFs pass straight through. So one `merge` combines whatever you happen to have. Set `convert: false` to require every input to already be a PDF. Converting Office files needs LibreOffice; `opw_compile` reports a missing backend before you render.\n\nSet `interleave: true` (or write the op as `interleave: {}`) to **alternate** pages round-robin instead of concatenating: A p1, B p1, A p2, B p2, … That's how you put a document and its translation side by side, or rejoin a duplex scan whose fronts and backs were scanned into two files. Inputs that run out early are padded with blank pages, so each source keeps its own slot to the last page — which is what makes a following `n_up: { cols: 2, rows: 1 }` pair them correctly.",
    example: "{}",
    inputs: ["cover-page.pdf","chapter-01.pdf","chapter-02.pdf"],
    output: "output/full-manuscript.pdf",
    result: "Concatenates the cover page and both chapters, in listed order, into a single manuscript PDF.",
    recipes: [
      {
        title: "Mixed file types → one PDF",
        description:
          "List whatever you have. Each non-PDF is converted by the operation that claims its extension (`.docx` → office_to_pdf, `.png` → images_to_pdf, `.md` → markdown_to_pdf); PDFs pass through untouched. Pages come out in the order listed.",
        yaml: [
          "version: 1",
          "kind: pdf",
          "inputs:",
          "  - cover.pdf",
          "  - finance-summary.docx",
          "  - engineering-notes.md",
          "  - revenue-chart.png",
          "operations:",
          "  - merge: {}",
          "output:",
          "  file: output/board-pack.pdf",
        ].join("\n"),
      },
      {
        title: "A whole folder, whatever is in it",
        description:
          "A glob feeds every matched file into one merge, in sorted filename order, regardless of type. Drop a new file into the folder and it joins on the next render — no edit needed. Name files 01-, 02-, 03- to fix the order.",
        yaml: [
          "version: 1",
          "kind: pdf",
          "inputs:",
          "  - input/*",
          "operations:",
          "  - merge: {}",
          "  - add_page_numbers: { position: bottom-center }",
          "output:",
          "  file: output/combined.pdf",
        ].join("\n"),
      },
      {
        title: "Strict: refuse anything that isn't already a PDF",
        description:
          "`convert: false` restores the original behaviour — a non-PDF input is an error rather than a silent conversion. Useful when an unexpected file type should fail the build instead of being absorbed.",
        yaml: [
          "version: 1",
          "kind: pdf",
          "inputs:",
          "  - archive/*.pdf",
          "operations:",
          "  - merge: { convert: false }",
          "output:",
          "  file: output/archive.pdf",
        ].join("\n"),
      },
    ],
  },
  split: {
    usage:
      "Splits the working PDF into several output files, three ways: explicit `ranges`, `every` N pages, or **`max_size`** — pack as many pages as fit under a file-size limit.\n\n`max_size` is the one to reach for when something else imposes the limit: an upload form that caps at 5 MB, an email attachment, a court e-filing system. Splitting by page count can't satisfy that, because pages aren't uniform — one part full of scans blows the cap while a text-only part wastes it. Every part is **measured**, not estimated, so the guarantee is real.\n\nGive `max_size` a unit: `\"5MB\"` is decimal (5,000,000) and `\"5MiB\"` is binary (5,242,880) — most upload validators check the binary one, so leave headroom (`\"4.8MB\"` for a 5 MB cap) rather than betting on which they meant. No hidden safety margin is applied.\n\nUse `name` to control the filenames — `part_000001.pdf` is fine for a person, useless to a Makefile.",
    example: "{ ranges: [\"1-1\", \"2-12\", \"13-40\"] }",
    inputs: ["annual-report-2024.pdf"],
    output: "output/report-section.pdf",
    result: "Splits the annual report into three files — cover (p.1), MD&A (p.2-12), and financial statements (p.13-40).",
    recipes: [
      {
        title: "Every part under an upload limit",
        description:
          "The whole point of `max_size`. A 1,500-page, 32 MB filing against a 5 MB upload cap becomes a handful of parts that each fit, in one render — no guessing page ranges and re-checking sizes in Explorer. Compress first so there are fewer parts to upload.",
        yaml: [
          "version: 1",
          "kind: pdf",
          "inputs:",
          "  - application.pdf",
          "operations:",
          "  - compress: {}",
          "  - split:",
          '      max_size: "4.8MB"          # headroom under a 5 MB cap',
          '      name: "application-part-{i:02}"',
          "output:",
          "  folder: output/parts",
        ].join("\n"),
      },
      {
        title: "Name the parts for a build pipeline",
        description:
          "`{stem}` is the input's filename without its extension, `{i}` the part number (pad it with `{i:03}`), and `{start}`/`{end}`/`{n}` describe the pages each part holds. The same token set works in a batch `output.file`.",
        yaml: [
          "version: 1",
          "kind: pdf",
          "inputs:",
          "  - handbook.pdf",
          "operations:",
          '  - split: { every: 20, name: "{stem}-pages-{start}-to-{end}" }',
          "output:",
          "  folder: output/sections",
          "# → handbook-pages-1-to-20.pdf, handbook-pages-21-to-40.pdf, …",
        ].join("\n"),
      },
      {
        title: "Burst — one file per page",
        description:
          "`burst` is `split` with `every: 1`, spelled the way pdftk users expect. Combine it with `name` to get numbered single pages.",
        yaml: [
          "version: 1",
          "kind: pdf",
          "inputs:",
          "  - scan.pdf",
          "operations:",
          '  - burst: { name: "page-{i:04}" }',
          "output:",
          "  folder: output/pages",
        ].join("\n"),
      },
    ],
  },
  split_invoices: {
    usage:
      "Splits a PDF that concatenates many invoices/receipts into one PDF per invoice. Set `output.folder` (or the op's `to` param) as the destination. Detects boundaries from the page text (\"Page 1 of N\" resets, invoice-number changes, header keywords) and names each file from the detected invoice number/date/vendor via `name`. Scans: add `ocr_first: true`. Always writes a `_manifest.csv` (page ranges + metadata) so you can verify the split. Escape hatch: pass explicit `starts` (1-based page numbers).",
    example: "{ name: \"{invoice_number}\" }",
    inputs: ["invoices-batch.pdf"],
    output: "output/invoices",
    result: "Detects each invoice in the batch and writes one PDF per invoice to output/invoices/ (named by invoice number), plus output/invoices/_manifest.csv.",
  },
  delete_pages: {
    usage: "Removes the listed 1-based pages from the working PDF.",
    example: "{ pages: [2, 7, 12] }",
    inputs: ["scanned-contract.pdf"],
    output: "output/contract-clean.pdf",
    result: "Removes the three blank separator pages (2, 7, and 12) from the scanned contract.",
  },
  reorder_pages: {
    usage:
      "Reorders pages to a **complete** 1-based permutation — `order` must list EVERY page of the document exactly once. It is not a way to keep a subset: a short list is rejected (it would drop the pages it left out) rather than silently obeyed. Reach for `move_pages` to move a few pages, `swap_pages` to exchange two, or `extract_pages` to deliberately keep a subset. Ranges are allowed, so reversing a long document is `order: [\"last-1\"]`.",
    example: "{ order: [1, 4, 2, 3, 5] }",
    inputs: ["board-deck.pdf"],
    output: "output/board-deck-reordered.pdf",
    result: "Reorders the 5-page board deck so the summary slide (page 4) sits right after the title.",
  },
  move_pages: {
    usage:
      "Moves pages to a new position and leaves every other page exactly where it was — the everyday \"move page 2 and pages 5-9 to after page 50\". Give `pages` (ranges allowed) plus ONE of `after` / `before`, both numbered in the ORIGINAL document, so you never have to work out what the numbers become mid-edit. `after: 0` moves the block to the very start. The destination page can't be one of the pages being moved. Unlike `reorder_pages` this needs no knowledge of the page count, which makes it the safe choice on a long document.",
    example: "{ pages: [2, \"5-9\"], after: 50 }",
    inputs: ["contract.pdf"],
    output: "output/contract-reordered.pdf",
    result: "Moves the signature page and the schedule (pages 5-9) to sit after page 50, leaving the other 40-odd pages untouched.",
  },
  swap_pages: {
    usage:
      "Exchanges the positions of two pages and leaves everything else alone. The obvious spelling of \"swap 2 and 10\" — writing that as a `reorder_pages` permutation means retyping every page number in the document.",
    example: "{ a: 2, b: 10 }",
    inputs: ["report.pdf"],
    output: "output/report-fixed.pdf",
    result: "Puts the two transposed pages back in their intended places, leaving the rest of the report byte-for-byte where it was.",
  },
  rotate_pages: {
    usage: "Rotates pages clockwise by a multiple of 90°. Omit `pages` to rotate all.",
    example: "{ pages: [3, 4], degrees: 90 }",
    inputs: ["scanned-survey.pdf"],
    output: "output/survey-upright.pdf",
    result: "Rotates the two landscape scan pages (3 and 4) 90° clockwise so they read upright.",
  },
  insert_blank: {
    usage: 'Inserts a blank page before the 1-based position `at`. `size` copies a neighbor by default ("match"), or takes "A4", "Letter" or "Legal".',
    example: "{ at: 2, size: Letter }",
    inputs: ["employee-handbook.pdf"],
    output: "output/handbook-print-ready.pdf",
    result: "Inserts a Letter-size blank page before page 2 so chapter 1 opens on a right-hand page for duplex printing.",
  },
  title_page: {
    usage:
      "Draws a title/cover page and inserts it at the front (`at: 1`), or anywhere else as a section divider.\n\n**Why you probably want this:** a PDF sideloaded onto a Kindle or opened in a library app shows a placeholder when page 1 is a bare scan and the Title metadata is empty. The thumbnail comes from **page 1**; the shelf title comes from the **metadata**. `title_page` fixes the first half — pair it with `set_metadata` for the second. The validator reminds you if you forget.\n\nOne type knob: `title_size`. The subtitle, author and date sizes derive from it, and their colours are blended toward the background, so a dark cover stays readable without tuning six parameters. A long title wraps to the column set by `margin` and shrinks to fit if it still overflows.\n\nThe bundled fonts cover Latin text (WinAnsi/cp1252) — including em dashes, curly quotes and accents. For a cover in Chinese, Greek or Cyrillic, build it with `markdown_to_pdf` and add it with `insert_pages` instead; the operation will tell you so rather than drawing a page of question marks.",
    example: '{ title: "Quarterly Report", subtitle: "FY2026 · Q3", author: "Finance" }',
    // The cover is only half the fix — the shelf title comes from the metadata — so the
    // canonical example models the pair rather than the thing the validator warns about.
    after: ['set_metadata: { title: "Quarterly Report", author: "Finance" }'],
    inputs: ["quarterly-report.pdf"],
    output: "output/quarterly-report-covered.pdf",
    result: "Adds a typeset cover page in front of the report — title, subtitle, a hairline rule and the author — and sets the matching document metadata.",
    recipes: [
      {
        title: "The e-reader fix — cover page plus metadata",
        description:
          "Both halves of the problem in one workflow. **Quote the colours**: in YAML a bare `#` starts a comment, so `background: #F5F2EA` silently becomes null.",
        yaml: [
          "version: 1",
          "kind: pdf",
          "inputs:",
          "  - scans/field-handbook.pdf",
          "operations:",
          "  - title_page:",
          '      title: "Field Handbook"',
          '      subtitle: "Second Edition"',
          '      author: "R. Winn"',
          '      date: "2026"',
          '      background: "#F5F2EA"',
          '      color: "#1B2A41"',
          "  - set_metadata:",
          '      title: "Field Handbook"',
          '      author: "R. Winn"',
          "output:",
          "  file: output/field-handbook.pdf",
        ].join("\n"),
      },
      {
        title: "Use a cover you already have",
        description:
          "If the cover is already a PDF (from a designer, or exported from InDesign), don't redraw it — insert it. `at: 1` means *before page 1*, i.e. the very front. `pages:` picks a subset if the cover file has more than one page.",
        yaml: [
          "version: 1",
          "kind: pdf",
          "inputs:",
          "  - manuscript.pdf",
          "assets:",
          "  cover: art/cover.pdf",
          "operations:",
          "  - insert_pages: { from: cover, at: 1 }",
          '  - set_metadata: { title: "The Salt Path", author: "Raynor Winn" }',
          "output:",
          "  file: output/the-salt-path.pdf",
        ].join("\n"),
      },
      {
        title: "A cover in any language, from Markdown",
        description:
          "The built-in PDF fonts can't draw CJK, Greek or Cyrillic. `merge` converts non-PDF inputs by extension, so a `.md` cover is rendered by `markdown_to_pdf` — which embeds real fonts — and lands as page 1. Needs a rendering backend (system Chrome, or the Python backend).",
        yaml: [
          "version: 1",
          "kind: pdf",
          "inputs:",
          "  - cover.md",
          "  - manuscript.pdf",
          "operations:",
          "  - merge: {}",
          '  - set_metadata: { title: "四季报告", author: "财务部" }',
          "output:",
          "  file: output/report.pdf",
        ].join("\n"),
      },
      {
        title: "Section dividers — insert back to front",
        description:
          "`at` is 1-based and inserts *before* that page. Add dividers from the **end backwards** (41 before 12) so each `at` still refers to the page you counted in the original document — every insertion shifts everything after it by one.",
        yaml: [
          "version: 1",
          "kind: pdf",
          "inputs:",
          "  - compendium.pdf",
          "operations:",
          '  - title_page: { at: 41, title: "Part II", subtitle: "Field Methods", title_size: 28 }',
          '  - title_page: { at: 12, title: "Part I",  subtitle: "Foundations",  title_size: 28 }',
          "output:",
          "  file: output/compendium-parts.pdf",
        ].join("\n"),
      },
    ],
  },
  extract_pages: {
    usage: "Keeps only the listed pages (drops the rest), in the order given.",
    example: "{ pages: [1, 8, 9] }",
    inputs: ["lease-agreement.pdf"],
    output: "output/lease-signature-pages.pdf",
    result: "Keeps only the cover and the two signature pages (1, 8, 9) and drops everything else.",
  },
  insert_pages: {
    usage: "Inserts another PDF's pages into the working document. `from` is an asset PDF declared under `assets:`; `at` is the 1-based position to insert before (omit to append); `pages` optionally picks which source pages.",
    example: "{ from: exhibits.pdf, at: 3 }",
    inputs: ["contract.pdf"],
    output: "output/contract-with-exhibits.pdf",
    result: "Inserts every page of the exhibits.pdf asset before page 3 of the contract.",
  },
  replace_pages: {
    usage: "Replaces pages of the working document with pages from another PDF. `from` is an asset PDF declared under `assets:`; `pages` are the 1-based pages to remove; the replacement drops in where the first removed page was. `from_pages` optionally picks which source pages.",
    example: "{ from: revised-section.pdf, pages: [4, 5] }",
    inputs: ["report.pdf"],
    output: "output/report-revised.pdf",
    result: "Swaps pages 4-5 of the report for every page of the revised-section.pdf asset.",
  },
  crop: {
    usage: "Crops pages to a rectangle [x, y, width, height] in points (origin bottom-left). Omit `pages` for all.",
    example: "{ box: [72, 500, 468, 240], pages: [4] }",
    inputs: ["quarterly-report.pdf"],
    output: "output/report-chart-crop.pdf",
    result: "Crops page 4 down to the revenue-chart region ([72,500,468,240] pt), dropping the surrounding text.",
  },
  scale_pages: {
    usage: "Resizes pages to a named `size` (A4/Letter/Legal) or by a `factor`, scaling the content to fit.",
    example: "{ size: A4 }",
    inputs: ["mixed-size-scans.pdf"],
    output: "output/normalized-a4.pdf",
    result: "Resizes every page to A4, scaling the content to fit a uniform page size.",
  },
  n_up: {
    usage: "Places `cols`×`rows` source pages onto each output page (e.g. 2×1 = two-up handouts).",
    example: "{ cols: 2, rows: 2 }",
    inputs: ["conference-slides.pdf"],
    output: "output/slides-4up-handout.pdf",
    result: "Places four slides per sheet in a 2×2 grid to produce a printable handout.",
  },
  booklet: {
    usage: "Imposes pages 2-up in saddle-stitch order for folded printing (pads to a multiple of 4). No params.",
    example: "{}",
    inputs: ["event-program.pdf"],
    output: "output/event-program-booklet.pdf",
    result: "Imposes the program 2-up in saddle-stitch order (padded to a multiple of 4) for folded booklet printing.",
  },
  poster: {
    usage: "Splits each page into a `rows`×`cols` grid of separate pages (in reading order). Use a large grid for poster printing, or **`rows: 1, cols: 2`** to halve a 2-up book scan back into single pages.",
    example: "{ rows: 1, cols: 2 }",
    inputs: ["book-2up-scan.pdf"],
    output: "output/book-single-pages.pdf",
    result: "Splits each two-page spread down the middle into separate left/right pages (halving). Use rows: 3, cols: 3 to tile a page across nine sheets for a poster instead.",
  },

  // --- Stamps & overlays ---
  watermark: {
    usage: "Stamps a diagonal `text` (or `image`) watermark across pages. Image comes from a declared asset.",
    example: "{ text: CONFIDENTIAL, opacity: 0.12, rotate: 45 }",
    inputs: ["contracts/master-services-agreement.pdf"],
    output: "output/msa-confidential.pdf",
    result: "Stamps a translucent diagonal \"CONFIDENTIAL\" watermark across every page of the agreement at 12% opacity.",
  },
  stamp: {
    usage: "Places positioned `text` or an `image` at (`x`, `y`) in points from bottom-left (not diagonal — that's watermark).",
    example: "{ image: assets/paid-stamp.png, x: 400, y: 640, width: 120, opacity: 0.9, pages: [1] }",
    inputs: ["invoices/invoice-2024-0417.pdf"],
    output: "output/invoice-0417-paid.pdf",
    result: "Stamps a 120 pt-wide \"PAID\" graphic near the top-right of the invoice's first page.",
  },
  annotate: {
    usage:
      "Adds a list of `annotations` to the PDF — free `text` boxes, text `highlight`s (by `find` text or `rect`), sticky `note`s, shapes (`rect`/`line`/`ellipse`) and `image`s. Each item names a `type`, a 1-based `page`, and a `rect [x,y,w,h]` or point `at [x,y]` in points, origin BOTTOM-LEFT (like crop/stamp). Colors are \"#RRGGBB\" or [r,g,b]. Invalid items are skipped.",
    example: "{ annotations: [{ type: highlight, page: 1, find: \"DRAFT\", color: \"#ffcc00\" }] }",
    inputs: ["proposal.pdf"],
    output: "output/proposal-annotated.pdf",
    result: "Highlights every \"DRAFT\" on page 1 in yellow and writes output/proposal-annotated.pdf.",
  },
  highlight: {
    usage:
      "Finds text ANYWHERE in the document and marks it — no coordinates, no page numbers. Give it literal strings (`text`), regexes (`regex`) or PII presets (`patterns: [email, ssn]`) — the same matcher `auto_redact` uses, with the same `ignore_case` / `whole_word` switches — and pick how to mark each hit with `style`: **highlight** (default, translucent fill), **underline**, **strikeout**, **squiggly**, or **box** (a rectangle around each line of the match). Set `color` to any \"#RRGGBB\", and `note` to attach a popup comment to every mark.\n\n" +
      "This is the non-destructive twin of `auto_redact`: same search, but it draws attention instead of deleting. Use it to flag review points, mark every occurrence of a defined term, or show a client exactly which clauses changed.\n\n" +
      "The marks are real PDF annotations — `extract_annotations` can pull them back out (with the text each one covers), `remove_annotations` clears them, and a viewer shows them in its comment list. `flatten: true` bakes them into the page instead, which makes them permanent and invisible to both of those ops. `preview: true` writes a dry-run report of every match and marks nothing — worth doing first with a regex or a PII preset.\n\n" +
      "Wrapped text: matching happens per visual line, so a phrase broken across a line break won't match. Search for a distinctive fragment that fits on one line.",
    example: "{ text: [\"Confidential\", \"Net 30\"], style: highlight, color: \"#ffd400\", ignore_case: true }",
    inputs: ["contract.pdf"],
    output: "output/contract-marked.pdf",
    result: "Highlights every \"Confidential\" and \"Net 30\" in the contract, case-insensitively, in yellow — writing output/contract-marked.pdf with each mark as a real annotation a reviewer can click.",
  },
  add_page_numbers: {
    usage: "Stamps page numbers on every page. `format` uses {n} and {total}; `position` places them.",
    example: "{ format: \"Page {n} of {total}\", position: bottom-right, start: 1, size: 9 }",
    inputs: ["reports/annual-report-2024.pdf"],
    output: "output/annual-report-2024-numbered.pdf",
    result: "Adds \"Page {n} of {total}\" numbering to the bottom-right corner of every page in 9 pt type.",
  },
  header_footer: {
    usage:
      "Stamps running headers/footers on every page. `header` and `footer` each take { left, center, right } text; tokens {n}/{total} number pages, {date} inserts the `date` param (explicit, so the render stays deterministic), and {bates} inserts a legal Bates number configured via `bates: { prefix, start, digits }`. For continuous Bates across a set of files, `merge` them first.",
    example: "{ footer: { left: \"CONFIDENTIAL\", right: \"{bates}\" }, bates: { prefix: \"ACME-\", start: 1, digits: 6 } }",
    inputs: ["discovery/contract-bundle.pdf"],
    output: "output/contract-bundle-bates.pdf",
    result: "Stamps \"CONFIDENTIAL\" bottom-left and a sequential Bates number (ACME-000001, ACME-000002, …) bottom-right on every page.",
  },
  overlay: {
    usage: "Overlays another PDF's pages on top of the current document. `over` is a declared asset PDF.",
    example: "{ over: assets/void-specimen-overlay.pdf, opacity: 0.35 }",
    inputs: ["statements/bank-statement-june.pdf"],
    output: "output/bank-statement-june-specimen.pdf",
    result: "Overlays a translucent \"SPECIMEN\" template on top of every page at 35% opacity, keeping the underlying figures readable.",
  },

  // --- Metadata, bookmarks & tables ---
  set_metadata: {
    usage: "Sets document metadata. Provide any of title/author/subject/keywords/creator/producer.",
    example: "{ title: \"2024 Annual Report\", author: \"Acme Corporation\", subject: \"Fiscal Year 2024 Results\", keywords: [\"annual report\", \"finance\", \"FY2024\"] }",
    inputs: ["annual-report-2024.pdf"],
    output: "output/annual-report-2024-tagged.pdf",
    result: "Writes the title, author, subject, and keyword fields into the report's document properties.",
  },
  set_language: {
    usage: "Sets the document's default language on the PDF catalog (/Lang) — a BCP-47 tag like \"en-US\" or \"fr\". Required for accessibility so screen readers use the right voice; check_accessibility flags a missing one.",
    example: "{ lang: en-US }",
    inputs: ["public-report.pdf"],
    output: "output/public-report-en.pdf",
    result: "Sets the report's default language to en-US so assistive technology reads it in English — clearing the missing-language accessibility failure.",
  },
  set_bookmarks: {
    usage: "Replaces the outline with a given list of { level, title, page } entries (page is 1-based).",
    example: "{ bookmarks: [{ level: 1, title: Introduction, page: 1 }, { level: 1, title: Installation, page: 4 }, { level: 2, title: \"System Requirements\", page: 5 }, { level: 1, title: Troubleshooting, page: 12 }] }",
    inputs: ["user-manual.pdf"],
    output: "output/user-manual-bookmarked.pdf",
    result: "Replaces the outline with a nested table of contents that jumps to the right pages.",
  },
  extract_bookmarks: {
    usage: "Exports the outline/bookmarks to a JSON file (`to`). Does not change the PDF.",
    example: "{ to: output/textbook-outline.json }",
    inputs: ["organic-chemistry-textbook.pdf"],
    output: "output/organic-chemistry-textbook.pdf",
    result: "Exports the textbook's chapter/section outline to a JSON file, leaving the PDF unchanged.",
  },
  extract_fields: {
    usage: "Exports form fields (page/name/type/value) to a CSV file (`to`). Does not change the PDF.",
    example: "{ to: output/w9-fields.csv }",
    inputs: ["tax-form-w9.pdf"],
    output: "output/tax-form-w9.pdf",
    result: "Writes every form field (page, name, type, value) from the W-9 to a CSV for review.",
  },
  extract_tables: {
    usage: "Detects tables and writes each to a CSV under the `to` directory. Does not change the PDF.",
    example: "{ to: output/statement-tables }",
    inputs: ["financial-statement-q4.pdf"],
    output: "output/financial-statement-q4.pdf",
    result: "Detects each table in the statement and writes it to its own CSV under output/statement-tables.",
  },

  // --- Text, image & Markdown extraction ---
  extract_text: {
    usage: "Extracts the PDF's text to a sidecar file (`to`). Does not change the PDF. Add `clean: true` to tidy the text: drop running headers/footers, rejoin hyphen-split words, and reflow hard-wrapped lines back into paragraphs (each pass can also be toggled on its own). `page_markers: true` labels each page.",
    example: "{ to: output/lease-text.txt, clean: true }",
    inputs: ["signed-lease-agreement.pdf"],
    output: "output/signed-lease-agreement.pdf",
    result: "Writes the full, cleaned-up text of the lease to output/lease-text.txt while leaving the PDF unchanged.",
  },
  semantic_search: {
    usage: "Finds passages by MEANING, not keywords — ask in plain language and get the matching passages back, ranked, with their page numbers. Embeds the document with a LOCAL model (nomic-embed-text via Ollama by default: `ollama pull nomic-embed-text`), so nothing leaves your machine — or use a **free NVIDIA cloud embedder** (`nvidia/nv-embed-v1` via `$PDFSTUDIO_EMBED_ENDPOINT` + `$NVIDIA_API_KEY`, see the AI-models guide in the Documentation panel). Needs the pdfStudio.allowAiRequests setting. Scanned PDF? Run `ocr` first.",
    example: '{ query: "the refund policy for late cancellations", top_k: 5, to: output/search-results.md }',
    inputs: ["terms-and-conditions.pdf"],
    output: "output/terms-and-conditions.pdf",
    result: "Writes the 5 passages closest in meaning to the query — each with its page number and score — to output/search-results.md, leaving the PDF unchanged.",
  },
  set_view_preferences: {
    usage: "Controls how the PDF OPENS in a reader (not its content): `page_layout` (e.g. TwoPageLeft for a book spread), `page_mode` (FullScreen for a kiosk/presentation, UseOutlines to reveal bookmarks), `open_page` + `zoom` (\"fit\"/\"fit-width\"/a percent), and window chrome (hide_toolbar/menubar, fit_window, center_window, display_doc_title).",
    example: "{ page_mode: FullScreen, page_layout: SinglePage, open_page: 1, zoom: fit }",
    inputs: ["slides.pdf"],
    output: "output/slides.pdf",
    result: "Saves a copy that opens full-screen at page 1, fit to the window — ready to present.",
  },
  recolor: {
    usage: "Recolors every page for comfortable reading. **`mode: dark`** (default) is a smart **dark mode** — it flips text and background to light-on-dark, but leaves embedded photos and logos looking normal (not a negative). `mode: invert` is a raw negative of everything; `mode: grayscale` drops color. Rasterizes at `dpi`, so the text becomes an image.",
    example: "{ mode: dark }",
    inputs: ["report.pdf"],
    output: "output/report-dark.pdf",
    result: "Turns the whole document into an easy-on-the-eyes dark mode — white-on-black text with the report's photos still in full color.",
  },
  convert_colors: {
    usage: "Converts the whole document's color space with Ghostscript — `mode`: gray (default, for cheap B&W printing), cmyk (for a commercial press), or rgb (for screen). Keeps text and vector art as vectors (unlike recolor, which rasterizes). Needs Ghostscript installed.",
    example: "{ mode: gray }",
    inputs: ["color-brochure.pdf"],
    output: "output/brochure-grayscale.pdf",
    result: "Converts the color brochure to true grayscale for black-and-white printing, keeping the text crisp and selectable.",
  },
  scanner_effect: {
    usage: "Makes a clean, born-digital PDF look like it was scanned — a slight page skew (alternating per page), softening, and grain. Rasterizes each page. Tune `skew`, `noise`, `grayscale`, `dpi`.",
    example: "{ grayscale: true, skew: 0.8 }",
    inputs: ["contract.pdf"],
    output: "output/contract-scanned.pdf",
    result: "Produces a copy that looks photocopied/scanned (skewed, softened, grainy, black-and-white).",
  },
  extract_js: {
    usage: "Surfaces any JavaScript embedded in the PDF (document-level Names tree and the open action) to a Markdown report at `to`. Read-only — it does not change the PDF. To strip JavaScript, use `sanitize`.",
    example: "{ to: output/javascript.md }",
    inputs: ["suspicious.pdf"],
    output: "output/suspicious.pdf",
    result: "Writes every embedded JavaScript block to output/javascript.md for inspection, leaving the PDF unchanged.",
  },
  flip_pages: {
    usage: "Mirrors pages — a true flip, not a rotation. `direction: horizontal` (default) mirrors left↔right; `vertical` mirrors top↕bottom. Omit `pages` to flip the whole document. Useful for scans fed through a duplex feeder backwards, or for iron-on/transfer prints.",
    example: "{ direction: horizontal, pages: [2, 4] }",
    inputs: ["scanned-booklet.pdf"],
    output: "output/scanned-booklet.pdf",
    result: "Mirrors pages 2 and 4 left-to-right, leaving the other pages untouched.",
  },
  extract_markdown: {
    usage: "Extracts page content as Markdown (tables included) to `to`. `engine`: auto/pymupdf4llm/markitdown for text-layer PDFs, or a vision-model OCR engine for scans — `marker` (Surya OCR + layout: best quality, slow, needs marker-pdf) or `paddleocr-vl` (Baidu's compact 0.9B doc parser: strong on tables/formulas, CPU-capable, runs in its own venv). `ocr`: off (text-layer only) / auto (default — OCR only pages with no text, keeping existing text) / force (re-OCR everything, lossy). `remote` (\"user@host\") offloads Marker to a GPU box over SSH; `endpoint` (URL) uses an HTTP Marker service instead (chunked + resumable) — both need pdfStudio.allowRemoteRender and send document bytes off-box. Tip: run `text_report` first — a PDF that already has text needs no OCR engine at all. Which engine to pick (speed/accuracy per engine): see the OCR performance report — https://github.com/LynxDI/pdf-studio/blob/main/docs/ocr-benchmark.md",
    example: "{ to: output/annual-report.md, engine: pymupdf4llm }",
    inputs: ["annual-report-2024.pdf"],
    output: "output/annual-report-2024.pdf",
    result: "Converts the report to clean Markdown (tables included) at output/annual-report.md, ready for LLM ingestion.",
  },
  extract_images: {
    usage:
      "Extracts every image **embedded in** the pages to files under the `to` directory — the photos and logos the document contains, at their original resolution. Does not change the PDF.\n\nFor a picture **of** each page instead (the whole rendered page as a PNG/JPG), use `pdf_to_png` / `render_pages`.",
    example: "{ to: output/catalog-images }",
    inputs: ["spring-catalog.pdf"],
    output: "output/spring-catalog.pdf",
    result: "Saves every embedded product photo from the catalog into the output/catalog-images/ directory.",
  },
  render_pages: {
    usage:
      "Renders pages to images under `to` — raster (`png`/`jpg`) at `dpi`, or `svg` for vector output (infinite zoom, tiny files, no DPI needed).\n\nThis makes a picture **of** the page. Two neighbours are easy to confuse: `extract_images` pulls out the images **embedded in** the page, and `rasterize` flattens the pages to images but still produces a **PDF**.\n\n`pdf_to_png` and `pdf_to_jpg` are the same operation with the format fixed — reach for those unless you need SVG or a runtime format choice.",
    example: "{ to: output/deck-thumbnails, dpi: 200, format: png }",
    inputs: ["investor-deck.pdf"],
    output: "output/investor-deck.pdf",
    result: "Rasterizes each slide to a 200-DPI PNG in output/deck-thumbnails/ for previews or thumbnails.",
  },
  pdf_to_png: {
    usage:
      "Converts the PDF to PNG images — one file per page — under `to` at `dpi`.\n\nPNG is lossless and supports transparency: set `transparent: true` to keep the page background clear instead of painting it white, which is what turns a page into an asset you can composite (a logo, a stamp, a signature block) rather than just a picture of a page.\n\nUse `pages` for a subset — a cover thumbnail is `pages: [1]`, not a 400-page render you then delete. This is a preset of `render_pages`; use that one for SVG.",
    example: "{ to: output/png, dpi: 300 }",
    inputs: ["contract.pdf"],
    output: "output/contract.pdf",
    result: "Writes one 300-DPI PNG per page into output/png/ — print-quality images of every page.",
    recipes: [
      {
        title: "Just the cover, as a thumbnail",
        description:
          "`pages` avoids rendering a whole document to get one image. 72 DPI is plenty for a web thumbnail; the default 150 is a reasonable screen resolution and 300 is print.",
        yaml: [
          "version: 1",
          "kind: pdf",
          "inputs:",
          "  - report.pdf",
          "operations:",
          "  - pdf_to_png: { pages: [1], dpi: 72, to: output/thumb }",
          "output:",
          "  file: output/report.pdf",
        ].join("\n"),
      },
      {
        title: "Transparent PNGs, named so they sort",
        description:
          "`transparent: true` drops the white background (PNG only — JPG has no alpha). The default names are `page_1.png … page_10.png`, which sort 10 before 2; `{i:03}` fixes that, and `{stem}` is the input's filename.",
        yaml: [
          "version: 1",
          "kind: pdf",
          "inputs:",
          "  - stamps.pdf",
          "operations:",
          "  - pdf_to_png:",
          "      transparent: true",
          "      dpi: 300",
          '      name: "{stem}-{i:03}"',
          "      to: output/assets",
          "output:",
          "  file: output/stamps.pdf",
        ].join("\n"),
      },
    ],
  },
  pdf_to_jpg: {
    usage:
      "Converts the PDF to JPG images — one file per page — under `to` at `dpi`.\n\nJPG is much smaller than PNG for photographic content and scans, at the cost of lossy compression and no transparency. For text-heavy pages, line art, or anything you will composite, prefer `pdf_to_png`.",
    example: "{ to: output/jpg, dpi: 150 }",
    inputs: ["photo-book.pdf"],
    output: "output/photo-book.pdf",
    result: "Writes one 150-DPI JPG per page into output/jpg/ — compact images suited to photographic pages.",
  },
  replace_text: {
    usage:
      "Finds text and replaces it IN PLACE — the workflow-shaped answer to \"edit the PDF\": re-date a template, fix a recurring typo, swap an entity name across a whole folder (put a glob in `inputs` and it batches). The matched text is truly deleted, and the replacement lands on the original baseline in the original size and color. Matching is per LINE (text that wraps won't match). `find` is **literal by default**, or a **regular expression** with `regex: true` — e.g. `find: \"\\\\d{2}/\\\\d{2}/\\\\d{4}\"` to re-date, `find: \"Order #\\\\d+\"` to mask IDs — and the `replace` string may then reference capture groups (`\\\\1`, `\\g<name>`). `ignore_case` refines matching, `whole_word` restricts literal matches to whole words (ignored in regex mode — put `\\b` in the pattern), `pages` restricts pages, and `replace: \"\"` deletes the match. **Font honesty:** an embedded, subsetted original font can't render NEW glyphs, so by default the replacement uses the closest base-14 font (serif→Times, mono→Courier, else Helvetica, keeping bold/italic). To match the document's typography exactly, pass **`font_file`** — a workflow-relative `.ttf`/`.otf` (e.g. `assets/DejaVuSans.ttf`) that gets EMBEDDED for the replacement, overriding the base-14 fallback. Run `preview: true` first for a report of every match with nothing changed.",
    example: "{ find: \"ACME Corp\", replace: \"Initech LLC\" }",
    inputs: ["contracts/master-services-agreement.pdf"],
    output: "output/msa-renamed.pdf",
    result: "Replaces every in-line occurrence of \"ACME Corp\" with \"Initech LLC\", keeping each match's position, size and color; the render note reports the count and warns if a replacement is wider than what it replaced.",
  },
  replace_image: {
    usage: "Replaces an embedded image. `selector` picks the target ({ page, object_name }); `image` is the replacement path.",
    example: "{ selector: { page: 1, object_name: Im0 }, image: assets/new-logo.png }",
    inputs: ["company-brochure.pdf"],
    output: "output/brochure-rebranded.pdf",
    result: "Swaps the old logo (image Im0 on page 1) for assets/new-logo.png, producing a rebranded brochure.",
  },

  // --- Redaction & cleanup ---
  redact: {
    usage: "Permanently removes content in rectangles on a page. `rects` are [x, y, w, h] in points. Add `rasterize: true` to also flatten the WHOLE document to an image-only PDF afterward, so nothing hidden (text layer, metadata, off-page content) can survive — the safest way to share.",
    example: "{ page: 2, rects: [[72, 688, 250, 26], [72, 650, 210, 26]], rasterize: true }",
    inputs: ["bank-statement.pdf"],
    output: "output/bank-statement-redacted.pdf",
    result: "Permanently deletes two rectangular regions on page 2 (the customer name and SSN block) and flattens the file to an image-only PDF, so nothing can be recovered.",
  },
  auto_redact: {
    usage:
      "Finds and permanently redacts matches across all pages. Match by literal `text` (a list), by named PII `patterns` (ssn, email, phone, credit_card, ein, ipv4, iban), and/or by custom `regex`. Literal matching is case-sensitive by default — add `ignore_case: true`, or `whole_word: true` so \"Ann\" doesn't hit \"Anniversary\". The run note reports any rule that found nothing, so verify. Add `rasterize: true` to also flatten the document to an image-only PDF so nothing hidden (text layer, metadata, off-page content) survives — the safest way to share.\n\n" +
      "**Preview first (recommended for redaction):** set `preview: true` for a dry run — it writes `output/redaction-preview.md` listing every match (page + matched text + which rule) and applies NOTHING. Review it, then remove `preview` to apply for real.\n\n" +
      "**Prompt example** — you don't have to write the YAML; just tell your coding agent in plain English, e.g.:\n" +
      "> \"Create a workflow to redact my name (Jane Whitfield), account number 123456789, my email and any SSNs from statement.pdf, and give me a version that's safe to share.\"\n\n" +
      "The agent then creates a `.opw.yaml` with `auto_redact` — your EXACT values in `text`, `patterns: [email, ssn]` for the shape-based ones, `rasterize: true` (because \"safe to share\" = flatten to an image), `output.file` at a new path — runs `opw_validate`, and renders it.",
    example: "{ text: [\"Jane Whitfield\", \"123456789\"], patterns: [\"email\", \"ssn\"], ignore_case: true, rasterize: true }",
    inputs: ["statement.pdf"],
    output: "output/statement-redacted.pdf",
    result: "Permanently blacks out the name and account number, every email and SSN by pattern, then flattens to an image-only PDF that's safe to share (nothing hidden can be recovered).",
  },
  sanitize: {
    usage: "Strips JavaScript, embedded files, metadata, and links from the PDF. No params.",
    example: "{}",
    inputs: ["downloaded-form.pdf"],
    output: "output/downloaded-form-sanitized.pdf",
    result: "Strips embedded JavaScript, attached files, metadata, and links, producing a safe-to-share PDF.",
  },
  remove_annotations: {
    usage: "Removes all annotations (comments, highlights, link markup). No params.",
    example: "{}",
    inputs: ["reviewed-manuscript.pdf"],
    output: "output/manuscript-clean.pdf",
    result: "Removes all reviewer comments, highlights, and link markup, leaving only the underlying page content.",
  },
  remove_images: {
    usage: "Removes all images from the document. No params.",
    example: "{}",
    inputs: ["photo-heavy-report.pdf"],
    output: "output/report-text-only.pdf",
    result: "Drops every embedded image, yielding a lightweight text-only version of the report.",
  },
  remove_blank_pages: {
    usage: "Detects and deletes blank pages (no text, no images, near-white). No params.",
    example: "{}",
    inputs: ["scanned-batch.pdf"],
    output: "output/scanned-batch-trimmed.pdf",
    result: "Detects and deletes the empty separator pages left by the scanner, keeping only pages with real content.",
  },
  ocr: {
    usage: "Adds a searchable text layer to scanned pages via OCR (Tesseract). `language` is a Tesseract code, default eng (\"eng+hin\" for multiple) — it is preflighted against installed tessdata and fails clearly if missing. `mode`: skip-text (default, OCRs only text-less pages), redo-ocr (re-recognize), force-ocr (rasterize + OCR all, lossy). `output_type: pdfa` for archival PDF/A. `page_range` (\"1-3,7\") limits which pages. A damaged source whose OCR output ocrmypdf rejects is auto-repaired with pikepdf. This is the Tesseract engine and it outputs a SEARCHABLE PDF. For other OCR jobs use a different op: **`extract_markdown`** turns a scan into Markdown with `engine: marker` (Surya OCR + layout) or `engine: paddleocr-vl` (Baidu's compact 0.9B doc VLM — CPU-capable); **`extract_receipt`** pulls typed fields from receipts/invoices with a vision model (Qwen3-VL). Always run `text_report` first — don't re-OCR a doc that already has a good text layer. Engine speed/accuracy comparison: the OCR performance report — https://github.com/LynxDI/pdf-studio/blob/main/docs/ocr-benchmark.md",
    example: "{ mode: redo-ocr, language: \"eng+hin\" }",
    inputs: ["scanned-contract.pdf"],
    output: "output/searchable-contract.pdf",
    result: "Re-OCRs the scanned pages with English+Hindi, replacing any poor prior OCR with a fresh searchable text layer.",
  },

  // --- Forms ---
  fill_field: {
    usage: "Sets an AcroForm field's value. `field` is the field name, `value` the text to set.",
    example: "{ field: \"policyholder_name\", value: \"Marcus Webb\" }",
    inputs: ["auto-claim-form.pdf"],
    output: "output/auto-claim-filled.pdf",
    result: "Sets the AcroForm field 'policyholder_name' to 'Marcus Webb', producing a completed auto-insurance claim form.",
  },
  create_form: {
    usage:
      "Turns a template into a FILLABLE PDF. Type a marker where each field belongs, run a conversion op (`office_to_pdf` / `markdown_to_pdf` / `html_to_pdf`) to render the layout, and create_form finds each marker, DELETES it, and puts a real AcroForm field in its place — so it works with any source that leaves a text layer. **The easy way: use the TYPE as the tag** — `[[text]]`, `[[check]]`, `[[date]]`, `[[sign]]` — as many times as you like; they're numbered in reading order (text_01, checkbox_01, checkbox_02…), so there's nothing to name and no config file. Fields fill their table cell automatically and get a visible border. Use a NAMED tag (`[[employee_name]]`) when you want a meaningful field name; add a `fields_file` YAML keyed by tag for types/tooltips/choices/widths. Either way the tag key BECOMES the PDF field name, so you can fill it with `fill_form: { fields: { text_01: \"Jane\" } }` and read it back with `extract_form` — no form pack needed. **Keep tags short:** a marker too long for its column wraps or gets clipped by the renderer, and create_form then FAILS the run rather than ship a form with a missing field and a mangled `[[emplo` on the page (in a narrow cell, set the marker's font small in Word — it's deleted anyway). `preview: true` dry-runs it; `debug: true` writes a copy with every field outlined.",
    example: "{ debug: true }",
    inputs: ["onboarding.docx"],
    before: ["office_to_pdf: {}"],
    output: "output/onboarding-fillable.pdf",
    result: "Converts the Word template and turns every [[check]]/[[text]] marker into a real form field sized to its table cell, writing output/form-map.json (each field with its page and rect) plus an outlined debug copy.",
  },
  fill_form: {
    usage:
      "Fills a known PDF form from your records — no need to know the raw field names. `form` is a supported id (ds11, f1040, … — see the `form_list` MCP tool or the PDF Fill catalog); `people` points at your people.yaml and `person` chooses whose info fills the primary role. The form pack maps friendly keys → the form's real fields, handling checkboxes, radio groups, split SSN/date boxes, and dropdowns. `roles` binds relatives (spouse/parents) for forms that need them; `values` sets form-specific fields (e.g. applying_for). `signature: { image, field }` stamps a signature and `flatten: true` bakes a locked, print-ready final. **Run once with `preview: true`** for a dry-run report of exactly what will be filled. (Advanced: omit `form` and pass raw `fields: { RealFieldName: value }` to fill any AcroForm directly.)",
    example: "{ form: ds11, people: people.yaml, person: me }",
    inputs: ["ds11.pdf"],
    output: "output/ds11-filled.pdf",
    result: "Fills the DS-11 passport application from the 'me' record — name, date of birth, SSN split across the three boxes, sex, and the parents pulled in via `relations` — leaving it editable for review.",
  },
  extract_form: {
    usage:
      "Reads filled forms back OUT to data — the inverse of `fill_form`. Because a form pack maps friendly keys to real fields, the same pack that fills a form reads one back, so every supported form is extractable with no extra setup. Point `inputs` at one PDF or a whole folder (`forms/*.pdf` — all matches fold into ONE table, they aren't batched). Each PDF is auto-identified by its field signature (pass `form:` to force one). Writes per-form `<stem>.json`, a combined `forms.json`, and **one CSV per form type** (`w9.csv`, `f1040.csv` — different forms have unrelated schemas, so they never share a table) into `to`; `format: json`/`csv` narrows it. A CSV's columns come from the form pack, in the form's own field order, so the header is stable across runs no matter which files are present or what a form left blank. **Re-runs are incremental**: `forms.json` doubles as a ledger keyed by content hash, so running again after dropping new files in extracts only what's new or changed and merges it into the table (`resume: false` re-reads everything). A PDF that matches NO pack — anything you built with `create_form` — is read **raw**: field name → value, into `raw.csv`. That's what closes the loop (template → fillable → filled → CSV) with nothing to author. Note a flattened PDF has no fields left to read.",
    example: "{ to: output/extracted }",
    inputs: ["forms/*.pdf"],
    noOutput: true,
    result: "Identifies each filled form, maps its fields back to friendly keys, and writes one JSON per form, a combined forms.json, and one CSV per form type for a downstream system to ingest. Run it again after adding more forms and only the new ones are read.",
  },
  extract_receipt: {
    usage:
      "Reads receipts/invoices as IMAGES with a vision-language model (Qwen3-VL) and extracts structured fields — merchant, date, currency, subtotal, tax, tip, total, receipt number, and line items — to JSON + CSV. Unlike `extract_form` (which reads AcroForm fields) this works on scans/photos with no text layer. Each page is rasterized (`dpi`, default 200) and sent to an OpenAI-compatible endpoint (`endpoint`, e.g. a vLLM server; defaults to $PDFSTUDIO_VLM_ENDPOINT), so it needs the **pdfStudio.allowRemoteRender** setting (page-image bytes go to the model server). No GPU? Point `endpoint` at a **free NVIDIA cloud vision model** (`meta/llama-3.2-90b-vision-instruct` + `$NVIDIA_API_KEY`) — see the AI-models guide in the Documentation panel. Point `inputs` at one PDF or a whole folder (`receipts/*.pdf` — all matches fold into ONE table). Writes per-input `<stem>.json`, a combined `receipts.json`, and a flattened `receipts.csv` (one row per line item) into `to`; `format: json`/`csv` narrows it, `schema: invoice` adds invoice fields, `line_items: false` keeps only totals. **Re-runs are incremental**: `receipts.json` doubles as a ledger keyed by content hash, so an unchanged file is skipped with no model calls (`resume: false` re-reads everything).",
    example: "{ endpoint: \"http://localhost:11434/v1\", model: qwen3-vl-8b }",
    inputs: ["receipts/*.pdf"],
    noOutput: true,
    result: "Reads each receipt image with the vision model and writes one JSON per input, a combined receipts.json, and a receipts.csv of merchant/date/totals/tax + line items for a downstream system (expenses, bookkeeping) to ingest. Re-run after adding more receipts and only the new ones cost a model call.",
  },
  flatten: {
    usage: "Bakes form fields + annotations into static page content (no longer editable). No params.",
    example: "{}",
    inputs: ["lease-agreement-filled.pdf"],
    output: "output/lease-agreement-final.pdf",
    result: "Bakes the filled form fields and annotations into static page content so the signed lease can no longer be edited.",
  },
  unlock_forms: {
    usage: "Clears the read-only flag on form fields so they can be filled. No params.",
    example: "{}",
    inputs: ["irs-w9-locked.pdf"],
    output: "output/irs-w9-fillable.pdf",
    result: "Clears the read-only flag on every form field so the locked W-9 can be filled in.",
  },

  // --- Attachments ---
  extract_attachments: {
    usage: "Extracts embedded file attachments to the `to` directory. Does not change the PDF.",
    example: "{ to: output/invoice-attachments }",
    inputs: ["zugferd-invoice-2024.pdf"],
    output: "output/zugferd-invoice-2024.pdf",
    result: "Pulls every embedded file (e.g. the ZUGFeRD line-item XML) out of zugferd-invoice-2024.pdf into output/invoice-attachments/, leaving the PDF itself unchanged.",
  },
  extract_links: {
    usage:
      "Pulls every hyperlink out of a PDF (or a whole folder) to JSON + CSV — clickable link annotations (the URL, its page, and the anchor text) plus, by default, bare URLs printed in the text that were never linked. Point `inputs` at one file or a glob (`docs/*.pdf` — all matches fold into ONE table with a `file` column, they aren't batched). `types` picks which kinds to keep (default `[uri]` = external web/mailto; add `goto` for internal jumps, or `all`); `include_text_urls: false` limits it to real link annotations; `dedupe: true` collapses to a unique URL list. Read-only — the PDF is unchanged.",
    example: "{ to: output/links }",
    inputs: ["research-papers/*.pdf"],
    noOutput: true,
    result: "Scans every PDF in research-papers/ and writes one links.json and links.csv to output/links/ — each row a URL with the file and page it came from — leaving the PDFs unchanged.",
  },
  extract_annotations: {
    usage:
      "Exports every markup/comment annotation (sticky notes, highlights, underlines, strikeouts, free text, shapes, ink, stamps) to `to`/annotations.json + annotations.csv — one row per annotation with author, comment, the text a markup covers, color, page and rect. Point `inputs` at one PDF or a folder (docs/*.pdf → one combined table). `types` filters kinds; `format` picks json/csv. Read-only.",
    example: "{ to: output/annotations }",
    inputs: ["reviewed-drafts/*.pdf"],
    noOutput: true,
    result: "Scans every PDF in reviewed-drafts/ and writes one annotations.json and annotations.csv to output/annotations/ — each row a comment/highlight with its author, page and covered text — leaving the PDFs unchanged.",
  },
  add_links: {
    usage: "Makes URLs clickable and adds explicit links — the inverse of extract_links. With `auto` (default true) it finds bare URLs printed in the page text and lays a URI link over each. `links` adds explicit links by text search: `find` a phrase and point it at a `url` (external) or `goto` (1-based page). Modifies the PDF.",
    example: "{ auto: true }",
    inputs: ["research-paper.pdf"],
    output: "output/research-paper-linked.pdf",
    result: "Detects every bare URL printed in the paper's text and makes it a clickable link, writing the linked PDF.",
  },
  add_attachments: {
    usage: "Embeds a file as an attachment. `file` is a workflow-relative path; `name` defaults to its basename.",
    example: "{ file: assets/line-items-2024.xlsx, name: line-items-2024.xlsx }",
    inputs: ["invoice-2024.pdf"],
    output: "output/invoice-2024-with-source.pdf",
    result: "Embeds the source spreadsheet assets/line-items-2024.xlsx into invoice-2024.pdf as an attachment named line-items-2024.xlsx so recipients get the raw data alongside the invoice.",
  },

  // --- Encryption & permissions ---
  encrypt: {
    usage: "Password-protects the PDF (AES-256). Set `user_password` (to open) and/or `owner_password`. Put it last. Use ${ENV} to keep secrets out of the file.",
    example: "{ user_password: \"${PDF_OPEN_PASSWORD}\", owner_password: \"${PDF_OWNER_PASSWORD}\" }",
    inputs: ["board-minutes-2024-q4.pdf"],
    output: "output/board-minutes-2024-q4-encrypted.pdf",
    result: "Locks the Q4 board minutes with AES-256, requiring an open password to view and a separate owner password to change permissions.",
  },
  decrypt: {
    usage: "Removes password protection — supply the current `password`. Put it first so later ops can read the PDF.",
    example: "{ password: \"${PDF_PASSWORD}\" }",
    inputs: ["locked-bank-statement.pdf"],
    output: "output/bank-statement-unlocked.pdf",
    result: "Removes the open-password protection from the bank statement so readers and downstream operations can access it.",
  },
  set_permissions: {
    usage: "Restricts what viewers can do via an `owner_password`. `allow` toggles print/copy/modify/annotate/fill_form/assemble.",
    example: "{ owner_password: \"${PDF_OWNER_PASSWORD}\", allow: { print: true, copy: false, modify: false, annotate: false } }",
    inputs: ["employee-handbook.pdf"],
    output: "output/employee-handbook-protected.pdf",
    result: "Applies an owner-password policy to the handbook so viewers may print it but cannot copy text, edit, or annotate.",
  },

  // --- Optimize, repair & archival ---
  compress: {
    usage:
      "Reduces file size. Deep image compression kicks in when Ghostscript or qpdf is installed; the bundled engine can only re-save structurally.\n\nTwo ways to ask. **`quality` 1-100** picks a fixed setting. **`max_size`** states the outcome instead — it walks a quality ladder (prepress → printer → ebook → screen → explicit low-DPI passes) and stops at the **best setting that fits**, so you get the highest quality that satisfies the constraint rather than the most aggressive one available. `quality` acts as the ceiling: `max_size` never uses a better setting than you asked for.\n\nEvery candidate is validated (it must still load and keep its page count) and the result is never larger than the input. If the target is unreachable you get the smallest valid version **plus a note with both numbers** — not a failure, because the smaller file is still wanted and only you can decide whether to rasterize or split.",
    example: "{ quality: 60 }",
    inputs: ["scanned-brochure.pdf"],
    output: "output/brochure-compressed.pdf",
    result: "Shrinks a large scanned brochure by recompressing its embedded images at 60% quality, producing a much smaller PDF.",
    recipes: [
      {
        title: "Get under an email or upload limit",
        description:
          "State the limit and let the ladder find the best quality that meets it. Give a unit — `\"9MB\"` is 9,000,000 and `\"9MiB\"` is 9,437,184 — and leave headroom for whatever the receiving system counts.",
        yaml: [
          "version: 1",
          "kind: pdf",
          "inputs:",
          "  - proposal.pdf",
          "operations:",
          '  - compress: { max_size: "9MB" }',
          "output:",
          "  file: output/proposal-small.pdf",
        ].join("\n"),
      },
      {
        title: "Compress first, then split what's left",
        description:
          "The two size constraints compose: shrink the document as far as quality allows, then break the remainder into parts that each fit. This is the answer when one file has to become several uploads. Note `compress` must come first — the engine will not reorder it past `split`, because split's parts are the real output.",
        yaml: [
          "version: 1",
          "kind: pdf",
          "inputs:",
          "  - application.pdf",
          "operations:",
          '  - compress: { max_size: "4.5MB" }',
          '  - split: { max_size: "4.8MB", name: "part-{i:02}" }',
          "output:",
          "  folder: output/parts",
        ].join("\n"),
      },
    ],
  },
  linearize: {
    usage: "\"Fast web view\" — reorders the PDF for progressive loading. Put it last. No params.",
    example: "{}",
    inputs: ["annual-report-2024.pdf"],
    output: "output/annual-report-web.pdf",
    result: "Reorders the annual report for \"fast web view\" so a browser can render the first page before the whole file finishes downloading.",
  },
  repair: {
    usage: "Repairs / rewrites a structurally-messy PDF. No params.",
    example: "{}",
    inputs: ["corrupted-scan.pdf"],
    output: "output/repaired-scan.pdf",
    result: "Rewrites a structurally-broken scan with a rebuilt cross-reference table into a clean, openable PDF.",
  },
  decompress: {
    usage: "Uncompresses content streams to produce a readable/debuggable PDF. No params.",
    example: "{}",
    inputs: ["invoice-2024.pdf"],
    output: "output/invoice-uncompressed.pdf",
    result: "Uncompresses the invoice's content streams so the raw PDF operators are human-readable for inspection and debugging.",
  },
  rasterize: {
    usage: "Flattens every page to a raster image (non-editable, non-selectable output) at `dpi`.",
    example: "{ dpi: 200 }",
    inputs: ["signed-contract.pdf"],
    output: "output/contract-flattened.pdf",
    result: "Flattens every page of the signed contract to a 200-DPI image so its text can no longer be selected, copied, or edited.",
  },
  pdf_to_pdfa: {
    usage: "Converts to PDF/A for long-term archival. No params.",
    example: "{}",
    inputs: ["board-minutes.pdf"],
    output: "output/board-minutes-pdfa.pdf",
    result: "Converts the board minutes to PDF/A, embedding fonts and color profiles for compliant long-term archival.",
  },

  // --- Convert to PDF ---
  images_to_pdf: {
    usage: "Builds a PDF from image inputs — set the workflow's `inputs` to image files (one page each). PNG/JPEG work with the bundled engine; PNG/JPEG/WEBP/TIFF/GIF/BMP/SVG (and HEIC/HEIF with the `pillow-heif` package) work when the Python backend is installed. No params.",
    example: "{}",
    inputs: ["scans/receipt-front.jpg","photos/warranty.heic","logo.svg"],
    output: "output/expense-receipts.pdf",
    result: "Bundles the images into a single PDF, one image per page in listed order.",
  },
  html_to_pdf: {
    usage: "Renders an HTML file to PDF — set the workflow's input to a .html file. `engine` auto-picks a system Chrome/Edge (best fidelity), then WeasyPrint, then the built-in engine.",
    example: "{ engine: chrome }",
    inputs: ["invoice-2024-041.html"],
    output: "output/invoice-2024-041.pdf",
    result: "Renders the styled HTML invoice to a pixel-faithful PDF using the system Chrome/Edge engine.",
  },
  markdown_to_pdf: {
    usage: "Renders a Markdown file to a styled PDF — set the workflow's input to a .md file. `engine` auto-picks a system Chrome/Edge for the best result (no bundled browser); force `story` for a zero-dependency render.",
    example: "{ engine: chrome }",
    inputs: ["quarterly-report.md"],
    output: "output/quarterly-report.pdf",
    result: "Turns the Markdown report (headings, tables, code blocks) into a themed PDF via system Chrome.",
  },
  url_to_pdf: {
    usage: "Fetches a web page and renders it to PDF using a system Chrome/Edge when present. Needs no input file: use `inputs: []` and pass the `url`.",
    example: "{ url: \"https://en.wikipedia.org/wiki/Portable_Document_Format\", engine: chrome }",
    inputs: [],
    output: "output/pdf-wikipedia-snapshot.pdf",
    result: "Fetches the live Wikipedia article and renders a full-page PDF snapshot with the Chrome engine.",
  },
  eml_to_pdf: {
    usage: "Renders an .eml email (headers + body) to a styled PDF — set the workflow's input to the .eml file.",
    example: "{ engine: auto }",
    inputs: ["mailbox/customer-complaint.eml"],
    output: "output/customer-complaint.pdf",
    result: "Renders the saved email — From/To/Subject/Date headers plus the message body — to a tidy styled PDF.",
  },
  video_to_pdf: {
    usage:
      "Samples a video every `every` seconds and writes **one page per frame**, with the source time burned into the corner. Requires **ffmpeg** — the Dependencies view has the install command.\n\nIt deliberately doesn't build a grid: `n_up` already does that, so a contact sheet is two lines and every other page operation (`header_footer`, `add_page_numbers`, `title_page`) composes for free.\n\n`max_frames` (default 200) is a guard, not a preference — a three-hour recording at `every: 1` would otherwise produce ten thousand pages.",
    example: "{ every: 30 }",
    inputs: ["lecture.mp4"],
    output: "output/lecture-frames.pdf",
    result: "Samples the recording every 30 seconds, one timestamped frame per page.",
    recipes: [
      {
        title: "A reviewable contact sheet",
        description:
          "One frame per page becomes a grid via `n_up`, then gets numbered like any other document. Useful for lecture recordings, site-survey footage, UI walkthroughs and security review.",
        yaml: [
          "version: 1",
          "kind: pdf",
          "inputs:",
          "  - lecture.mp4",
          "operations:",
          "  - video_to_pdf: { every: 30 }",
          "  - n_up: { cols: 3, rows: 4 }",
          "  - add_page_numbers: { position: bottom-center }",
          "output:",
          "  file: output/lecture-contact-sheet.pdf",
        ].join("\n"),
      },
      {
        title: "A short clip, densely sampled",
        description:
          "For a 30-second UI recording, sample every second and keep the frames full-page so the detail survives. Raise `max_frames` only when you mean it.",
        yaml: [
          "version: 1",
          "kind: pdf",
          "inputs:",
          "  - bug-repro.mov",
          "operations:",
          "  - video_to_pdf: { every: 1, width: 1600, max_frames: 60 }",
          '  - title_page: { title: "Bug 4821 — repro", subtitle: "screen recording, 1 fps" }',
          "output:",
          "  file: output/bug-4821.pdf",
        ].join("\n"),
      },
    ],
  },
  office_to_pdf: {
    usage:
      "Converts an Office document to PDF — set the input to a docx/xlsx/pptx/odt file and set `from` to its format. One slide (or page/sheet) becomes one PDF page, preserving layout and fonts.\n\nRequires **LibreOffice**, which does the conversion locally — nothing is uploaded. The Dependencies view detects it and offers the install command for your platform. This op must be the **first** operation in the workflow, since it is what produces the PDF everything else edits.\n\nTo convert a whole folder, put a glob in `inputs` (`decks/*.pptx`). On its own that runs the workflow once per deck — one PDF each. Add `merge` and the decks are instead converted individually and then folded into a **single** PDF, in sorted filename order. See the recipes below.",
    example: "{ from: pptx }",
    inputs: ["decks/investor-pitch.pptx"],
    output: "output/investor-pitch.pdf",
    result: "Converts the PowerPoint deck to a PDF, one slide per page, preserving layout and fonts.",
    recipes: [
      {
        title: "Every deck in a folder → its own PDF",
        description:
          "A glob runs the whole workflow once per matched file. `{stem}` is the input filename without its extension, so `01-intro.pptx` → `output/01-intro.pdf`. Use `output: { folder: output }` if you don't need to control the name.",
        yaml: [
          "version: 1",
          "kind: pdf",
          "inputs:",
          "  - decks/*.pptx",
          "operations:",
          "  - office_to_pdf: { from: pptx }",
          "output:",
          "  file: output/{stem}.pdf",
        ].join("\n"),
      },
      {
        title: "Every deck in a folder → ONE merged PDF",
        description:
          "`merge` reads all the inputs together, so the glob feeds a single run instead of one run per file — each deck is converted first, then stacked in sorted filename order (name them 01-, 02-, 03- to control it). The whole course as one file.",
        yaml: [
          "version: 1",
          "kind: pdf",
          "inputs:",
          "  - decks/*.pptx",
          "operations:",
          "  - office_to_pdf: { from: pptx }",
          "  - merge: {}",
          "output:",
          "  file: output/course.pdf",
        ].join("\n"),
      },
      {
        title: "A folder of decks → printable handouts",
        description:
          "The same fold, then four slides to a sheet with page numbers — the usual way lecture slides get printed for students.",
        yaml: [
          "version: 1",
          "kind: pdf",
          "inputs:",
          "  - decks/*.pptx",
          "operations:",
          "  - office_to_pdf: { from: pptx }",
          "  - merge: {}",
          "  - n_up: { cols: 2, rows: 2 }",
          "  - add_page_numbers: { position: bottom-center }",
          "output:",
          "  file: output/handouts.pdf",
        ].join("\n"),
      },
    ],
  },

  // --- Convert from PDF ---
  pdf_to_docx: {
    usage: "Converts the PDF to a Word document written to `to`. Fidelity varies (LibreOffice).",
    example: "{ to: output/board-minutes-2024.docx }",
    inputs: ["board-minutes-2024.pdf"],
    output: "output/board-minutes-2024.docx",
    result: "Produces an editable Word version of the board minutes so text and formatting can be revised.",
  },
  pdf_to_pptx: {
    usage: "Converts the PDF to a PowerPoint file written to `to`. Fidelity varies (LibreOffice).",
    example: "{ to: output/investor-deck.pptx }",
    inputs: ["investor-deck.pdf"],
    output: "output/investor-deck.pptx",
    result: "Turns each PDF page of the investor deck into an editable PowerPoint slide.",
  },
  pdf_to_xlsx: {
    usage: "Converts the PDF to an Excel file written to `to`. Fidelity varies (LibreOffice).",
    example: "{ to: output/expense-report-2024.xlsx }",
    inputs: ["expense-report-2024.pdf"],
    output: "output/expense-report-2024.xlsx",
    result: "Extracts the expense report's tabular data into an editable Excel workbook.",
  },

  // --- Digital signatures ---
  sign: {
    usage: "Digitally signs the PDF with a PKCS#12 certificate. `cert` is a .p12/.pfx path; use ${ENV} for the `password`.",
    example: "{ cert: assets/acme-legal.p12, password: \"${CERT_PASSWORD}\", field: Signature1, reason: \"Approved by Legal\" }",
    inputs: ["contracts/master-service-agreement.pdf"],
    output: "output/signed-master-service-agreement.pdf",
    result: "Digitally signs the agreement with the ACME PKCS#12 certificate, embedding a verifiable signature in the Signature1 field with the reason \"Approved by Legal\".",
  },
  validate_signature: {
    usage: "Validates the PDF's digital signatures and writes a JSON report to `to`. Does not change the PDF.",
    example: "{ to: output/signature-report.json }",
    inputs: ["signed-master-service-agreement.pdf"],
    output: "output/signed-master-service-agreement.pdf",
    result: "Checks every digital signature in the signed agreement and writes a JSON report of each signer, validity status, and signing time to signature-report.json (the PDF passes through unchanged).",
  },
  timestamp: {
    usage: "Adds an RFC-3161 trusted timestamp from a TSA. `tsa_url` is the timestamp server (needs network).",
    example: "{ tsa_url: \"http://timestamp.digicert.com\" }",
    inputs: ["signed-invoice-2024.pdf"],
    output: "output/timestamped-invoice-2024.pdf",
    result: "Adds an RFC-3161 trusted timestamp from DigiCert's TSA, cryptographically proving the signed invoice existed and was unaltered as of that moment.",
  },
  pdf_info: {
    usage: "Writes a read-only report of the PDF — page count, per-page size/rotation, metadata, encryption, fonts, image/field/annotation counts, plus text coverage (pages_with_text, per-page chars, image-only page count, and a needs_ocr flag) — as JSON to `to`. Leaves the PDF unchanged. For the full per-page OCR-candidate breakdown, use `text_report`.",
    example: "{ to: output/report-info.json }",
    inputs: ["quarterly-report.pdf"],
    noOutput: true,
    result: "Writes a structured JSON report of the quarterly report (pages, dimensions, metadata, fonts, security, text coverage) for inspection or CI. A pure diagnostic: it writes only the report, so the workflow needs no output block.",
  },
  check_accessibility: {
    usage: "Audits the PDF for accessibility (PDF/UA, Section 508, WCAG) and writes a pass/warn/fail report to `to` — checks for a document title, a default language, a tag tree (StructTreeRoot), that the reader shows the title not the filename, image alt text, and form-field tooltips. `format` is json (default), markdown, or both. Read-only; each finding names the op that fixes it.",
    example: "{ to: output/accessibility.json, format: both }",
    inputs: ["public-report.pdf"],
    noOutput: true,
    result: "Writes output/accessibility.json (+ accessibility.md) grading the report against PDF/UA checks — title, language, tagging, alt text, tooltips — with a pass/warn/fail per check. A pure diagnostic: it writes only the report, so the workflow needs no output block.",
  },
  tag_pdf: {
    usage:
      "Auto-tags an untagged PDF so screen readers can navigate it — the fix for check_accessibility's \"untagged\" fail. It builds a **real** structure tree (StructTreeRoot) with reading-order marked content: text blocks become headings (**H1–H3**, level inferred from font size relative to the document's body size) and paragraphs (**P**); image XObjects become tagged **Figure**s carrying `/Alt` — and it sets MarkInfo/Marked so the tags count. `alt` supplies figure descriptions in reading order (`[\"Bar chart of Q3 revenue\", …]`); a figure with none gets a neutral placeholder and is reported as still needing real alt text. `lang` (e.g. \"en-US\") sets /Lang and `title` sets the document title + DisplayDocTitle, so one pass can clear the title/language/title-shown checks too. **Idempotent**: an already-tagged PDF is left untouched unless `force: true` (which strips the old structure and rebuilds). Best on text documents with a single-column reading order; **scanned/image-only PDFs should be `ocr`'d first** (otherwise a page is just one big Figure), and complex tables/lists are flattened to paragraphs. Needs the Python backend.",
    example: '{ lang: "en-US", title: "Q3 Report", alt: ["Bar chart of quarterly revenue"] }',
    inputs: ["untagged-report.pdf"],
    output: "output/tagged.pdf",
    result: "Writes output/tagged.pdf with a real StructTreeRoot (headings/paragraphs/figures in reading order), MarkInfo/Marked set, /Lang=en-US, a document title with DisplayDocTitle, and alt text on the figure — flipping check_accessibility's tagged/title/language checks from fail to pass.",
  },
  text_report: {
    usage:
      "Read-only diagnostic that answers \"does this PDF need OCR, and where?\" — **page stats plus a recommendation**. Writes to `to`: doc-level coverage (`text_coverage_pct`, `pages_with_text`, `total_text_chars`, `avg_images_per_page`, the scripts present e.g. devanagari, a conservative `needs_ocr`, `damaged_streams`), the page lists that matter (`image_only_pages` = real OCR candidates, `empty_pages`, `oversized_pages`), a per-page stats array (`page`, `w`/`h` in points, `chars`, `images`, `class`: text | image_only | empty), and — the actionable part — `recommendation` (text-complete | mixed | image-only | blank) with a runnable `recommended_workflow`. `format: markdown`/`both` also writes a one-screen human summary (metrics table, suggested workflow, page-stats table) beside the JSON. `detail: summary` drops the per-page array, and `sample: 50` analyzes every 50th page for a fast estimate on a huge document. `min_image_px` / `oversize_pt` tune the classifier. Run it BEFORE ocr/extract_* so you OCR only the image-only pages — or skip OCR when a text layer already exists (re-OCR'ing a good text layer degrades it).",
    example: "{ to: output/coverage.json, format: both }",
    inputs: ["mixed-scanned-and-digital.pdf"],
    noOutput: true,
    result: "Writes output/coverage.json (+ coverage.md) with per-page stats and coverage — which pages have a text layer vs need OCR (needs_ocr, image_only_pages, oversized_pages, scripts) — and a recommendation plus the workflow to author for it. A pure diagnostic: it writes only the report, so the workflow needs no output block.",
  },
  inspect_text: {
    usage:
      "Read-only inspection that maps the exact **text spans** on each page to a report at `to`. Every span carries its `text`, `bbox` [x0,y0,x1,y1], `origin`, `font`, `size`, `color` (hex) and `bold`/`italic`. This is how an agent discovers the numbers it cannot guess: the coordinates for a precise `redact` / `crop` / `stamp` / `annotate` / `add_links`, and the font/size/color a `replace_text` should match. Scope it with `pages` and `terms` (report only spans that contain a substring, e.g. `[\"Total\"]`) so the output stays small. `origin: top-left` (default) matches `redact`; `origin: bottom-left` matches `crop`/`stamp`/`annotate`, and each page also carries `width`/`height` for manual conversion (`y_bottom = height − y_top`). `format: markdown`/`both` writes a human-readable table beside the JSON. If nothing matches, the PDF may be a scan with no text layer — run `ocr` first.",
    example: '{ terms: ["Total", "Invoice #"], format: both }',
    inputs: ["invoice.pdf"],
    noOutput: true,
    result: "Writes output/text-spans.json (+ text-spans.md) listing each matched text span with its position, font, size and color — the coordinates and styling to author a precise redact/crop/stamp/annotate or a style-matched replace_text. A pure inspection: it writes only the report, so the workflow needs no output block.",
  },
  compare_pdfs: {
    usage:
      "Compares the working document with a second PDF (`against`, a workflow-relative path) and writes a diff report + highlighted images to `output.folder`. Pages are ALIGNED first (by text), so an inserted/deleted page is reported as added/removed instead of shifting every later page. Writes `_report.md` (per-page unified text diff), `_summary.json` (the change set as data), and one `change_*.png` per changed/added/removed page. `mode: text` skips images; `dpi` sets image resolution. Add `side_by_side: true` for one shareable `diff.pdf` (each changed page shown base-vs-against with the changed side highlighted). `tolerance` (0-255) ignores anti-aliasing noise in the visual fallback.",
    example: "{ against: input/contract-v2.pdf, side_by_side: true }",
    inputs: ["contract-v1.pdf"],
    output: "output/diff",
    result: "Aligns the two contract revisions, writes output/diff/_report.md + _summary.json, a highlighted change_*.png per changed page, and a side-by-side output/diff/diff.pdf.",
  },
  summarize: {
    usage:
      "Summarizes the PDF's text with an LLM and writes a Markdown summary to `to` (or a `.md` output.file). `style`: bullets (default), abstract, or outline; `focus` narrows the topic. Runs a LOCAL model via Ollama by default; set ANTHROPIC_API_KEY for Claude. Requires the pdfStudio.allowAiRequests setting.",
    example: '{ style: bullets, to: output/summary.md }',
    inputs: ["annual-report-2024.pdf"],
    output: "output/summary.md",
    result: "Writes a concise bulleted Markdown summary of the annual report to output/summary.md (using a local LLM by default).",
  },
  translate: {
    usage:
      "Translates the PDF's text to `lang` with an LLM. By default writes the translation as Markdown to `to`. Set `layout: true` to instead render a translated PDF that keeps the original page geometry, images and tables — each text block is translated in place (best for Latin/CJK scripts; point output.file at the PDF). Chunks long documents automatically. Runs a LOCAL model via Ollama by default; set ANTHROPIC_API_KEY for Claude, or point `$PDFSTUDIO_LLM_ENDPOINT` at a **free NVIDIA cloud model** (`nvidia/riva-translate-4b-instruct-v1.1` + `$NVIDIA_API_KEY`) — no local setup (see the AI-models guide in the Documentation panel). Requires the pdfStudio.allowAiRequests setting.",
    example: '{ lang: Spanish, layout: true }',
    inputs: ["user-guide.pdf"],
    output: "output/user-guide-es.pdf",
    result: "Renders a Spanish user guide that keeps the original layout (images/tables in place), each text block translated where it sits.",
  },
  pdf_to_html: {
    usage: "Converts the PDF to an HTML file written to `to`. Fidelity varies (LibreOffice).",
    example: "{ to: output/converted.html }",
    inputs: ["brochure.pdf"],
    output: "output/brochure.html",
    result: "Converts the brochure to an HTML document via LibreOffice for web publishing or content reuse.",
  },
  epub_to_pdf: {
    usage: "Converts an EPUB ebook to PDF. Make it the first operation with a `.epub` input. The bundled PyMuPDF engine renders it by default; `engine: calibre` (with `paper_size`) paginates better when Calibre is installed.",
    example: "{ engine: auto }",
    inputs: ["novel.epub"],
    output: "output/novel.pdf",
    result: "Renders the EPUB's reflowed content to a paged PDF.",
  },
  pdf_to_epub: {
    usage:
      "Converts the PDF to a **reflowable EPUB** ebook written to `to` — ideal for reading on Kindle and other e-readers (text reflows to the screen, unlike a fixed PDF). `engine`: `auto` uses Calibre's `ebook-convert` when it's installed (best reflow + formatting) and otherwise falls back to a bundled text-to-EPUB builder (always available; text-focused). Chapters come from the PDF outline when present, else every `chapter_pages` pages. `title`/`author` default to the PDF metadata. Best for prose/text books; complex layouts reflow imperfectly.",
    example: "{ to: output/book.epub }",
    inputs: ["novel.pdf"],
    output: "output/novel.pdf",
    result: "Writes a reflowable EPUB to output/book.epub (chaptered from the outline) that reads cleanly on a Kindle, while the PDF passes through unchanged.",
  },
  pdf_to_markdown: {
    usage: "Converts the PDF to Markdown. Set the workflow's `output.file` to a `.md` path and the Markdown is written THERE directly (no stray PDF) — or pass `to` for a side artifact while the PDF passes through. `engine` auto-picks pymupdf4llm → markitdown → PyMuPDF; for scans use a vision-model OCR engine — `marker` (Surya OCR + layout, needs marker-pdf) or `paddleocr-vl` (Baidu's compact 0.9B doc parser, CPU-capable, its own venv). `remote` (\"user@host\") runs Marker on a GPU box over SSH — minutes on a 4090 vs hours on a CPU; requires the pdfStudio.allowRemoteRender setting. Which engine to pick (speed/accuracy per engine): see the OCR performance report — https://github.com/LynxDI/pdf-studio/blob/main/docs/ocr-benchmark.md",
    example: "{ engine: auto }",
    inputs: ["research-paper.pdf"],
    output: "output/research-paper.md",
    result: "Writes the paper as clean Markdown (tables included) to output/research-paper.md — ready for docs or LLM ingestion.",
  },
  single_page: {
    usage: "Combines every page into one tall single page, stacked top-to-bottom. Optional `gap` adds blank space (points) between pages.",
    example: "{ gap: 12 }",
    inputs: ["receipt-scans.pdf"],
    output: "output/receipts-continuous.pdf",
    result: "Stacks all receipt pages into a single continuous page with a 12 pt gap between them — handy for scrolling or web embedding.",
  },
};


/**
 * Operations grouped into human-facing categories, in display order. Drives the
 * sidebar "Documentation" node and the generated operations reference. Every op
 * in {@link OPERATIONS} must appear in exactly one category — a coverage test
 * enforces this so a newly-added op can't silently go undocumented.
 */
export interface OpCategory {
  title: string;
  ops: string[];
}

export const OP_CATEGORIES: OpCategory[] = [
  { title: "Pages & layout", ops: ["merge", "split", "split_invoices", "delete_pages", "reorder_pages", "move_pages", "swap_pages", "rotate_pages", "flip_pages", "insert_blank", "title_page", "insert_pages", "replace_pages", "extract_pages", "crop", "scale_pages", "n_up", "booklet", "poster", "single_page"] },
  { title: "Stamps & overlays", ops: ["watermark", "stamp", "annotate", "highlight", "add_page_numbers", "header_footer", "overlay"] },
  { title: "Metadata, bookmarks & tables", ops: ["set_metadata", "set_language", "set_bookmarks", "extract_bookmarks", "extract_fields", "extract_tables", "extract_annotations", "pdf_info", "check_accessibility", "tag_pdf", "compare_pdfs", "set_view_preferences"] },
  { title: "Text, image & Markdown extraction", ops: ["extract_text", "inspect_text", "extract_images", "render_pages", "replace_image", "replace_text"] },
  { title: "OCR & document recognition", ops: ["text_report", "ocr", "extract_markdown", "pdf_to_markdown", "extract_receipt"] },
  { title: "Redaction & cleanup", ops: ["redact", "auto_redact", "sanitize", "remove_annotations", "remove_images", "remove_blank_pages", "extract_js"] },
  { title: "Forms", ops: ["create_form", "fill_form", "extract_form", "fill_field", "flatten", "unlock_forms"] },
  { title: "Attachments", ops: ["extract_attachments", "add_attachments", "extract_links", "add_links"] },
  { title: "Encryption & permissions", ops: ["encrypt", "decrypt", "set_permissions"] },
  { title: "Optimize, repair & archival", ops: ["compress", "linearize", "repair", "decompress", "rasterize", "recolor", "convert_colors", "scanner_effect", "pdf_to_pdfa"] },
  { title: "Convert to PDF", ops: ["images_to_pdf", "html_to_pdf", "markdown_to_pdf", "url_to_pdf", "eml_to_pdf", "epub_to_pdf", "office_to_pdf", "video_to_pdf"] },
  { title: "Convert from PDF", ops: ["pdf_to_docx", "pdf_to_pptx", "pdf_to_xlsx", "pdf_to_html", "pdf_to_epub", "pdf_to_png", "pdf_to_jpg"] },
  { title: "Document intelligence (AI)", ops: ["summarize", "translate", "semantic_search"] },
  { title: "Digital signatures", ops: ["sign", "validate_signature", "timestamp"] },
];
