// The OPW operation registry — the vocabulary of the workflow DSL.
//
// Each entry declares an operation keyword, the *capability* a renderer must
// advertise to execute it, the document kinds it applies to, and a lightweight
// parameter spec the validator checks against. This registry is the single
// source of truth for "what operations exist"; adapters advertise which
// capabilities they can satisfy, and the compiler matches the two.
//
// Adding an operation to the language = adding an entry here + implementing the
// capability in at least one adapter. Nothing else references op names by
// string literal.

import type { DocumentKind } from "./model.js";

/**
 * The set of transformation capabilities OPW knows about. An adapter advertises
 * a subset; the compiler refuses (with a diagnostic) any op whose capability no
 * available adapter provides — so "install PyMuPDF to enable OCR" is a planning
 * result, not a runtime crash.
 */
export type Capability =
  | "merge"
  | "split"
  | "split_invoices"
  | "compare_pdfs"
  | "delete_pages"
  | "reorder_pages"
  | "move_pages"
  | "swap_pages"
  | "rotate_pages"
  | "flip_pages"
  | "recolor"
  | "convert_colors"
  | "scanner_effect"
  | "extract_js"
  | "set_view_preferences"
  | "insert_blank"
  | "title_page"
  | "insert_pages"
  | "replace_pages"
  | "extract_pages"
  | "watermark"
  | "annotate"
  | "highlight"
  | "set_metadata"
  | "set_language"
  | "compress"
  | "extract_text"
  | "semantic_search"
  | "extract_markdown"
  | "extract_images"
  | "replace_image"
  | "replace_text"
  | "redact"
  | "ocr"
  | "fill_field"
  | "fill_form"
  | "create_form"
  | "extract_form"
  | "extract_receipt"
  | "flatten"
  | "encrypt"
  | "decrypt"
  | "linearize"
  | "crop"
  | "scale_pages"
  | "add_page_numbers"
  | "header_footer"
  | "stamp"
  | "n_up"
  | "overlay"
  | "images_to_pdf"
  | "epub_to_pdf"
  | "render_pages"
  | "remove_blank_pages"
  | "remove_annotations"
  | "remove_images"
  | "sanitize"
  | "auto_redact"
  | "set_bookmarks"
  | "extract_bookmarks"
  | "extract_attachments"
  | "extract_links"
  | "extract_annotations"
  | "add_links"
  | "add_attachments"
  | "extract_fields"
  | "extract_tables"
  | "repair"
  | "decompress"
  | "set_permissions"
  | "unlock_forms"
  | "pdf_to_pdfa"
  | "rasterize"
  | "booklet"
  | "poster"
  | "html_to_pdf"
  | "markdown_to_pdf"
  | "url_to_pdf"
  | "eml_to_pdf"
  | "office_to_pdf"
  | "video_to_pdf"
  | "pdf_to_docx"
  | "pdf_to_pptx"
  | "pdf_to_xlsx"
  | "pdf_to_html"
  | "pdf_to_epub"
  | "pdf_info"
  | "check_accessibility"
  | "tag_pdf"
  | "text_report"
  | "inspect_text"
  | "summarize"
  | "translate"
  | "single_page"
  | "sign"
  | "validate_signature"
  | "timestamp";

export type ParamType =
  | "string"
  | "number"
  | "boolean"
  | "number[]"
  /** A page list: numbers and/or compact range tokens ("5-8", "5-last", "last").
   *  Parsed by {@link ../opw/pages.ts}. Use this for anything addressing pages;
   *  plain `number[]` stays for coordinates and other non-page vectors. */
  | "pages"
  | "string[]"
  | "object";

export interface ParamSpec {
  name: string;
  type: ParamType;
  required?: boolean;
  description: string;
  /** Inclusive numeric bounds (numbers only). */
  min?: number;
  max?: number;
  /** Allowed string values (strings only). */
  enum?: readonly string[];
}

export interface OperationSpec {
  /** Keyword used in the OPW file. */
  name: string;
  /** Capability an adapter must advertise to run this op. */
  capability: Capability;
  /** One-line human summary (shown in tooling / docs). */
  summary: string;
  /** Document kinds this op is defined for. */
  kinds: DocumentKind[];
  /** Parameter specs, checked by the validator. */
  params: ParamSpec[];
  /** Alternative spellings that normalize to {@link name}. */
  aliases?: string[];
  /** Params an alias keyword implies, keyed by alias. Lets one op expose a named
   *  variant of itself (`interleave` = `merge` with `interleave: true`) without a
   *  second registry entry — the alias is erased at compile time, so the implied
   *  params are what carry the intent through to the adapter. Merged UNDER the
   *  authored params, so an explicit value always wins. */
  aliasParams?: Record<string, Record<string, unknown>>;
  /** This op writes its own output file(s) to a directory/path param (e.g.
   *  split_invoices → `to`), independent of the workflow's `output.file`. When a
   *  workflow contains such an op, `output.file` becomes OPTIONAL (the workflow
   *  still produces output — the emitted files). */
  emitsFiles?: boolean;
  /** The FILES this op emits are the user's real output — the working document afterwards
   *  is discarded. Anything sequenced after it cannot change what lands on disk, so the
   *  optimizer must not hoist a later op past it. Distinct from {@link emitsFiles}, which
   *  is about `output.file` being optional: `split` emits the output AND still needs a
   *  destination to name its parts against. */
  artifactsAreTheOutput?: boolean;
  /** This op changes how many pages the document has, or what order they are in
   *  — so a page number written BEFORE it means something different AFTER it.
   *  Tooling that turns a click on page N of an input document into an operation
   *  uses this to place the op where N still refers to the page the user picked.
   *  (See `pdfStudio.applyToPage` in the extension.) */
  changesPagination?: boolean;
  /** This op reads ALL inputs together rather than transforming one document
   *  (extract_form → one table over many forms). A glob normally triggers batch —
   *  the workflow runs once per match — which would defeat such an op (it would see
   *  one file at a time). When a plan contains one, glob matches are expanded into a
   *  single run's inputs instead. */
  consumesAllInputs?: boolean;
  /** This op CREATES a PDF from ONE non-PDF document, reading the working document
   *  (office_to_pdf: a .pptx → a PDF). Such an op composes with a folding op: when a
   *  glob feeds many files into ONE run (`decks/*.pptx` → office_to_pdf → merge), it
   *  runs once per input first, so the folding op sees PDFs instead of raw .pptx bytes.
   *  NOT set for creators that already read every input at once (images_to_pdf) or that
   *  read no input at all (url_to_pdf) — those cannot be applied per file. */
  perInputCreator?: boolean;
  /** File extensions (lowercase, with the dot) this op converts INTO a PDF. Makes the
   *  registry the single source of truth for "which operation opens a .pptx" — the
   *  validator checks a creator's input against it, and `merge` dispatches on it to
   *  combine mixed file types. */
  inputExtensions?: string[];
}

/** The operation that converts `ext` (".docx", ".png", …) into a PDF, if any. */
export function creatorForExtension(ext: string): OperationSpec | undefined {
  const e = ext.toLowerCase();
  return Object.values(OPERATIONS).find((s) => s.inputExtensions?.includes(e));
}

const PDF: DocumentKind[] = ["pdf"];

/**
 * The registry, keyed by canonical op name. Ordered roughly MVP-first.
 */
export const OPERATIONS: Record<string, OperationSpec> = {
  merge: {
    name: "merge",
    capability: "merge",
    summary: "Combine input documents into one — concatenated end-to-end, or alternating page-by-page with `interleave`.",
    kinds: PDF,
    changesPagination: true,
    params: [
      {
        name: "interleave",
        type: "boolean",
        description:
          "Alternate pages round-robin across the inputs (A p1, B p1, A p2, B p2, …) instead of concatenating. Shorter inputs are padded with blank pages so every round contributes one page per input.",
      },
      {
        name: "convert",
        type: "boolean",
        description:
          "Convert non-PDF inputs (Word, PowerPoint, Excel, images, Markdown, HTML, email, EPUB) to PDF automatically before merging, by file extension. Default true — set false to require every input to already be a PDF.",
      },
    ],
    // A glob in `inputs` (docs/*.pdf) feeds ALL matched files into ONE merge, in sorted
    // filename order, instead of batching one run per file.
    consumesAllInputs: true,
    aliases: ["interleave"],
    aliasParams: { interleave: { interleave: true } },
  },
  split: {
    name: "split",
    capability: "split",
    summary:
      "Split the working document into multiple outputs — by page ranges, every N pages, or by a maximum FILE SIZE so every part fits an upload limit.",
    kinds: PDF,
    changesPagination: true,
    params: [
      {
        name: "ranges",
        type: "string[]",
        description:
          'Page ranges, 1-based, e.g. ["1-3", "4-4", "5-10"]. Each range becomes one output file.',
      },
      {
        name: "every",
        type: "number",
        description: "Alternatively, split every N pages into a new file.",
        min: 1,
      },
      {
        name: "max_size",
        type: "string",
        description:
          'Alternatively, pack as many pages as fit under a size limit. Always give a unit: "5MB" (decimal, 5,000,000) or "5MiB" (binary, 5,242,880 — what most upload forms actually check); also KB/KiB/GB/GiB. Every part is measured, not estimated. Leave your own headroom ("4.8MB" for a 5 MB cap) — no hidden safety margin is applied.',
      },
      {
        name: "min_pages",
        type: "number",
        description:
          "With max_size: never emit a part smaller than this, even if it exceeds the limit (default 1). Guards against a pathological document producing hundreds of one-page parts.",
        min: 1,
      },
      {
        name: "name",
        type: "string",
        description:
          'Filename template for each part, without ".pdf" — tokens {stem} {name} {ext} {i} {start} {end} {n}, zero-padded as {i:03}. Default: part_000001.pdf in a folder, or <output-stem>_000001.pdf beside a file.',
      },
    ],
    aliases: ["burst"],
    aliasParams: { burst: { every: 1 } },
    artifactsAreTheOutput: true,
  },
  split_invoices: {
    name: "split_invoices",
    capability: "split_invoices",
    summary:
      "Split a PDF that concatenates many invoices/receipts into one PDF per invoice, detecting boundaries from the page text and naming each file from the detected invoice number/date/vendor.",
    kinds: PDF,
    changesPagination: true,
    params: [
      {
        name: "to",
        type: "string",
        description: "Output directory for the per-invoice PDFs (default output/invoices) when `output.folder` is not set. Prefer declaring `output.folder` at the workflow level. A _manifest.csv is also written here.",
      },
      {
        name: "name",
        type: "string",
        description:
          'Filename template (default "invoice_{index:04d}"). Tokens: {index}, {invoice_number}, {vendor}, {date} (YYYY-MM-DD), {page_start}, {page_end}. Empty/colliding names are auto-suffixed with the index.',
      },
      {
        name: "starts",
        type: "number[]",
        description:
          "Manual override: explicit 1-based start pages, e.g. [1, 4, 7]. When given, automatic detection is skipped and pages are grouped between these starts.",
      },
      {
        name: "keywords",
        type: "string[]",
        description:
          'Header keywords (case-insensitive) that mark a likely new-invoice page. Default ["invoice", "tax invoice", "receipt", "statement", "bill to"].',
      },
      {
        name: "drop_blank",
        type: "boolean",
        description: "Drop near-empty separator pages (e.g. blank versos in scanned batches) instead of attaching them to the preceding invoice.",
      },
      {
        name: "ocr_first",
        type: "boolean",
        description: "Rebuild a text layer with OCR (OCRmyPDF/Tesseract) before detecting — for scanned invoices with a poor or missing text layer. Slower.",
      },
      {
        name: "lang",
        type: "string",
        description: 'OCR language(s) for ocr_first, e.g. "eng" or "eng+fra" (default eng).',
      },
      {
        name: "detect",
        type: "string",
        enum: ["heuristic", "ai"],
        description:
          'Boundary detector. "heuristic" (default) is free, offline, and deterministic. "ai" uses an LLM (configurable endpoint, local Ollama by default); requires the pdfStudio.allowAiRequests setting.',
      },
    ],
    aliases: ["burst_invoices", "split_receipts"],
    emitsFiles: true,
  },
  compare_pdfs: {
    name: "compare_pdfs",
    capability: "compare_pdfs",
    summary:
      "Compare the working document with a second PDF and write a diff report (per-page added/removed/changed text) plus highlighted per-page images. Pages are aligned first, so inserted/deleted pages are detected rather than shifting everything.",
    kinds: PDF,
    params: [
      {
        name: "against",
        type: "string",
        required: true,
        description: "Path (workflow-relative) to the second PDF to compare the working document against.",
      },
      {
        name: "to",
        type: "string",
        description: "Output directory for the diff report + images (default output/diff) when `output.folder` is not set. Prefer declaring `output.folder`.",
      },
      {
        name: "mode",
        type: "string",
        enum: ["text", "visual", "both"],
        description: 'Which diffs to produce: "text" (report only, fast), "visual" (highlighted images), or "both" (default).',
      },
      {
        name: "dpi",
        type: "number",
        description: "Render DPI for the visual diff images (default 150).",
        min: 36,
        max: 600,
      },
      {
        name: "only_changed",
        type: "boolean",
        description: "Emit a visual-diff image only for pages that differ (default true).",
      },
      {
        name: "tolerance",
        type: "number",
        description: "Per-channel pixel tolerance (0-255) for the visual band-diff fallback, so anti-aliasing / minor rendering noise is ignored (default 0 = exact).",
        min: 0,
        max: 255,
      },
      {
        name: "side_by_side",
        type: "boolean",
        description: "Also assemble one shareable diff.pdf with each changed page shown base-vs-against, changed side highlighted. Aliased as diff_pdf.",
      },
    ],
    aliases: ["diff_pdfs", "pdf_compare"],
    emitsFiles: true,
  },
  summarize: {
    name: "summarize",
    capability: "summarize",
    summary:
      "Summarize the PDF's text with an LLM and write a Markdown summary. Uses a local model by default (Ollama); requires the pdfStudio.allowAiRequests setting.",
    kinds: PDF,
    params: [
      { name: "to", type: "string", description: "Output path for the Markdown summary (default output/summary.md; a .md output.file also works)." },
      { name: "style", type: "string", enum: ["bullets", "abstract", "outline"], description: "Summary style (default bullets)." },
      { name: "focus", type: "string", description: "Optional topic to focus the summary on, e.g. \"risks and financials\"." },
      { name: "model", type: "string", description: "LLM model (default: a local model, e.g. llama3.1; or a Claude model when ANTHROPIC_API_KEY is set)." },
      { name: "max_chars", type: "number", description: "Max characters of document text to send (default 60000).", min: 1000 },
      { name: "max_tokens", type: "number", description: "Max tokens in the generated summary (default 1024).", min: 64 },
    ],
    aliases: ["summarise"],
  },
  translate: {
    name: "translate",
    capability: "translate",
    summary:
      "Translate the PDF's text to a target language with an LLM and write the translated Markdown. Uses a local model by default (Ollama); requires the pdfStudio.allowAiRequests setting.",
    kinds: PDF,
    params: [
      { name: "lang", type: "string", required: true, description: 'Target language, e.g. "Spanish", "German", "Japanese".' },
      { name: "layout", type: "boolean", description: "Layout-preserving: translate each text block in place and render a translated PDF that keeps the original page geometry, images and tables (instead of Markdown). Aliased as in_place. Best for Latin/CJK scripts (built-in fonts)." },
      { name: "to", type: "string", description: "Output path for the translated Markdown (default output/translated.md). Ignored in layout mode — set output.file to the translated PDF path instead." },
      { name: "model", type: "string", description: "LLM model (default: a local model; or a Claude model when ANTHROPIC_API_KEY is set)." },
      { name: "max_chars", type: "number", description: "Max characters of document text to translate (default 100000; Markdown mode only).", min: 1000 },
      { name: "chunk", type: "number", description: "Characters per translation request (default 3500).", min: 500 },
      { name: "max_tokens", type: "number", description: "Max tokens per translated chunk (default 2048).", min: 64 },
    ],
  },
  delete_pages: {
    name: "delete_pages",
    capability: "delete_pages",
    summary: "Remove the given 1-based pages from the working document.",
    kinds: PDF,
    changesPagination: true,
    params: [
      {
        name: "pages",
        type: "pages",
        required: true,
        description: "1-based page numbers to remove.",
      },
    ],
  },
  reorder_pages: {
    name: "reorder_pages",
    capability: "reorder_pages",
    summary: "Reorder pages to a COMPLETE 1-based permutation (every page, exactly once).",
    kinds: PDF,
    changesPagination: true,
    params: [
      {
        name: "order",
        type: "pages",
        required: true,
        description:
          "1-based page numbers in the new order. EVERY page of the document must appear exactly once — a partial list is an error, not a shortcut for dropping pages. To move a few pages use `move_pages`, to exchange two use `swap_pages`, to keep a subset use `extract_pages`.",
      },
    ],
  },
  move_pages: {
    name: "move_pages",
    capability: "move_pages",
    summary: "Move pages to a new position, leaving every other page where it is.",
    kinds: PDF,
    changesPagination: true,
    params: [
      {
        name: "pages",
        type: "pages",
        required: true,
        description: "1-based pages to move, in the order they should land. Ranges allowed: [2, \"5-9\"].",
      },
      {
        name: "after",
        type: "number",
        description: "Drop the moved block immediately AFTER this 1-based page (numbered in the ORIGINAL document). Use 0 for the very start. Mutually exclusive with `before`.",
        min: 0,
      },
      {
        name: "before",
        type: "number",
        description: "Drop the moved block immediately BEFORE this 1-based page (numbered in the ORIGINAL document). Mutually exclusive with `after`.",
        min: 1,
      },
    ],
  },
  swap_pages: {
    name: "swap_pages",
    capability: "swap_pages",
    summary: "Exchange the positions of two pages, leaving every other page where it is.",
    kinds: PDF,
    changesPagination: true,
    params: [
      { name: "a", type: "number", required: true, description: "1-based page number.", min: 1 },
      { name: "b", type: "number", required: true, description: "The 1-based page to exchange it with.", min: 1 },
    ],
  },
  rotate_pages: {
    name: "rotate_pages",
    capability: "rotate_pages",
    summary: "Rotate the given pages (or all) by a multiple of 90 degrees.",
    kinds: PDF,
    params: [
      {
        name: "pages",
        type: "pages",
        description: "1-based pages to rotate. Omit to rotate every page.",
      },
      {
        name: "degrees",
        type: "number",
        required: true,
        description: "Clockwise rotation; must be a multiple of 90.",
      },
    ],
  },
  recolor: {
    name: "recolor",
    capability: "recolor",
    summary: "Recolor pages for comfortable reading: dark mode (light text on dark, photos kept intact), raw invert, or grayscale. Rasterizes each page.",
    kinds: PDF,
    params: [
      { name: "mode", type: "string", enum: ["dark", "invert", "grayscale"], description: "dark (default) = smart dark mode — inverts text/background to light-on-dark but keeps embedded images/photos looking normal; invert = raw negative (everything, incl. images); grayscale = drop color." },
      { name: "dpi", type: "number", description: "Rasterization resolution (default 150).", min: 36, max: 600 },
    ],
  },
  convert_colors: {
    name: "convert_colors",
    capability: "convert_colors",
    summary:
      "Convert the whole document's color space with Ghostscript — to grayscale (for cheap B&W printing), CMYK (for a commercial press), or RGB (for screen). Keeps text and vector art as vectors (unlike recolor, which rasterizes). Needs Ghostscript installed.",
    kinds: PDF,
    params: [
      {
        name: "mode",
        type: "string",
        enum: ["gray", "cmyk", "rgb"],
        description: "Target color space: gray (default, aka grayscale — drop all color to neutral gray), cmyk (process color for print), or rgb (screen).",
      },
    ],
    aliases: ["convert_color", "color_convert"],
  },
  scanner_effect: {
    name: "scanner_effect",
    capability: "scanner_effect",
    summary: "Make a clean PDF look scanned — slight skew, softening, and grain. Rasterizes each page.",
    kinds: PDF,
    params: [
      { name: "dpi", type: "number", description: "Rasterization resolution (default 150).", min: 36, max: 600 },
      { name: "skew", type: "number", description: "Max rotation in degrees, alternating per page (default 0.7)." },
      { name: "noise", type: "number", description: "Grain amount 0..1 (default 0.06).", min: 0, max: 1 },
      { name: "grayscale", type: "boolean", description: "Desaturate like a b/w scan (default true)." },
    ],
  },
  extract_js: {
    name: "extract_js",
    capability: "extract_js",
    summary: "Surface any embedded JavaScript (document Names tree + open action) to a report for inspection. Read-only; use `sanitize` to remove it.",
    kinds: PDF,
    params: [
      { name: "to", type: "string", description: "Output path for the report (default output/javascript.md)." },
    ],
  },
  flip_pages: {
    name: "flip_pages",
    capability: "flip_pages",
    summary: "Mirror pages horizontally or vertically (a true flip, not a rotation).",
    kinds: PDF,
    params: [
      { name: "pages", type: "pages", description: "1-based pages to flip. Omit to flip every page." },
      {
        name: "direction",
        type: "string",
        enum: ["horizontal", "vertical"],
        description: 'Mirror axis: "horizontal" (default, left↔right) or "vertical" (top↕bottom).',
      },
    ],
  },
  insert_blank: {
    name: "insert_blank",
    capability: "insert_blank",
    summary: "Insert a blank page at a 1-based position.",
    kinds: PDF,
    changesPagination: true,
    params: [
      {
        name: "at",
        type: "number",
        required: true,
        description: "1-based index the blank page is inserted before.",
        min: 1,
      },
      {
        name: "size",
        type: "string",
        description: 'Page size: "match" (default, copy neighbor), "A4", "Letter", or "Legal".',
        enum: ["match", "A4", "Letter", "Legal"],
      },
    ],
  },
  title_page: {
    name: "title_page",
    capability: "title_page",
    summary:
      "Draw a title/cover page and insert it at the front. An e-reader takes its thumbnail from page 1 — pair with set_metadata, which is where the library title comes from.",
    kinds: PDF,
    changesPagination: true,
    aliases: ["cover_page", "cover"],
    params: [
      { name: "title", type: "string", description: "The main line. Wraps to the column width; use a YAML block scalar for a deliberate line break." },
      { name: "subtitle", type: "string", description: "A second line under the title (edition, subject, date range)." },
      { name: "author", type: "string", description: "Author or organisation, below the rule." },
      { name: "date", type: "string", description: 'A literal string ("2026" or "October 2026") — never the current date, so the render stays deterministic.' },
      { name: "at", type: "number", description: "1-based position to insert BEFORE (default 1 = the very front). Use it for section dividers mid-document.", min: 1 },
      { name: "size", type: "string", enum: ["match", "A4", "Letter", "Legal"], description: 'Page size ("match" = copy the neighbouring page, the default).' },
      { name: "font", type: "string", enum: ["Helv", "TiRo", "Cour"], description: "Font family: Helvetica, Times Roman or Courier (default Helv). Bold is used for the title automatically." },
      { name: "title_size", type: "number", description: "Title point size (default 36). Everything else derives from it, so this is the one type knob.", min: 6, max: 288 },
      { name: "margin", type: "number", description: "Margin in points (default 72). Sets the text column width, so it is the real control for a long title.", min: 0, max: 300 },
      { name: "color", type: "string", description: 'Title colour as "#RRGGBB" (default #1A1A1A). Subtitle/author/date derive from it. QUOTE it — a bare # starts a YAML comment.' },
      { name: "background", type: "string", description: 'Full-page background colour as "#RRGGBB". Omit for none (white paper).' },
      { name: "image", type: "string", description: "Asset name of a PNG/JPEG logo, centred above the title." },
      { name: "image_width", type: "number", description: "Logo width in points (default: 40% of the page width, capped to the column).", min: 1 },
      { name: "align", type: "string", enum: ["center", "left"], description: "Text alignment (default center)." },
      { name: "rule", type: "boolean", description: "Draw a short hairline between the title block and the author (default true)." },
    ],
  },
  insert_pages: {
    name: "insert_pages",
    capability: "insert_pages",
    summary:
      "Insert another PDF's pages into the working document at a given position. Declare the source PDF under `assets` and reference it by name.",
    kinds: PDF,
    changesPagination: true,
    params: [
      { name: "from", type: "string", required: true, description: "Asset name of the PDF to insert (declare it under `assets:`)." },
      { name: "at", type: "number", description: "1-based position to insert BEFORE (at: 1 = the very start). Omit to append at the end.", min: 1 },
      { name: "pages", type: "pages", description: "1-based pages of the SOURCE PDF to insert, in page order. Omit for all of its pages." },
    ],
    aliases: ["insert_pdf"],
  },
  replace_pages: {
    name: "replace_pages",
    capability: "replace_pages",
    summary:
      "Replace pages of the working document with pages from another PDF — the listed pages are removed and the replacement is dropped in where the first of them was. Declare the source PDF under `assets`.",
    kinds: PDF,
    changesPagination: true,
    params: [
      { name: "from", type: "string", required: true, description: "Asset name of the replacement PDF (declare it under `assets:`)." },
      { name: "pages", type: "pages", required: true, description: "1-based pages of the working document to replace. The replacement lands where the first of these was." },
      { name: "from_pages", type: "pages", description: "1-based pages of the SOURCE to use as the replacement, in page order. Omit for all of its pages." },
    ],
    // NOTE: `swap_pages` was once an alias here. It is now its own operation
    // (exchange two pages of THIS document) — the alias sent everyone asking to
    // "swap pages 2 and 10" to an op that requires a second PDF.
  },
  extract_pages: {
    name: "extract_pages",
    capability: "extract_pages",
    summary: "Keep only the given 1-based pages (drops all others).",
    kinds: PDF,
    changesPagination: true,
    params: [
      {
        name: "pages",
        type: "pages",
        required: true,
        description: "1-based pages to keep, in the order given.",
      },
    ],
  },
  watermark: {
    name: "watermark",
    capability: "watermark",
    summary: "Stamp a diagonal text (or image) watermark on pages.",
    kinds: PDF,
    params: [
      { name: "text", type: "string", description: "Watermark text." },
      { name: "image", type: "string", description: "Asset name or path of a watermark image." },
      {
        name: "opacity",
        type: "number",
        description: "0..1 opacity (default 0.15).",
        min: 0,
        max: 1,
      },
      {
        name: "pages",
        type: "pages",
        description: "1-based pages to stamp. Omit for all pages.",
      },
      {
        name: "rotate",
        type: "number",
        description: "Text rotation in degrees (default 45).",
      },
    ],
  },
  annotate: {
    name: "annotate",
    capability: "annotate",
    summary:
      "Add annotations to pages — free text, text highlights, sticky notes, shapes (rect/line/ellipse) and images. Coordinates are in points, origin BOTTOM-LEFT (like crop/stamp).",
    kinds: PDF,
    params: [
      {
        name: "annotations",
        type: "object",
        required: true,
        description:
          "List of annotation specs. Each: { type, page (1-based), … }. type=text: rect [x,y,w,h] + text; " +
          "type=highlight: find \"text\" (or rect); type=note: at [x,y] + text; type=rect|ellipse: rect [+color,fill,width]; " +
          "type=line: at [x,y] + to [x,y]; type=image: rect + image (path). Colors: \"#RRGGBB\" or [r,g,b]. " +
          "Coordinates are points (origin set by `origin`). Invalid items are skipped.",
      },
      {
        name: "origin",
        type: "string",
        enum: ["bottom-left", "top-left"],
        description: "Coordinate origin for rect/at/to (default bottom-left, like crop/stamp).",
      },
      {
        name: "flatten",
        type: "boolean",
        description: "Bake the annotations into page content so they can't be removed/edited (needs PyMuPDF ≥ 1.24).",
      },
    ],
    aliases: ["annotations", "markup"],
  },
  highlight: {
    name: "highlight",
    capability: "highlight",
    summary:
      "Find text and MARK it — highlight, underline, strikeout, squiggly or a box — anywhere it appears. Same matcher as auto_redact (literal strings, regexes, PII presets, case/whole-word) but it marks instead of destroying. The marks are real PDF annotations: readable by `extract_annotations`, removable by `remove_annotations`.",
    kinds: PDF,
    params: [
      { name: "text", type: "string[]", description: "One or more literal strings to find and mark (e.g. a name, a clause, a defined term). At least one of text/regex/patterns is required." },
      { name: "patterns", type: "string[]", description: "Named presets to match by shape: ssn, email, phone, credit_card, ein, ipv4, iban. Heuristics — check with preview first." },
      { name: "regex", type: "string[]", description: "Custom regular expression(s) to match (advanced; e.g. 'Order #\\d+')." },
      {
        name: "style",
        type: "string",
        enum: ["highlight", "underline", "strikeout", "squiggly", "box"],
        description: "How to mark each match. highlight (default) = translucent fill over the words; underline / strikeout / squiggly = a line under / through / squiggling beneath them; box = a rectangle drawn around each line of the match.",
      },
      { name: "color", type: "string", description: 'Mark color, "#RRGGBB" or [r,g,b] 0..1. Defaults per style: yellow for highlight, red for strikeout, blue for the rest.' },
      { name: "opacity", type: "number", description: "Mark opacity 0..1 (default 1; highlights are translucent by nature).", min: 0, max: 1 },
      { name: "width", type: "number", description: "Border width in points for style: box (default 1).", min: 0 },
      { name: "ignore_case", type: "boolean", description: "Case-insensitive matching (default false). Aliased as case_insensitive." },
      { name: "whole_word", type: "boolean", description: 'Match only whole words, so "Ann" does not hit "Anniversary" (default false).' },
      { name: "pages", type: "pages", description: "1-based pages to search. Omit to search every page." },
      { name: "note", type: "string", description: "Popup comment attached to every mark (shows on hover in a viewer, and lands in the `contents` column of extract_annotations)." },
      { name: "author", type: "string", description: "Annotation author/title shown in a viewer's comment list (default \"PDF Studio\")." },
      { name: "flatten", type: "boolean", description: "Bake the marks into page content so they can't be clicked away or removed (needs PyMuPDF >= 1.24). They stop being annotations — extract_annotations will no longer see them." },
      { name: "preview", type: "boolean", description: "Dry run: write a report of what WOULD be marked (page + matched text + rule) and change NOTHING. Aliased as dry_run." },
      { name: "to", type: "string", description: "Output path for the preview report (default output/highlight-preview.md). Only used when preview is set." },
    ],
    aliases: ["mark_text", "highlight_text", "find_highlight"],
  },
  set_metadata: {
    name: "set_metadata",
    capability: "set_metadata",
    summary: "Set document metadata (title, author, subject, keywords).",
    kinds: PDF,
    aliases: ["metadata"],
    params: [
      { name: "title", type: "string", description: "Document title." },
      { name: "author", type: "string", description: "Document author." },
      { name: "subject", type: "string", description: "Document subject." },
      { name: "keywords", type: "string[]", description: "Keyword list." },
      { name: "creator", type: "string", description: "Creating application." },
      { name: "producer", type: "string", description: "Producing application." },
    ],
  },
  set_language: {
    name: "set_language",
    capability: "set_language",
    summary:
      "Set the document's default language (the PDF catalog /Lang) — a BCP-47 tag like \"en-US\" or \"fr\". Required for accessibility (WCAG 3.1.1 / PDF/UA) so assistive tech reads the document in the right voice; check_accessibility flags a missing one.",
    kinds: PDF,
    params: [
      { name: "lang", type: "string", required: true, description: 'BCP-47 language tag, e.g. "en-US", "en-GB", "fr", "es-MX", "zh-Hans".' },
    ],
    aliases: ["set_lang"],
  },
  compress: {
    name: "compress",
    capability: "compress",
    summary: "Reduce file size — by quality, or to a target `max_size` (deep compression when Ghostscript/qpdf is available).",
    kinds: PDF,
    aliases: ["compress_images"],
    params: [
      {
        name: "quality",
        type: "number",
        description: "Target image quality 1..100 (deep backends only). Also the CEILING for max_size — it never uses a better setting than this.",
        min: 1,
        max: 100,
      },
      {
        name: "max_size",
        type: "string",
        description:
          'Compress until the file is under this size — "4.5MB" (decimal) or "4.5MiB" (binary); also KB/KiB/GB/GiB. Walks a quality ladder and stops at the best setting that fits. Needs Ghostscript for image downsampling; if the target is unreachable you get the smallest valid result and a note saying so, not a failure.',
      },
    ],
  },
  extract_text: {
    name: "extract_text",
    capability: "extract_text",
    summary: "Extract page text to a sidecar artifact, optionally cleaned up (headers/footers, hyphenation, reflow).",
    kinds: PDF,
    params: [
      { name: "to", type: "string", description: "Output path for extracted text." },
      { name: "clean", type: "boolean", description: "Turn on all three cleanup passes below. Recommended for OCR'd or hard-wrapped text." },
      { name: "remove_headers_footers", type: "boolean", description: "Drop running headers/footers (a first/last line that repeats across most pages)." },
      { name: "fix_hyphenation", type: "boolean", description: 'Rejoin words split across a line break ("inter-\nnational" → "international").' },
      { name: "reflow", type: "boolean", description: "Rejoin hard-wrapped lines back into paragraphs (blank lines and list items are preserved)." },
      { name: "page_markers", type: "boolean", description: "Insert a `--- Page N ---` marker before each page's text." },
    ],
  },
  semantic_search: {
    name: "semantic_search",
    capability: "semantic_search",
    summary: "Find passages by meaning, not keywords — a natural-language query over the PDF, using a LOCAL embedding model. Writes a ranked Markdown report with page numbers.",
    kinds: PDF,
    params: [
      { name: "query", type: "string", required: true, description: "What you're looking for, in plain language (e.g. \"the refund policy for late cancellations\")." },
      { name: "top_k", type: "number", description: "How many passages to return (default 5).", min: 1 },
      { name: "min_score", type: "number", description: "Drop hits below this cosine similarity (0..1). Default 0 (keep all)." },
      { name: "to", type: "string", description: "Output path for the ranked results (default output/search-results.md)." },
      { name: "model", type: "string", description: "Embedding model (default nomic-embed-text via local Ollama). Pull it with `ollama pull nomic-embed-text`." },
      { name: "chunk_words", type: "number", description: "Target passage size in words (default 200).", min: 20 },
      { name: "overlap_words", type: "number", description: "Words repeated between adjacent passages so a split passage is still findable (default 30).", min: 0 },
      { name: "no_cache", type: "boolean", description: "Skip the per-document embedding cache (recompute every run). By default a repeat search on the same PDF reuses cached chunk embeddings." },
    ],
  },
  extract_markdown: {
    name: "extract_markdown",
    capability: "extract_markdown",
    summary: "Extract page content as Markdown, tables included (pymupdf4llm or markitdown improve quality). OCR control via `ocr`.",
    kinds: PDF,
    params: [
      { name: "to", type: "string", description: "Output path for the Markdown file (default output/document.md)." },
      {
        name: "engine",
        type: "string",
        enum: ["auto", "pymupdf4llm", "markitdown", "marker", "paddleocr-vl", "mineru"],
        description: "Markdown engine. auto (default) prefers pymupdf4llm, then markitdown, then a PyMuPDF fallback. marker uses Surya OCR + layout models (best for scans; slow, needs marker-pdf). paddleocr-vl runs Baidu's 0.9B PaddleOCR-VL doc-parsing model locally (CPU-capable, strong on scans/tables/formulas; runs in its own venv via $PDFSTUDIO_PADDLE_PYTHON). mineru runs the MinerU 2.5-Pro VLM locally — the best table/form structure (real HTML tables), CPU-capable but slow (~minutes/page, best for a few pages); its own venv via $PDFSTUDIO_MINERU_PYTHON. See docs/python-setup.md.",
      },
      { name: "ocr", type: "string", enum: ["off", "auto", "force"], description: "OCR control: off = text-layer only; auto (default) = OCR only when the doc lacks a usable text layer (keeps existing text — never destroys it); force = re-OCR everything (lossy). For the marker engine this maps to marker's own force_ocr; for other engines it's an OCRmyPDF pre-pass." },
      { name: "ocr_first", type: "boolean", description: "Deprecated alias for `ocr: force` — rebuild a clean text layer with OCR before extracting. Prefer `ocr`." },
      { name: "margins", type: "number", min: 0, description: "Clip this many points off the top AND bottom of every page before extracting — strips running headers, footers, and page numbers (pymupdf4llm engine)." },
      { name: "lang", type: "string", description: "OCR language(s) for the ocr pre-pass, e.g. \"eng\" or \"eng+fra\" (default eng)." },
      { name: "remote", type: "string", description: "Run Marker on a remote GPU box over SSH (\"user@host\", key-based auth). Requires the pdfStudio.allowRemoteRender setting. Marker is auto-installed on the box on first use; the PDF is uploaded, converted on the GPU, and the Markdown returned." },
      { name: "endpoint", type: "string", description: "Run Marker via an HTTP service (POST multipart file + force_ocr → JSON {markdown}) instead of SSH. Chunked + resumable for large files. Requires pdfStudio.allowRemoteRender; egresses document bytes to the URL. Set `remote` OR `endpoint`, not both." },
    ],
  },
  extract_images: {
    name: "extract_images",
    capability: "extract_images",
    summary: "Extract embedded images.",
    kinds: PDF,
    params: [
      { name: "to", type: "string", description: "Output directory for images." },
    ],
  },
  replace_text: {
    name: "replace_text",
    capability: "replace_text",
    summary:
      "Find text and replace it in place — re-date a template, fix a recurring typo, swap an entity name across a whole folder. `find` is literal by default, or a regular expression with regex: true (dates, IDs, order numbers). Matches within a line; the replacement lands on the original baseline in the original size and color.",
    kinds: PDF,
    params: [
      { name: "find", type: "string", required: true, description: "The text to find. Literal by default; set `regex: true` to treat it as a regular expression. Matches within a single line — text that wraps across lines won't match." },
      { name: "replace", type: "string", description: 'The replacement text. An empty string ("") deletes the match. In regex mode it is a template that may reference capture groups (\\1, \\g<name>).' },
      { name: "regex", type: "boolean", description: 'Treat `find` as a regular expression (Python syntax) instead of literal text — e.g. "\\d{2}/\\d{2}/\\d{4}" to re-date, "Order #\\d+" to mask IDs. `replace` may reference capture groups. `whole_word` is ignored in regex mode (put boundaries like \\b in the pattern). Default false.' },
      { name: "ignore_case", type: "boolean", description: "Case-insensitive matching (default false)." },
      { name: "whole_word", type: "boolean", description: 'Match whole words only, so "Ann" does not hit "Anniversary" (default false). Ignored when `regex` is set.' },
      { name: "pages", type: "pages", description: "1-based pages to touch. Omit for all pages." },
      { name: "font", type: "string", enum: ["auto", "Helv", "TiRo", "Cour"], description: "Replacement font when no font_file is given. Default auto: serif originals map to Times, monospace to Courier, everything else to Helvetica, keeping bold/italic. A subsetted embedded original font cannot be reused for NEW glyphs — this Base-14 substitution is inherent unless you supply font_file." },
      { name: "font_file", type: "string", description: "Workflow-relative path to a .ttf/.otf to EMBED for the replacement (e.g. assets/DejaVuSans.ttf) — supply the document's own font to match its typography exactly instead of the Base-14 fallback. Overrides `font`; used for every replacement in this op." },
      { name: "preview", type: "boolean", description: "Dry run: write a report of every match (page, text, position) and change nothing." },
      { name: "to", type: "string", description: "Path for the preview report (default output/replace-preview.md; only with preview)." },
    ],
    aliases: ["find_replace_text", "find_and_replace"],
  },
  replace_image: {
    name: "replace_image",
    capability: "replace_image",
    summary: "Replace an embedded image object.",
    kinds: PDF,
    params: [
      { name: "selector", type: "object", required: true, description: "Object selector, e.g. { page, object_name }." },
      { name: "image", type: "string", required: true, description: "Asset name or path of the replacement image." },
    ],
  },
  redact: {
    name: "redact",
    capability: "redact",
    summary: "Permanently remove content in regions.",
    kinds: PDF,
    params: [
      { name: "page", type: "number", required: true, description: "1-based page." },
      { name: "rects", type: "object", required: true, description: "Rectangles [x, y, w, h] to redact." },
      { name: "rasterize", type: "boolean", description: "After removing the regions, flatten the WHOLE document to an image-only PDF — nothing hidden (text layer, metadata, off-page content, form fields) can survive. Output is not selectable/searchable." },
      { name: "dpi", type: "number", description: "Resolution when rasterize is set (default 150).", min: 36, max: 600 },
    ],
  },
  ocr: {
    name: "ocr",
    capability: "ocr",
    summary: "Add a searchable text layer via OCR (Tesseract). Modes for filling gaps, re-OCR'ing, or forcing.",
    kinds: PDF,
    params: [
      { name: "language", type: "string", description: "OCR language code, e.g. \"eng\", \"eng+hin\" (default eng). Must be installed in Tesseract's tessdata — the op preflights and fails clearly if not." },
      { name: "mode", type: "string", enum: ["skip-text", "redo-ocr", "force-ocr"], description: "skip-text (default) OCRs only pages with no text and keeps existing text; redo-ocr strips prior OCR and re-recognizes (keeps original images); force-ocr rasterizes and OCRs everything (lossy)." },
      { name: "output_type", type: "string", enum: ["pdf", "pdfa"], description: "Output flavor (default pdf). pdfa produces an archival PDF/A (needs Ghostscript)." },
      { name: "optimize", type: "number", min: 0, max: 3, description: "OCRmyPDF optimization level 0–3 (default 0). Levels above 0 need pngquant/jbig2enc installed." },
      { name: "page_range", type: "string", description: "OCRmyPDF page range to process, e.g. \"1-3,7\". Omit for all pages. (Distinct from the number[] `pages` used by other ops — this is Tesseract's own range syntax.)" },
    ],
  },
  fill_field: {
    name: "fill_field",
    capability: "fill_field",
    summary: "Set the value of a form (AcroForm) field.",
    kinds: PDF,
    params: [
      { name: "field", type: "string", required: true, description: "Form field name to set." },
      { name: "value", type: "string", required: true, description: "New value for the field." },
    ],
  },
  fill_form: {
    name: "fill_form",
    capability: "fill_form",
    summary: "Fill a known PDF form (passport, tax, HR…) from your records — friendly keys → real fields, checkboxes/radios, splits. Optionally sign + flatten.",
    kinds: PDF,
    params: [
      { name: "form", type: "string", description: "Supported form id, e.g. ds11, f1040, or f1040@2024 (see form_list / the PDF Fill catalog). Omit to fill raw `fields` directly." },
      { name: "records", type: "string", description: "Path to your records: a people.yaml, a records/ directory, or a .csv (one row per record, column headers as field keys — a vendor/staff/client export works as-is). Provides values by role. Alias: people." },
      { name: "people", type: "string", description: "Alias for `records` — the people.yaml holding your persons." },
      { name: "person", type: "string", description: "Which person id fills the form's primary role (applicant/patient)." },
      { name: "roles", type: "object", description: "Optional role → person-id map for forms needing others, e.g. { spouse: bob, patient: p123 }." },
      { name: "values", type: "object", description: "Explicit friendly field values (override the person); use for form-specific fields like applying_for." },
      { name: "fields", type: "object", description: "Advanced: raw AcroForm field values by real field name — bypasses the form registry." },
      { name: "signature", type: "object", description: "Embed a signature image: { image, field? | rect?, page? }. A visible image over a signature line (not a digital signature)." },
      { name: "flatten", type: "boolean", description: "Bake the filled values into the page → a locked, print-ready final PDF (non-editable)." },
      { name: "preview", type: "boolean", description: "Dry run: write a report of what WOULD be filled (field · value · source) and render no PDF." },
      { name: "to", type: "string", description: "Output path for the preview report (default output/form-fill-preview.md; only used with preview)." },
    ],
    aliases: ["fill_pdf_form"],
  },
  create_form: {
    name: "create_form",
    capability: "create_form",
    summary:
      "Turn a template into a FILLABLE PDF: find each [[tag]] you typed in the DOCX/Markdown/HTML, delete the tag, and put a real form field (text, checkbox, dropdown, signature) in its place. Put a conversion op before it.",
    kinds: PDF,
    params: [
      { name: "fields_file", type: "string", description: "Path to the field-config YAML, relative to the workflow. Omit BOTH this and `fields` for zero-config mode: every [[tag]] becomes a text field. Alias: from." },
      { name: "from", type: "string", description: "Alias for `fields_file`." },
      { name: "fields", type: "object", description: "Inline field config keyed by tag: { employee_name: { type: text, width: 220 }, agree: { type: checkbox } }. A bare string ('text') is shorthand for the type. Merged over `fields_file` per key (inline wins)." },
      { name: "style", type: "object", description: "Look of every created field: { border, fill, border_width, font, font_size, text_color }. Colors are #RRGGBB. font must be one of Helv/TiRo/Cour/ZaDb; font_size 0 = auto-fit (default)." },
      { name: "tag", type: "string", description: 'Marker syntax (default "[[key]]"). Must contain the literal token `key`; the rest matches verbatim, e.g. "<<key>>".' },
      { name: "strict", type: "boolean", description: "Default true: fail the run if a declared tag is missing from the converted PDF, an undeclared tag appears, or a tag is duplicated. false downgrades these to warnings." },
      { name: "preview", type: "boolean", description: "Dry run: write the field-map report showing what WOULD be created (and what's missing) and render NO PDF." },
      { name: "to", type: "string", description: "Path for the field-map report (default output/form-map.json). Supports {stem}/{name}/{i} for batch." },
      { name: "debug", type: "boolean", description: "Also write a copy with every field's rect outlined and labelled, so you can see where the fields landed." },
      { name: "debug_to", type: "string", description: "Path for the debug overlay (default output/form-debug.pdf; only with debug). Supports {stem}/{name}/{i}." },
      { name: "keep_tags", type: "boolean", description: "Leave the [[tag]] text on the page instead of deleting it. Debugging only — the marker shows through the field." },
    ],
    aliases: ["make_fillable", "add_form_fields"],
  },
  extract_form: {
    name: "extract_form",
    capability: "extract_form",
    summary: "Read filled forms back out to JSON + CSV — the inverse of fill_form. One file or a whole folder; re-runs only pick up what's new.",
    kinds: PDF,
    params: [
      { name: "form", type: "string", description: "Supported form id, e.g. w9, ds11. Omit to auto-detect each PDF from its field signature." },
      { name: "to", type: "string", description: "Destination folder for the extracted data (default output/extracted)." },
      { name: "format", type: "string", description: "both (default) | json | csv. `both` writes per-form JSON, a combined forms.json, and a combined forms.csv." },
      { name: "resume", type: "boolean", description: "Default true: skip inputs already extracted with identical content, and merge the new ones into the existing table. Set false to re-extract everything." },
      { name: "include_empty", type: "boolean", description: "Include mapped fields the form left blank (as empty columns) instead of omitting them." },
    ],
    aliases: ["form_to_json", "extract_form_data"],
    emitsFiles: true,
    consumesAllInputs: true,
  },
  extract_receipt: {
    name: "extract_receipt",
    capability: "extract_receipt",
    summary:
      "Read receipts/invoices as images with a vision-language model (Qwen3-VL, served over an OpenAI-compatible endpoint) and extract structured fields — merchant, date, totals, tax, currency, line items — to JSON + CSV. For scans/photos where there is no reliable text layer.",
    kinds: PDF,
    params: [
      {
        name: "to",
        type: "string",
        description: "Destination folder for the extracted data (default output/receipts) when `output.folder` is not set. Writes per-input JSON, a combined receipts.json, and a flattened receipts.csv.",
      },
      {
        name: "endpoint",
        type: "string",
        description:
          'OpenAI-compatible chat/completions base URL of the VLM server, e.g. "http://gpu:8801/v1" (vLLM) or "http://localhost:11434/v1" (Ollama). Defaults to $PDFSTUDIO_VLM_ENDPOINT. Sends page images off-box, so it requires the pdfStudio.allowRemoteRender setting.',
      },
      {
        name: "model",
        type: "string",
        description: 'Model name to request, e.g. "qwen3-vl-8b" or the fine-tuned "qwen3-vl-8b-receipts". Defaults to $PDFSTUDIO_VLM_MODEL.',
      },
      {
        name: "schema",
        type: "string",
        enum: ["receipt", "invoice"],
        description: "Target field schema (default receipt). invoice additionally extracts po_number, bill_to, terms, and due_date.",
      },
      {
        name: "format",
        type: "string",
        enum: ["both", "json", "csv"],
        description: "both (default) writes per-input JSON, a combined receipts.json, and a combined receipts.csv. json / csv write only that form.",
      },
      {
        name: "line_items",
        type: "boolean",
        description: "Extract per-line-item rows (description, qty, unit_price, amount). Default true. When false, only receipt-level totals are captured.",
      },
      {
        name: "dpi",
        type: "number",
        min: 72,
        max: 400,
        description: "Rasterization DPI for each page before it is sent to the model (default 200). Higher is sharper but slower and larger.",
      },
      {
        name: "page_range",
        type: "string",
        description: 'Pages to process, e.g. "1-3,7". Omit for all pages. Each page is treated as one receipt image.',
      },
      {
        name: "currency_hint",
        type: "string",
        description: 'ISO 4217 currency to assume when the receipt is ambiguous, e.g. "USD". Omit to let the model infer it.',
      },
      {
        name: "resume",
        type: "boolean",
        description: "Default true: skip inputs already extracted with identical content and merge new ones into the existing table. Set false to re-extract everything.",
      },
    ],
    aliases: ["receipt_extract", "extract_receipts"],
    emitsFiles: true,
    consumesAllInputs: true,
  },
  flatten: {
    name: "flatten",
    capability: "flatten",
    summary: "Bake form fields + annotations into static page content.",
    kinds: PDF,
    params: [],
  },
  encrypt: {
    name: "encrypt",
    capability: "encrypt",
    summary: "Password-protect the PDF with AES-256. Put this last.",
    kinds: PDF,
    params: [
      { name: "user_password", type: "string", description: "Password required to open the PDF." },
      { name: "owner_password", type: "string", description: "Owner/permissions password (defaults to user_password)." },
    ],
  },
  decrypt: {
    name: "decrypt",
    capability: "decrypt",
    summary: "Remove password protection — supply the current password. Put this first.",
    kinds: PDF,
    params: [
      { name: "password", type: "string", description: "Current password needed to open the PDF." },
    ],
  },
  linearize: {
    name: "linearize",
    capability: "linearize",
    summary: 'Linearize ("fast web view") for progressive loading. Put this last.',
    kinds: PDF,
    params: [],
  },
  crop: {
    name: "crop",
    capability: "crop",
    summary: "Crop pages to a rectangle (points, origin bottom-left).",
    kinds: PDF,
    params: [
      { name: "box", type: "number[]", required: true, description: "Crop rectangle [x, y, width, height] in points." },
      { name: "pages", type: "pages", description: "1-based pages to crop (default all)." },
    ],
  },
  scale_pages: {
    name: "scale_pages",
    capability: "scale_pages",
    summary: "Resize pages to a target size (A4/Letter/Legal) or by a scale factor.",
    kinds: PDF,
    params: [
      { name: "size", type: "string", enum: ["A4", "Letter", "Legal"], description: "Target page size (content scaled to fit)." },
      { name: "factor", type: "number", description: "Scale factor (e.g. 0.5) — used when size is omitted.", min: 0.05, max: 10 },
    ],
  },
  add_page_numbers: {
    name: "add_page_numbers",
    capability: "add_page_numbers",
    summary: "Stamp page numbers onto every page.",
    kinds: PDF,
    params: [
      { name: "format", type: "string", description: 'Template with {n} and {total} (default "{n} / {total}").' },
      { name: "position", type: "string", enum: ["bottom-center", "bottom-left", "bottom-right", "top-center", "top-left", "top-right"], description: "Where to place the number." },
      { name: "start", type: "number", description: "First page's number (default 1)." },
      { name: "size", type: "number", description: "Font size in points (default 10).", min: 4, max: 96 },
    ],
  },
  header_footer: {
    name: "header_footer",
    capability: "header_footer",
    summary:
      "Add running headers and/or footers — up to six text slots (top & bottom × left/center/right) — with page-number, date and legal Bates-number tokens. For continuous Bates numbering across many files, `merge` them first.",
    kinds: PDF,
    params: [
      {
        name: "header",
        type: "object",
        description:
          'Top-of-page text by slot: { left, center, right }. Each value is a template that may use tokens {n} (page number), {total} (page count), {date} (from the `date` param), and {bates} (when `bates` is set).',
      },
      {
        name: "footer",
        type: "object",
        description:
          "Bottom-of-page text by slot: { left, center, right }. Same tokens as `header`. If `bates` is set and no slot uses {bates}, the Bates number is auto-placed in footer.right.",
      },
      {
        name: "bates",
        type: "object",
        description:
          'Configure the {bates} legal Bates-numbering token: { start (default 1), digits (zero-pad width, default 6), prefix, suffix }. E.g. { prefix: "ACME", start: 1 } → ACME000001, ACME000002, …',
      },
      {
        name: "date",
        type: "string",
        description:
          "Value substituted for the {date} token. Supplied explicitly (not the wall-clock) so the render stays deterministic and content-hashable — pass e.g. \"2026-07-25\".",
      },
      {
        name: "start",
        type: "number",
        description: "First page's {n} value (default 1).",
      },
      {
        name: "pages",
        type: "pages",
        description: "1-based pages to stamp. Omit for all pages ({n}/{bates} still count from the physical page, so a filter doesn't renumber).",
      },
      {
        name: "font",
        type: "string",
        enum: ["Helv", "TiRo", "Cour"],
        description: "Font: Helv (Helvetica, default), TiRo (Times), or Cour (Courier).",
      },
      {
        name: "size",
        type: "number",
        description: "Font size in points (default 9).",
        min: 4,
        max: 96,
      },
      {
        name: "margin",
        type: "number",
        description: "Inset from the page edge in points, applied on all sides (default 36 = 0.5in).",
        min: 0,
        max: 300,
      },
      {
        name: "color",
        type: "string",
        description: 'Text color as "#RRGGBB" (default a medium gray, #4D4D4D).',
      },
    ],
    aliases: ["header", "footer", "bates_number", "bates"],
  },
  stamp: {
    name: "stamp",
    capability: "stamp",
    summary: "Stamp positioned text or an image onto pages (watermark is the diagonal variant).",
    kinds: PDF,
    params: [
      { name: "text", type: "string", description: "Text to stamp (omit if using image)." },
      { name: "image", type: "string", description: "Asset name of an image to stamp (omit if using text)." },
      { name: "x", type: "number", description: "X in points from bottom-left (default 36)." },
      { name: "y", type: "number", description: "Y in points from bottom-left (default 36)." },
      { name: "size", type: "number", description: "Text font size (default 24).", min: 4, max: 288 },
      { name: "width", type: "number", description: "Image width in points (image is scaled to keep aspect)." },
      { name: "opacity", type: "number", description: "0-1 (default 1).", min: 0, max: 1 },
      { name: "pages", type: "pages", description: "1-based pages (default all)." },
    ],
  },
  n_up: {
    name: "n_up",
    capability: "n_up",
    summary: "Place multiple source pages onto each output page in a grid (N-up).",
    kinds: PDF,
    changesPagination: true,
    params: [
      { name: "cols", type: "number", required: true, description: "Columns per output page.", min: 1, max: 8 },
      { name: "rows", type: "number", required: true, description: "Rows per output page.", min: 1, max: 8 },
    ],
  },
  overlay: {
    name: "overlay",
    capability: "overlay",
    summary: "Overlay another PDF's pages on top of the current document.",
    kinds: PDF,
    params: [
      { name: "over", type: "string", required: true, description: "Asset name of the overlay PDF." },
      { name: "opacity", type: "number", description: "0-1 (default 1).", min: 0, max: 1 },
    ],
  },
  images_to_pdf: {
    name: "images_to_pdf",
    capability: "images_to_pdf",
    summary: "Build a PDF from image inputs (one page per image). PNG/JPEG run on the bundled engine; WEBP/TIFF/GIF/BMP/SVG/PSD need the Python backend, and HEIC (iPhone photos) also needs pillow-heif.",
    kinds: PDF,
    changesPagination: true,
    // Every extension listed here is one `merge` will accept in a mixed input list, so the
    // set must match what the backend can ACTUALLY decode — SVG/HEIC/PSD were advertised in
    // the summary but missing here, which made them unreachable through merge.
    inputExtensions: [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".svg", ".heic", ".heif", ".psd"],
    params: [],
  },
  render_pages: {
    name: "render_pages",
    capability: "render_pages",
    summary:
      "Render pages to images — raster (PNG/JPG) or vector (SVG). This makes a picture OF each page; extract_images pulls the images embedded IN it.",
    kinds: PDF,
    params: [
      { name: "to", type: "string", description: "Output directory for the images (default output/pages)." },
      { name: "dpi", type: "number", description: "Resolution in DPI (default 150).", min: 36, max: 600 },
      { name: "format", type: "string", enum: ["png", "jpg", "svg"], description: "Image format (default png). svg = vector (infinite zoom, tiny files, no DPI)." },
      { name: "pages", type: "pages", description: "1-based pages to render. Omit for every page — use this for a cover thumbnail instead of rendering all 400." },
      { name: "transparent", type: "boolean", description: "PNG only: keep the page background transparent instead of painting it white, so the result composites over other artwork (logos, stamps, signature blocks)." },
      { name: "name", type: "string", description: 'Filename template without the extension — tokens {stem} {i} {page}, zero-padded as {i:03}. Default page_1.png … which sorts page_10 before page_2; use "{stem}-{i:03}" to keep them in order.' },
      { name: "text_as_path", type: "boolean", description: "SVG only: draw glyphs as paths (default true, exact without the font) vs. selectable <text>." },
    ],
  },
  pdf_to_png: {
    name: "pdf_to_png",
    capability: "render_pages",
    summary: "Convert a PDF to PNG images — one file per page. A preset of render_pages; use that for SVG or a mixed format choice.",
    kinds: PDF,
    params: [
      { name: "to", type: "string", description: "Output directory for the images (default output/pages)." },
      { name: "dpi", type: "number", description: "Resolution in DPI (default 150). 300 for print, 72 for a web thumbnail.", min: 36, max: 600 },
      { name: "pages", type: "pages", description: "1-based pages to convert. Omit for every page." },
      { name: "transparent", type: "boolean", description: "Keep the page background transparent instead of painting it white." },
      { name: "name", type: "string", description: 'Filename template without the extension — tokens {stem} {i} {page}, zero-padded as {i:03}.' },
    ],
  },
  pdf_to_jpg: {
    name: "pdf_to_jpg",
    capability: "render_pages",
    summary: "Convert a PDF to JPG images — one file per page. A preset of render_pages; JPG is smaller than PNG for photos and scans, but cannot be transparent.",
    kinds: PDF,
    aliases: ["pdf_to_jpeg"],
    params: [
      { name: "to", type: "string", description: "Output directory for the images (default output/pages)." },
      { name: "dpi", type: "number", description: "Resolution in DPI (default 150).", min: 36, max: 600 },
      { name: "pages", type: "pages", description: "1-based pages to convert. Omit for every page." },
      { name: "name", type: "string", description: 'Filename template without the extension — tokens {stem} {i} {page}, zero-padded as {i:03}.' },
    ],
  },
  remove_blank_pages: {
    name: "remove_blank_pages",
    capability: "remove_blank_pages",
    summary: "Detect and delete blank pages.",
    kinds: PDF,
    changesPagination: true,
    params: [],
  },
  remove_annotations: {
    name: "remove_annotations",
    capability: "remove_annotations",
    summary: "Remove all annotations (comments, highlights, links markup).",
    kinds: PDF,
    params: [],
  },
  remove_images: {
    name: "remove_images",
    capability: "remove_images",
    summary: "Remove all images from the document.",
    kinds: PDF,
    params: [],
  },
  sanitize: {
    name: "sanitize",
    capability: "sanitize",
    summary: "Strip JavaScript, embedded files, metadata, and links.",
    kinds: PDF,
    params: [],
  },
  auto_redact: {
    name: "auto_redact",
    capability: "auto_redact",
    summary: "Find and permanently redact matching text — literal strings, regexes, or PII presets (ssn/email/phone/…).",
    kinds: PDF,
    params: [
      { name: "text", type: "string[]", description: "One or more literal strings to find and permanently black out (e.g. a name, an account number, an address). At least one of text/regex/patterns is required." },
      { name: "patterns", type: "string[]", description: "Named PII presets to match by shape: ssn, email, phone, credit_card, ein, ipv4, iban. Heuristics — always confirm with preview first." },
      { name: "regex", type: "string[]", description: "Custom regular expression(s) to match (advanced; e.g. a specific account-number format)." },
      { name: "ignore_case", type: "boolean", description: "Case-insensitive matching (default false). Aliased as case_insensitive." },
      { name: "whole_word", type: "boolean", description: "Match only whole words, so \"Ann\" does not hit \"Anniversary\" (default false)." },
      { name: "preview", type: "boolean", description: "Dry run: write a report of what WOULD be redacted (page + matched text + rule) and change NOTHING. Aliased as dry_run. Review it, then remove preview to apply." },
      { name: "to", type: "string", description: "Output path for the preview report (default output/redaction-preview.md). Only used when preview is set." },
      { name: "rasterize", type: "boolean", description: "After redacting, flatten the WHOLE document to an image-only PDF so nothing hidden (text layer, metadata, off-page content) can survive. Output is not selectable/searchable." },
      { name: "dpi", type: "number", description: "Resolution when rasterize is set (default 150).", min: 36, max: 600 },
    ],
  },
  set_bookmarks: {
    name: "set_bookmarks",
    capability: "set_bookmarks",
    summary: "Replace the outline/bookmarks with a given list.",
    kinds: PDF,
    params: [
      { name: "bookmarks", type: "object", required: true, description: "List of { level, title, page } (1-based page)." },
    ],
  },
  extract_bookmarks: {
    name: "extract_bookmarks",
    capability: "extract_bookmarks",
    summary: "Export the outline/bookmarks as JSON.",
    kinds: PDF,
    params: [
      { name: "to", type: "string", description: "Output path (default output/bookmarks.json)." },
    ],
  },
  extract_attachments: {
    name: "extract_attachments",
    capability: "extract_attachments",
    summary: "Extract embedded file attachments.",
    kinds: PDF,
    params: [
      { name: "to", type: "string", description: "Output directory (default output/attachments)." },
    ],
  },
  extract_links: {
    name: "extract_links",
    capability: "extract_links",
    summary:
      "Extract every hyperlink/URL — clickable link annotations (URL, page, anchor text) plus, by default, bare URLs printed in the page text — to JSON + CSV. Point `inputs` at one PDF or a whole folder (docs/*.pdf → one combined table with a source-file column). Read-only.",
    kinds: PDF,
    params: [
      { name: "to", type: "string", description: "Destination folder for the extracted links (default output/links). Writes links.json and links.csv." },
      { name: "format", type: "string", enum: ["both", "json", "csv"], description: "both (default) writes links.json + links.csv; json / csv writes only that one." },
      { name: "types", type: "string[]", description: 'Which link kinds to include: uri (external web/mailto links — the default), goto (internal jump-to-page), launch (open a file), named (named destination), gotor (remote-file page), or all. Default ["uri"].' },
      { name: "include_text_urls", type: "boolean", description: "Also capture bare URLs written in the page text that were never made clickable (regex-detected: http/https/ftp/www). Default true. Only applies when uri/all is in `types`." },
      { name: "dedupe", type: "boolean", description: "Collapse the output to unique links (first occurrence kept) instead of one row per occurrence (default false)." },
    ],
    aliases: ["extract_urls", "extract_hyperlinks", "list_links"],
    // Emits its own links.json/links.csv to `to`, so `output.file` is optional.
    emitsFiles: true,
    // A folder glob folds ALL matched PDFs into ONE combined links table (with a
    // source-file column), like extract_form — it is not batched per file.
    consumesAllInputs: true,
  },
  extract_annotations: {
    name: "extract_annotations",
    capability: "extract_annotations",
    summary:
      "Extract every markup/comment annotation — sticky notes, highlights, underlines, strikeouts, free text, shapes, ink and stamps — with author, comment text, the text a markup covers, color, rectangle and dates, to JSON + CSV. Point `inputs` at one PDF or a whole folder (docs/*.pdf → one combined table with a source-file column). Read-only. (Hyperlinks → extract_links; form fields → extract_fields.)",
    kinds: PDF,
    params: [
      { name: "to", type: "string", description: "Destination folder for the extracted annotations (default output/annotations). Writes annotations.json and annotations.csv." },
      { name: "format", type: "string", enum: ["both", "json", "csv"], description: "both (default) writes annotations.json + annotations.csv; json / csv writes only that one." },
      { name: "types", type: "string[]", description: 'Which annotation kinds to include — by exact type (highlight, underline, strikeout, squiggly, text, freetext, square, circle, line, polygon, polyline, ink, stamp, caret, fileattachment) OR by category (markup, text, shape, stamp), or all. Default ["all"]. Hyperlinks, form-field widgets and popups are always excluded.' },
      { name: "include_text", type: "boolean", description: "For markup annotations (highlight/underline/strikeout/squiggly), also capture the underlying page text they cover (default true)." },
    ],
    aliases: ["extract_comments", "extract_markup"],
    // Emits its own annotations.json/annotations.csv to `to`, so `output.file` is optional.
    emitsFiles: true,
    // A folder glob folds ALL matched PDFs into ONE combined table (with a source-file
    // column), like extract_links — it is not batched per file.
    consumesAllInputs: true,
  },
  add_links: {
    name: "add_links",
    capability: "add_links",
    summary:
      "Make URLs clickable and add explicit links — the inverse of extract_links. By default it auto-detects bare URLs printed in the page text (http/https/ftp/www) that were never made clickable and lays a link over each. Also add explicit links by text search: link a phrase to a URL, or to another page (goto).",
    kinds: PDF,
    params: [
      { name: "auto", type: "boolean", description: "Auto-detect bare URLs in the page text and make them clickable (default true). Set false to add only the explicit `links`." },
      { name: "links", type: "object", description: 'Explicit links to add, each placed over every match of a searched phrase: [{ find: "Appendix A", goto: 12 }, { find: "our site", url: "https://example.com", pages: [1] }]. `url` makes an external link; `goto` (1-based page) makes an internal jump; `pages` limits the search (default all).' },
      { name: "pages", type: "pages", description: "1-based pages to auto-linkify. Omit for all pages (does not affect explicit `links`, which use their own `pages`)." },
    ],
    aliases: ["linkify", "make_links"],
  },
  add_attachments: {
    name: "add_attachments",
    capability: "add_attachments",
    summary: "Embed a file as an attachment.",
    kinds: PDF,
    params: [
      { name: "file", type: "string", required: true, description: "Path (workflow-relative) of the file to attach." },
      { name: "name", type: "string", description: "Attachment name (default the file's basename)." },
    ],
  },
  extract_fields: {
    name: "extract_fields",
    capability: "extract_fields",
    summary: "Export form fields (page/name/type/value) to CSV.",
    kinds: PDF,
    params: [
      { name: "to", type: "string", description: "Output CSV path (default output/fields.csv)." },
    ],
  },
  extract_tables: {
    name: "extract_tables",
    capability: "extract_tables",
    summary: "Detect tables and export each as CSV.",
    kinds: PDF,
    params: [
      { name: "to", type: "string", description: "Output directory (default output/tables)." },
    ],
  },
  repair: {
    name: "repair",
    capability: "repair",
    summary: "Repair / rewrite a structurally-broken PDF.",
    kinds: PDF,
    params: [],
  },
  decompress: {
    name: "decompress",
    capability: "decompress",
    summary: "Uncompress content streams (readable/debuggable PDF).",
    kinds: PDF,
    params: [],
  },
  set_permissions: {
    name: "set_permissions",
    capability: "set_permissions",
    summary: "Restrict permissions (print/copy/modify) via an owner password.",
    kinds: PDF,
    params: [
      { name: "owner_password", type: "string", description: "Owner password that can lift the restrictions." },
      { name: "allow", type: "object", description: "Flags: { print, copy, modify, annotate, fill_form, assemble } (default all true)." },
    ],
  },
  set_view_preferences: {
    name: "set_view_preferences",
    capability: "set_view_preferences",
    summary: "Control how a PDF opens in a reader — page layout, full-screen/outline mode, initial page & zoom, and window chrome.",
    kinds: PDF,
    params: [
      { name: "page_layout", type: "string", enum: ["SinglePage", "OneColumn", "TwoColumnLeft", "TwoColumnRight", "TwoPageLeft", "TwoPageRight"], description: "How pages are laid out on open (e.g. TwoPageLeft for a book spread)." },
      { name: "page_mode", type: "string", enum: ["UseNone", "UseOutlines", "UseThumbs", "FullScreen", "UseOC", "UseAttachments"], description: "Panel/mode on open (e.g. FullScreen for a presentation, UseOutlines to show bookmarks)." },
      { name: "open_page", type: "number", description: "1-based page the document opens at.", min: 1 },
      { name: "zoom", type: "string", description: '"fit" (default), "fit-width", or a percent like "150".' },
      { name: "hide_toolbar", type: "boolean", description: "Hide the reader's toolbar." },
      { name: "hide_menubar", type: "boolean", description: "Hide the reader's menu bar." },
      { name: "hide_window_ui", type: "boolean", description: "Hide scrollbars/nav controls." },
      { name: "fit_window", type: "boolean", description: "Resize the window to the first page." },
      { name: "center_window", type: "boolean", description: "Center the window on screen." },
      { name: "display_doc_title", type: "boolean", description: "Show the document title (not the filename) in the title bar." },
    ],
  },
  unlock_forms: {
    name: "unlock_forms",
    capability: "unlock_forms",
    summary: "Clear the read-only flag on form fields so they can be filled.",
    kinds: PDF,
    params: [],
  },
  pdf_to_pdfa: {
    name: "pdf_to_pdfa",
    capability: "pdf_to_pdfa",
    summary: "Convert to PDF/A for archival.",
    kinds: PDF,
    params: [],
  },
  rasterize: {
    name: "rasterize",
    capability: "rasterize",
    summary: "Flatten every page to a raster image (non-editable, non-selectable).",
    kinds: PDF,
    params: [
      { name: "dpi", type: "number", description: "Raster resolution (default 150).", min: 36, max: 600 },
    ],
  },
  booklet: {
    name: "booklet",
    capability: "booklet",
    summary: "Impose pages 2-up in saddle-stitch booklet order for folded printing.",
    kinds: PDF,
    changesPagination: true,
    params: [],
  },
  poster: {
    name: "poster",
    capability: "poster",
    summary: "Split each page into a grid of tiles for large-format/poster printing.",
    kinds: PDF,
    changesPagination: true,
    params: [
      { name: "rows", type: "number", description: "Tile rows per page (default 2).", min: 1, max: 10 },
      { name: "cols", type: "number", description: "Tile columns per page (default 2).", min: 1, max: 10 },
    ],
  },
  html_to_pdf: {
    name: "html_to_pdf",
    capability: "html_to_pdf",
    summary: "Render an HTML file to PDF (uses a system Chrome/Edge for high fidelity when present).",
    kinds: PDF,
    changesPagination: true,
    perInputCreator: true,
    inputExtensions: [".html", ".htm"],
    params: [
      { name: "engine", type: "string", enum: ["auto", "chrome", "weasyprint", "story"], description: "Render engine. auto = system Chrome/Edge if found, else WeasyPrint, else PyMuPDF." },
    ],
  },
  markdown_to_pdf: {
    name: "markdown_to_pdf",
    capability: "markdown_to_pdf",
    summary: "Render a Markdown file to a styled PDF (Markdown → themed HTML → PDF).",
    kinds: PDF,
    changesPagination: true,
    perInputCreator: true,
    inputExtensions: [".md", ".markdown"],
    params: [
      { name: "engine", type: "string", enum: ["auto", "chrome", "weasyprint", "story"], description: "Render engine. auto = system Chrome/Edge if found, else WeasyPrint, else PyMuPDF." },
    ],
  },
  url_to_pdf: {
    name: "url_to_pdf",
    capability: "url_to_pdf",
    summary: "Fetch a web page and render it to PDF (uses a system Chrome/Edge when present; use inputs: [] and a url param).",
    kinds: PDF,
    changesPagination: true,
    params: [
      { name: "url", type: "string", required: true, description: "http(s) URL to fetch and render." },
      { name: "engine", type: "string", enum: ["auto", "chrome", "weasyprint", "story"], description: "Render engine. auto = system Chrome/Edge if found, else WeasyPrint, else fetch+PyMuPDF." },
    ],
  },
  eml_to_pdf: {
    name: "eml_to_pdf",
    capability: "eml_to_pdf",
    summary: "Render an .eml email (headers + body) to a styled PDF. Remote images are blocked by default (email is untrusted); no tracking pixels.",
    kinds: PDF,
    changesPagination: true,
    perInputCreator: true,
    inputExtensions: [".eml"],
    params: [
      { name: "engine", type: "string", enum: ["auto", "chrome", "weasyprint", "story"], description: "Render engine. auto = system Chrome/Edge if found, else WeasyPrint, else PyMuPDF." },
      { name: "load_remote_images", type: "boolean", description: "Load remote images/resources referenced by the email (default false — blocked to avoid tracking pixels). Enable only for a sender you trust." },
    ],
  },
  office_to_pdf: {
    name: "office_to_pdf",
    capability: "office_to_pdf",
    summary: "Convert an Office document (docx/xlsx/pptx/odt) to PDF. Requires LibreOffice.",
    kinds: PDF,
    changesPagination: true,
    perInputCreator: true,
    inputExtensions: [".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp", ".rtf", ".doc", ".xls", ".ppt"],
    params: [
      { name: "from", type: "string", enum: ["docx", "xlsx", "pptx", "odt", "ods", "odp", "rtf", "doc", "xls", "ppt"], description: "Source format / extension (default docx)." },
    ],
  },
  video_to_pdf: {
    name: "video_to_pdf",
    capability: "video_to_pdf",
    summary:
      "Turn a video into a PDF — one page per sampled frame, with a burned-in timestamp. Follow with n_up for a contact sheet. Requires ffmpeg.",
    kinds: PDF,
    changesPagination: true,
    perInputCreator: true,
    inputExtensions: [".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".mpg", ".mpeg"],
    aliases: ["contact_sheet", "storyboard"],
    params: [
      { name: "every", type: "number", description: "Seconds between sampled frames (default 30). Lower it for a short clip, raise it for a long recording.", min: 0.1 },
      { name: "max_frames", type: "number", description: "Hard cap on frames (default 200), so a three-hour recording at every: 1 can't quietly produce ten thousand pages.", min: 1 },
      { name: "width", type: "number", description: "Frame width in pixels (default 1280); the height follows the aspect ratio.", min: 64 },
      { name: "timestamps", type: "boolean", description: "Burn the source time (m:ss) into the corner of each frame (default true) — that's what makes it reviewable." },
    ],
  },
  pdf_to_docx: {
    name: "pdf_to_docx",
    capability: "pdf_to_docx",
    summary: "Convert a PDF to a Word document (fidelity varies).",
    kinds: PDF,
    params: [
      { name: "to", type: "string", description: "Output path (default output/converted.docx)." },
    ],
  },
  pdf_to_pptx: {
    name: "pdf_to_pptx",
    capability: "pdf_to_pptx",
    summary: "Convert a PDF to a PowerPoint presentation (fidelity varies).",
    kinds: PDF,
    params: [
      { name: "to", type: "string", description: "Output path (default output/converted.pptx)." },
    ],
  },
  pdf_to_xlsx: {
    name: "pdf_to_xlsx",
    capability: "pdf_to_xlsx",
    summary: "Convert a PDF to an Excel spreadsheet (fidelity varies).",
    kinds: PDF,
    params: [
      { name: "to", type: "string", description: "Output path (default output/converted.xlsx)." },
    ],
  },
  pdf_to_html: {
    name: "pdf_to_html",
    capability: "pdf_to_html",
    summary: "Convert a PDF to an HTML document (fidelity varies).",
    kinds: PDF,
    params: [
      { name: "to", type: "string", description: "Output path (default output/converted.html)." },
    ],
  },
  epub_to_pdf: {
    name: "epub_to_pdf",
    capability: "epub_to_pdf",
    summary: "Convert an EPUB ebook to PDF. Bundled PyMuPDF renders it by default; Calibre (engine: calibre) paginates better when installed.",
    kinds: PDF,
    changesPagination: true,
    perInputCreator: true,
    inputExtensions: [".epub"],
    aliases: ["ebook_to_pdf"],
    params: [
      { name: "engine", type: "string", enum: ["auto", "pymupdf", "calibre"], description: "auto/pymupdf uses the bundled engine; calibre uses ebook-convert (better pagination) if installed." },
      { name: "paper_size", type: "string", description: "Calibre only: page size, e.g. \"a4\" or \"letter\"." },
    ],
  },
  pdf_to_epub: {
    name: "pdf_to_epub",
    capability: "pdf_to_epub",
    summary: "Convert a PDF to a reflowable EPUB ebook (for Kindle / e-readers). Uses Calibre when installed, else a bundled text-to-EPUB builder.",
    kinds: PDF,
    aliases: ["pdf_to_ebook"],
    params: [
      { name: "to", type: "string", description: "Output path for the .epub (default output/book.epub)." },
      { name: "title", type: "string", description: "Ebook title (default: the PDF's title metadata or filename)." },
      { name: "author", type: "string", description: "Ebook author (default: the PDF's author metadata)." },
      { name: "engine", type: "string", enum: ["auto", "calibre", "pymupdf"], description: "auto (Calibre if present, else pymupdf) · calibre (best reflow; needs Calibre's ebook-convert) · pymupdf (bundled, text-only)." },
      { name: "chapter_pages", type: "number", description: "Pages per chapter when the PDF has no outline (pymupdf engine; default 10).", min: 1 },
    ],
  },
  pdf_to_markdown: {
    name: "pdf_to_markdown",
    capability: "extract_markdown",
    summary: "Convert a PDF to a Markdown (.md) file — tables included (pymupdf4llm/markitdown improve quality).",
    kinds: PDF,
    aliases: ["pdf_to_md"],
    params: [
      { name: "to", type: "string", description: "Output path for the Markdown file (default output/document.md)." },
      {
        name: "engine",
        type: "string",
        enum: ["auto", "pymupdf4llm", "markitdown", "marker", "paddleocr-vl", "mineru"],
        description: "Markdown engine. auto (default) prefers pymupdf4llm, then markitdown, then a PyMuPDF fallback. marker uses Surya OCR + layout models (best for scans; slow, needs marker-pdf). paddleocr-vl runs Baidu's 0.9B PaddleOCR-VL doc-parsing model locally (CPU-capable, strong on scans/tables/formulas; runs in its own venv via $PDFSTUDIO_PADDLE_PYTHON). mineru runs the MinerU 2.5-Pro VLM locally — the best table/form structure (real HTML tables), CPU-capable but slow (~minutes/page, best for a few pages); its own venv via $PDFSTUDIO_MINERU_PYTHON. See docs/python-setup.md.",
      },
      { name: "ocr", type: "string", enum: ["off", "auto", "force"], description: "OCR control: off = text-layer only; auto (default) = OCR only when the doc lacks a usable text layer (keeps existing text — never destroys it); force = re-OCR everything (lossy). For the marker engine this maps to marker's own force_ocr; for other engines it's an OCRmyPDF pre-pass." },
      { name: "ocr_first", type: "boolean", description: "Deprecated alias for `ocr: force` — rebuild a clean text layer with OCR before extracting. Prefer `ocr`." },
      { name: "margins", type: "number", min: 0, description: "Clip this many points off the top AND bottom of every page before extracting — strips running headers, footers, and page numbers (pymupdf4llm engine)." },
      { name: "lang", type: "string", description: "OCR language(s) for the ocr pre-pass, e.g. \"eng\" or \"eng+fra\" (default eng)." },
      { name: "remote", type: "string", description: "Run Marker on a remote GPU box over SSH (\"user@host\", key-based auth). Requires the pdfStudio.allowRemoteRender setting. Marker is auto-installed on the box on first use; the PDF is uploaded, converted on the GPU, and the Markdown returned." },
      { name: "endpoint", type: "string", description: "Run Marker via an HTTP service (POST multipart file + force_ocr → JSON {markdown}) instead of SSH. Chunked + resumable for large files. Requires pdfStudio.allowRemoteRender; egresses document bytes to the URL. Set `remote` OR `endpoint`, not both." },
    ],
  },
  pdf_info: {
    name: "pdf_info",
    capability: "pdf_info",
    summary: "Write a structured report of the PDF (pages, sizes, metadata, security, fonts, and text coverage) as JSON.",
    kinds: PDF,
    params: [
      { name: "to", type: "string", description: "Output path (default output/info.json)." },
    ],
    // A pure diagnostic: it writes the report to `to` and never changes the document, so a
    // workflow needs no `output` block (and produces no pass-through PDF).
    emitsFiles: true,
  },
  check_accessibility: {
    name: "check_accessibility",
    capability: "check_accessibility",
    summary:
      "Audit a PDF for accessibility (PDF/UA / Section 508 / WCAG) and write a pass/warn/fail report — checks a document title, a default language, a tag tree (StructTreeRoot), that the reader shows the title not the filename, image alt text, and form-field tooltips. Read-only; suggests the op to fix each gap.",
    kinds: PDF,
    params: [
      { name: "to", type: "string", description: "Output path for the report (default output/accessibility.json). With format: both the Markdown summary is written beside it as the same name with a .md extension." },
      { name: "format", type: "string", enum: ["json", "markdown", "both"], description: "json (default) writes the machine-readable report; markdown writes a human-readable checklist; both writes each." },
    ],
    aliases: ["accessibility_check", "a11y_check"],
    // A pure diagnostic: it writes the report to `to` and never changes the document, so a
    // workflow needs no `output` block.
    emitsFiles: true,
  },
  tag_pdf: {
    name: "tag_pdf",
    capability: "tag_pdf",
    summary:
      "Auto-tag an untagged PDF for accessibility: build a REAL structure tree (StructTreeRoot) with reading-order marked content so screen readers can navigate it. Text blocks become headings (H1–H3, inferred from font size) and paragraphs; image XObjects become tagged figures with alt text. Sets MarkInfo/Marked and, optionally, the document title and default language — turning a check_accessibility \"untagged\" fail into a pass. Best on text documents (single-column reading order); scan/image-only PDFs should be OCR'd first, and complex tables/lists are flattened to paragraphs. Needs the Python backend.",
    kinds: PDF,
    params: [
      { name: "title", type: "string", description: "Set the document title (/Info Title) and turn on DisplayDocTitle so the reader shows the title, not the filename — clears two more check_accessibility items in the same pass." },
      { name: "lang", type: "string", description: 'Set the default language (/Lang), a BCP-47 tag like "en-US" or "fr" — assistive tech needs it to read in the right voice. Same field set_language writes.' },
      { name: "alt", type: "string[]", description: "Alternative text for images, in reading order (first figure → first string, and so on). A figure with no supplied description gets a neutral placeholder and is reported as still needing real alt text." },
      { name: "force", type: "boolean", description: "Re-tag a PDF that is already tagged (default false skips it, so re-running is a safe no-op): strips the existing structure tree and marked content, then rebuilds from scratch." },
    ],
    aliases: ["autotag", "auto_tag", "add_tags"],
  },
  text_report: {
    name: "text_report",
    capability: "text_report",
    summary: "Diagnose text coverage and page stats before extracting/OCR'ing: per-page size, char and image counts, which pages are image-only vs blank vs oversized, scripts present, and a recommended workflow — so you OCR only the pages that need it, or skip OCR entirely.",
    kinds: PDF,
    params: [
      { name: "to", type: "string", description: "Output path for the report (default output/text_report.json). With format: both the Markdown summary is written beside it as the same name with a .md extension." },
      {
        name: "format",
        type: "string",
        enum: ["json", "markdown", "both"],
        description: "json (default) writes the machine-readable report; markdown writes a one-screen human summary (metrics table, suggested workflow, page-stats table); both writes each.",
      },
      {
        name: "detail",
        type: "string",
        enum: ["full", "summary"],
        description: "full (default) includes the per-page stats array (page, size, chars, images, class); summary keeps only the doc-level numbers and page lists — use it on very large documents.",
      },
      {
        name: "sample",
        type: "number",
        min: 0,
        description: "Analyze every Nth page only, for a fast estimate on a huge document (0 = every page, the default). Every count and list then describes the sampled pages and the report is marked as an estimate.",
      },
      {
        name: "min_image_px",
        type: "number",
        min: 1,
        description: "Minimum image side, in pixels, for an image to count as real content rather than a logo or rule (default 200). A text-less page with such an image is an OCR candidate; without one it is blank.",
      },
      {
        name: "oversize_pt",
        type: "number",
        min: 1,
        description: "Pages wider or taller than this many points are flagged oversized (default 5000) — they are rendering/OCR hazards and are excluded from image-only classification.",
      },
    ],
    // A pure diagnostic: the report written to `to` IS the output. No `output` block needed,
    // and no pointless pass-through copy of the input PDF.
    emitsFiles: true,
  },
  inspect_text: {
    name: "inspect_text",
    capability: "inspect_text",
    summary:
      "Map the exact text spans on each page — every span's text, bounding box, font, size, color and bold/italic — to a JSON (or Markdown) report. Read-only. It gives an agent the numbers it otherwise has to guess: the coordinates for a precise redact / crop / stamp / annotate / add_links, and the font/size/color a replace_text should match. Filter with terms and pages to keep the report small.",
    kinds: PDF,
    params: [
      { name: "to", type: "string", description: "Output path for the report (default output/text-spans.json). With format: both the Markdown table is written beside it as the same name with a .md extension." },
      {
        name: "format",
        type: "string",
        enum: ["json", "markdown", "both"],
        description: "json (default) writes the machine-readable spans; markdown writes a human-readable per-page table (text, bbox, font, size, color, style); both writes each.",
      },
      { name: "pages", type: "pages", description: "1-based pages to inspect. Omit for all pages." },
      { name: "terms", type: "string[]", description: 'Only report spans whose text contains one of these substrings — the fast way to locate a label (e.g. ["Total", "Invoice #"]) and read back its exact font, size and position. Omit to report every span.' },
      { name: "ignore_case", type: "boolean", description: "Case-insensitive `terms` matching (default false)." },
      {
        name: "origin",
        type: "string",
        enum: ["top-left", "bottom-left"],
        description: "Coordinate origin for the emitted bbox/origin. top-left (default) is PyMuPDF-native and matches `redact` rects; bottom-left matches `crop` / `stamp` / `annotate` — pick the one the op you're about to author uses so the numbers drop straight in. Each page's width/height are always included for manual conversion.",
      },
    ],
    // A pure inspection: the report written to `to` IS the output. No `output` block needed.
    emitsFiles: true,
  },
  single_page: {
    name: "single_page",
    capability: "single_page",
    summary: "Combine every page into one tall single page (stacked top-to-bottom).",
    kinds: PDF,
    changesPagination: true,
    params: [
      { name: "gap", type: "number", min: 0, description: "Blank space in points between stacked pages (default 0)." },
    ],
  },
  sign: {
    name: "sign",
    capability: "sign",
    summary: "Digitally sign the PDF with a PKCS#12 certificate.",
    kinds: PDF,
    params: [
      { name: "cert", type: "string", required: true, description: "Path (workflow-relative) to a .p12/.pfx certificate." },
      { name: "password", type: "string", description: "Certificate passphrase — use ${ENV_VAR} to keep it out of the file." },
      { name: "field", type: "string", description: "Signature field name (default Signature1)." },
      { name: "reason", type: "string", description: "Reason for signing." },
    ],
  },
  validate_signature: {
    name: "validate_signature",
    capability: "validate_signature",
    summary: "Validate the PDF's digital signatures and emit a JSON report.",
    kinds: PDF,
    params: [
      { name: "to", type: "string", description: "Output path (default output/signatures.json)." },
    ],
  },
  timestamp: {
    name: "timestamp",
    capability: "timestamp",
    summary: "Add an RFC-3161 trusted document timestamp from a TSA.",
    kinds: PDF,
    params: [
      { name: "tsa_url", type: "string", required: true, description: "RFC-3161 Time-Stamping Authority URL." },
    ],
  },
};

/** All alias → canonical-name mappings, flattened for the parser/validator. */
export const OP_ALIASES: Record<string, string> = Object.values(OPERATIONS).reduce(
  (acc, spec) => {
    for (const a of spec.aliases ?? []) acc[a] = spec.name;
    return acc;
  },
  {} as Record<string, string>,
);

/** Resolve an op keyword (canonical or alias) to its spec, or undefined.
 *  Uses own-property checks so an op named after an inherited member
 *  (`constructor`, `toString`, `__proto__`, …) resolves to `undefined` — not a
 *  truthy prototype value that would later crash param validation. */
/**
 * True when this op renumbers the document — page N before it is not page N
 * after it. Drives where page-targeted operations get inserted; see
 * {@link ./text-edit.ts pageSafeInsertIndex}. Unknown names are treated as
 * pagination-changing, so a typo or a newer op fails safe.
 */
export function opChangesPagination(name: string): boolean {
  const spec = lookupOperation(name);
  return spec ? spec.changesPagination === true : true;
}

export function lookupOperation(name: string): OperationSpec | undefined {
  const canonical = Object.hasOwn(OPERATIONS, name)
    ? name
    : Object.hasOwn(OP_ALIASES, name)
      ? OP_ALIASES[name]
      : undefined;
  return canonical && Object.hasOwn(OPERATIONS, canonical) ? OPERATIONS[canonical] : undefined;
}

/** The params an op actually runs with, given the keyword it was authored under.
 *  `interleave: {}` is `merge: { interleave: true }` — the alias is erased by the
 *  time a plan step reaches an adapter, so its implied params must be folded in
 *  here. Authored params win, so `interleave: { interleave: false }` stays honest. */
export function effectiveParams(
  spec: OperationSpec,
  authoredName: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const implied = spec.aliasParams?.[authoredName];
  return implied ? { ...implied, ...params } : params;
}
