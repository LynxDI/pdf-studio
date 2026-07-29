# Operations reference — one runnable example per operation

Every OpenPDF Workflow operation (**100**), each a ready-to-run example workflow
grouped by category. Most run directly against the small **input/** files included in
each folder — open one and hit **Render**. A few are marked _needs input_ (they need a
live URL, an LLM, a signing certificate, LibreOffice, an .epub, or a specific object) and
show the syntax for you to adapt.

Each example is generated from the engine's operation registry, so it always matches the
installed version. Every row carries its backend: **_bundled_** ops run with nothing
installed; **_LibreOffice_** ops need LibreOffice (Office ⇆ PDF conversion — the Python
backend cannot run them); **_optional backend_** ops need the Python backend or a system
tool. The **Dependencies** view detects each one and shows the install command.

## Pages & layout

- [`merge`](01-pages-layout/merge.opw.yaml) — Combines the workflow's `inputs` into one PDF. · _bundled_
- [`split`](01-pages-layout/split.opw.yaml) — Splits the working PDF into several output files, three ways: explicit `ranges`, `every` N pages, or **`max_size`** — pack as many pages as fit under a file-size limit. · _bundled_
- [`split_invoices`](01-pages-layout/split_invoices.opw.yaml) — Splits a PDF that concatenates many invoices/receipts into one PDF per invoice. · _optional backend_
- [`delete_pages`](01-pages-layout/delete_pages.opw.yaml) — Removes the listed 1-based pages from the working PDF. · _bundled_
- [`reorder_pages`](01-pages-layout/reorder_pages.opw.yaml) — Reorders pages to a **complete** 1-based permutation — `order` must list EVERY page of the document exactly once. · _bundled_
- [`move_pages`](01-pages-layout/move_pages.opw.yaml) — Moves pages to a new position and leaves every other page exactly where it was — the everyday "move page 2 and pages 5-9 to after page 50". · _bundled_
- [`swap_pages`](01-pages-layout/swap_pages.opw.yaml) — Exchanges the positions of two pages and leaves everything else alone. · _bundled_
- [`rotate_pages`](01-pages-layout/rotate_pages.opw.yaml) — Rotates pages clockwise by a multiple of 90°. · _bundled_
- [`flip_pages`](01-pages-layout/flip_pages.opw.yaml) — Mirrors pages — a true flip, not a rotation. · _optional backend_
- [`insert_blank`](01-pages-layout/insert_blank.opw.yaml) — Inserts a blank page before the 1-based position `at`. · _bundled_
- [`title_page`](01-pages-layout/title_page.opw.yaml) — Draws a title/cover page and inserts it at the front (`at: 1`), or anywhere else as a section divider. · _bundled_
- [`insert_pages`](01-pages-layout/insert_pages.opw.yaml) — Inserts another PDF's pages into the working document. · _bundled_
- [`replace_pages`](01-pages-layout/replace_pages.opw.yaml) — Replaces pages of the working document with pages from another PDF. · _bundled_
- [`extract_pages`](01-pages-layout/extract_pages.opw.yaml) — Keeps only the listed pages (drops the rest), in the order given. · _bundled_
- [`crop`](01-pages-layout/crop.opw.yaml) — Crops pages to a rectangle [x, y, width, height] in points (origin bottom-left). · _bundled_
- [`scale_pages`](01-pages-layout/scale_pages.opw.yaml) — Resizes pages to a named `size` (A4/Letter/Legal) or by a `factor`, scaling the content to fit. · _bundled_
- [`n_up`](01-pages-layout/n_up.opw.yaml) — Places `cols`×`rows` source pages onto each output page (e.g. · _bundled_
- [`booklet`](01-pages-layout/booklet.opw.yaml) — Imposes pages 2-up in saddle-stitch order for folded printing (pads to a multiple of 4). · _optional backend_
- [`poster`](01-pages-layout/poster.opw.yaml) — Splits each page into a `rows`×`cols` grid of separate pages (in reading order). · _optional backend_
- [`single_page`](01-pages-layout/single_page.opw.yaml) — Combines every page into one tall single page, stacked top-to-bottom. · _bundled_
## Stamps & overlays

- [`watermark`](02-stamps-overlays/watermark.opw.yaml) — Stamps a diagonal `text` (or `image`) watermark across pages. · _bundled_
- [`stamp`](02-stamps-overlays/stamp.opw.yaml) — Places positioned `text` or an `image` at (`x`, `y`) in points from bottom-left (not diagonal — that's watermark). · _bundled_
- [`annotate`](02-stamps-overlays/annotate.opw.yaml) — Adds a list of `annotations` to the PDF — free `text` boxes, text `highlight`s (by `find` text or `rect`), sticky `note`s, shapes (`rect`/`line`/`ellipse`) and `image`s. · _optional backend_
- [`highlight`](02-stamps-overlays/highlight.opw.yaml) — Finds text ANYWHERE in the document and marks it — no coordinates, no page numbers. · _optional backend_
- [`add_page_numbers`](02-stamps-overlays/add_page_numbers.opw.yaml) — Stamps page numbers on every page. · _bundled_
- [`header_footer`](02-stamps-overlays/header_footer.opw.yaml) — Stamps running headers/footers on every page. · _bundled_
- [`overlay`](02-stamps-overlays/overlay.opw.yaml) — Overlays another PDF's pages on top of the current document. · _bundled_
## Metadata, bookmarks & tables

- [`set_metadata`](03-metadata-bookmarks-tables/set_metadata.opw.yaml) — Sets document metadata. · _bundled_
- [`set_language`](03-metadata-bookmarks-tables/set_language.opw.yaml) — Sets the document's default language on the PDF catalog (/Lang) — a BCP-47 tag like "en-US" or "fr". · _bundled_
- [`set_bookmarks`](03-metadata-bookmarks-tables/set_bookmarks.opw.yaml) — Replaces the outline with a given list of { level, title, page } entries (page is 1-based). · _optional backend_
- [`extract_bookmarks`](03-metadata-bookmarks-tables/extract_bookmarks.opw.yaml) — Exports the outline/bookmarks to a JSON file (`to`). · _optional backend_
- [`extract_fields`](03-metadata-bookmarks-tables/extract_fields.opw.yaml) — Exports form fields (page/name/type/value) to a CSV file (`to`). · _optional backend_
- [`extract_tables`](03-metadata-bookmarks-tables/extract_tables.opw.yaml) — Detects tables and writes each to a CSV under the `to` directory. · _optional backend_
- [`extract_annotations`](03-metadata-bookmarks-tables/extract_annotations.opw.yaml) — Exports every markup/comment annotation (sticky notes, highlights, underlines, strikeouts, free text, shapes, ink, stamps) to `to`/annotations.json + annotations.csv — one row per annotation with author, comment, the text a markup covers, color, page and rect. · _optional backend_
- [`pdf_info`](03-metadata-bookmarks-tables/pdf_info.opw.yaml) — Writes a read-only report of the PDF — page count, per-page size/rotation, metadata, encryption, fonts, image/field/annotation counts, plus text coverage (pages_with_text, per-page chars, image-only page count, and a needs_ocr flag) — as JSON to `to`. · _optional backend_
- [`check_accessibility`](03-metadata-bookmarks-tables/check_accessibility.opw.yaml) — Audits the PDF for accessibility (PDF/UA, Section 508, WCAG) and writes a pass/warn/fail report to `to` — checks for a document title, a default language, a tag tree (StructTreeRoot), that the reader shows the title not the filename, image alt text, and form-field tooltips. · _optional backend_
- [`tag_pdf`](03-metadata-bookmarks-tables/tag_pdf.opw.yaml) — Auto-tags an untagged PDF so screen readers can navigate it — the fix for check_accessibility's "untagged" fail. · _optional backend_
- [`compare_pdfs`](03-metadata-bookmarks-tables/compare_pdfs.opw.yaml) — Compares the working document with a second PDF (`against`, a workflow-relative path) and writes a diff report + highlighted images to `output.folder`. · _optional backend_
- [`set_view_preferences`](03-metadata-bookmarks-tables/set_view_preferences.opw.yaml) — Controls how the PDF OPENS in a reader (not its content): `page_layout` (e.g. · _optional backend_
## Text, image & Markdown extraction

- [`extract_text`](04-text-image-markdown-extraction/extract_text.opw.yaml) — Extracts the PDF's text to a sidecar file (`to`). · _optional backend_
- [`inspect_text`](04-text-image-markdown-extraction/inspect_text.opw.yaml) — Read-only inspection that maps the exact **text spans** on each page to a report at `to`. · _optional backend_
- [`extract_images`](04-text-image-markdown-extraction/extract_images.opw.yaml) — Extracts every image **embedded in** the pages to files under the `to` directory — the photos and logos the document contains, at their original resolution. · _optional backend_
- [`render_pages`](04-text-image-markdown-extraction/render_pages.opw.yaml) — Renders pages to images under `to` — raster (`png`/`jpg`) at `dpi`, or `svg` for vector output (infinite zoom, tiny files, no DPI needed). · _optional backend_
- [`replace_image`](04-text-image-markdown-extraction/replace_image.opw.yaml) — Replaces an embedded image. · _needs input · optional backend_
- [`replace_text`](04-text-image-markdown-extraction/replace_text.opw.yaml) — Finds text and replaces it IN PLACE — the workflow-shaped answer to "edit the PDF": re-date a template, fix a recurring typo, swap an entity name across a whole folder (put a glob in `inputs` and it batches). · _optional backend_
## OCR & document recognition

- [`text_report`](05-ocr-document-recognition/text_report.opw.yaml) — Read-only diagnostic that answers "does this PDF need OCR, and where?" — **page stats plus a recommendation**. · _optional backend_
- [`ocr`](05-ocr-document-recognition/ocr.opw.yaml) — Adds a searchable text layer to scanned pages via OCR (Tesseract). · _optional backend_
- [`extract_markdown`](05-ocr-document-recognition/extract_markdown.opw.yaml) — Extracts page content as Markdown (tables included) to `to`. · _optional backend_
- [`pdf_to_markdown`](05-ocr-document-recognition/pdf_to_markdown.opw.yaml) — Converts the PDF to Markdown. · _optional backend_
- [`extract_receipt`](05-ocr-document-recognition/extract_receipt.opw.yaml) — Reads receipts/invoices as IMAGES with a vision-language model (Qwen3-VL) and extracts structured fields — merchant, date, currency, subtotal, tax, tip, total, receipt number, and line items — to JSON + CSV. · _needs input · optional backend_
## Redaction & cleanup

- [`redact`](06-redaction-cleanup/redact.opw.yaml) — Permanently removes content in rectangles on a page. · _optional backend_
- [`auto_redact`](06-redaction-cleanup/auto_redact.opw.yaml) — Finds and permanently redacts matches across all pages. · _optional backend_
- [`sanitize`](06-redaction-cleanup/sanitize.opw.yaml) — Strips JavaScript, embedded files, metadata, and links from the PDF. · _optional backend_
- [`remove_annotations`](06-redaction-cleanup/remove_annotations.opw.yaml) — Removes all annotations (comments, highlights, link markup). · _optional backend_
- [`remove_images`](06-redaction-cleanup/remove_images.opw.yaml) — Removes all images from the document. · _optional backend_
- [`remove_blank_pages`](06-redaction-cleanup/remove_blank_pages.opw.yaml) — Detects and deletes blank pages (no text, no images, near-white). · _optional backend_
- [`extract_js`](06-redaction-cleanup/extract_js.opw.yaml) — Surfaces any JavaScript embedded in the PDF (document-level Names tree and the open action) to a Markdown report at `to`. · _optional backend_
## Forms

- [`create_form`](07-forms/create_form.opw.yaml) — Turns a template into a FILLABLE PDF. · _optional backend_
- [`fill_form`](07-forms/fill_form.opw.yaml) — Fills a known PDF form from your records — no need to know the raw field names. · _optional backend_
- [`extract_form`](07-forms/extract_form.opw.yaml) — Reads filled forms back OUT to data — the inverse of `fill_form`. · _optional backend_
- [`fill_field`](07-forms/fill_field.opw.yaml) — Sets an AcroForm field's value. · _optional backend_
- [`flatten`](07-forms/flatten.opw.yaml) — Bakes form fields + annotations into static page content (no longer editable). · _optional backend_
- [`unlock_forms`](07-forms/unlock_forms.opw.yaml) — Clears the read-only flag on form fields so they can be filled. · _optional backend_
## Attachments

- [`extract_attachments`](08-attachments/extract_attachments.opw.yaml) — Extracts embedded file attachments to the `to` directory. · _optional backend_
- [`add_attachments`](08-attachments/add_attachments.opw.yaml) — Embeds a file as an attachment. · _optional backend_
- [`extract_links`](08-attachments/extract_links.opw.yaml) — Pulls every hyperlink out of a PDF (or a whole folder) to JSON + CSV — clickable link annotations (the URL, its page, and the anchor text) plus, by default, bare URLs printed in the text that were never linked. · _optional backend_
- [`add_links`](08-attachments/add_links.opw.yaml) — Makes URLs clickable and adds explicit links — the inverse of extract_links. · _optional backend_
## Encryption & permissions

- [`encrypt`](09-encryption-permissions/encrypt.opw.yaml) — Password-protects the PDF (AES-256). · _optional backend_
- [`decrypt`](09-encryption-permissions/decrypt.opw.yaml) — Removes password protection — supply the current `password`. · _needs input · optional backend_
- [`set_permissions`](09-encryption-permissions/set_permissions.opw.yaml) — Restricts what viewers can do via an `owner_password`. · _optional backend_
## Optimize, repair & archival

- [`compress`](10-optimize-repair-archival/compress.opw.yaml) — Reduces file size. · _bundled_
- [`linearize`](10-optimize-repair-archival/linearize.opw.yaml) — "Fast web view" — reorders the PDF for progressive loading. · _optional backend_
- [`repair`](10-optimize-repair-archival/repair.opw.yaml) — Repairs / rewrites a structurally-messy PDF. · _optional backend_
- [`decompress`](10-optimize-repair-archival/decompress.opw.yaml) — Uncompresses content streams to produce a readable/debuggable PDF. · _optional backend_
- [`rasterize`](10-optimize-repair-archival/rasterize.opw.yaml) — Flattens every page to a raster image (non-editable, non-selectable output) at `dpi`. · _optional backend_
- [`recolor`](10-optimize-repair-archival/recolor.opw.yaml) — Recolors every page for comfortable reading. · _optional backend_
- [`convert_colors`](10-optimize-repair-archival/convert_colors.opw.yaml) — Converts the whole document's color space with Ghostscript — `mode`: gray (default, for cheap B&W printing), cmyk (for a commercial press), or rgb (for screen). · _optional backend_
- [`scanner_effect`](10-optimize-repair-archival/scanner_effect.opw.yaml) — Makes a clean, born-digital PDF look like it was scanned — a slight page skew (alternating per page), softening, and grain. · _optional backend_
- [`pdf_to_pdfa`](10-optimize-repair-archival/pdf_to_pdfa.opw.yaml) — Converts to PDF/A for long-term archival. · _optional backend_
## Convert to PDF

- [`images_to_pdf`](11-convert-to-pdf/images_to_pdf.opw.yaml) — Builds a PDF from image inputs — set the workflow's `inputs` to image files (one page each). · _bundled_
- [`html_to_pdf`](11-convert-to-pdf/html_to_pdf.opw.yaml) — Renders an HTML file to PDF — set the workflow's input to a .html file. · _optional backend_
- [`markdown_to_pdf`](11-convert-to-pdf/markdown_to_pdf.opw.yaml) — Renders a Markdown file to a styled PDF — set the workflow's input to a .md file. · _optional backend_
- [`url_to_pdf`](11-convert-to-pdf/url_to_pdf.opw.yaml) — Fetches a web page and renders it to PDF using a system Chrome/Edge when present. · _needs input · optional backend_
- [`eml_to_pdf`](11-convert-to-pdf/eml_to_pdf.opw.yaml) — Renders an .eml email (headers + body) to a styled PDF — set the workflow's input to the .eml file. · _optional backend_
- [`epub_to_pdf`](11-convert-to-pdf/epub_to_pdf.opw.yaml) — Converts an EPUB ebook to PDF. · _needs input · optional backend_
- [`office_to_pdf`](11-convert-to-pdf/office_to_pdf.opw.yaml) — Converts an Office document to PDF — set the input to a docx/xlsx/pptx/odt file and set `from` to its format. · _needs input · LibreOffice_
- [`video_to_pdf`](11-convert-to-pdf/video_to_pdf.opw.yaml) — Samples a video every `every` seconds and writes **one page per frame**, with the source time burned into the corner. · _needs input · optional backend_
## Convert from PDF

- [`pdf_to_docx`](12-convert-from-pdf/pdf_to_docx.opw.yaml) — Converts the PDF to a Word document written to `to`. · _LibreOffice_
- [`pdf_to_pptx`](12-convert-from-pdf/pdf_to_pptx.opw.yaml) — Converts the PDF to a PowerPoint file written to `to`. · _LibreOffice_
- [`pdf_to_xlsx`](12-convert-from-pdf/pdf_to_xlsx.opw.yaml) — Converts the PDF to an Excel file written to `to`. · _LibreOffice_
- [`pdf_to_html`](12-convert-from-pdf/pdf_to_html.opw.yaml) — Converts the PDF to an HTML file written to `to`. · _LibreOffice_
- [`pdf_to_epub`](12-convert-from-pdf/pdf_to_epub.opw.yaml) — Converts the PDF to a **reflowable EPUB** ebook written to `to` — ideal for reading on Kindle and other e-readers (text reflows to the screen, unlike a fixed PDF). · _optional backend_
- [`pdf_to_png`](12-convert-from-pdf/pdf_to_png.opw.yaml) — Converts the PDF to PNG images — one file per page — under `to` at `dpi`. · _optional backend_
- [`pdf_to_jpg`](12-convert-from-pdf/pdf_to_jpg.opw.yaml) — Converts the PDF to JPG images — one file per page — under `to` at `dpi`. · _optional backend_
## Document intelligence (AI)

- [`summarize`](13-document-intelligence-ai/summarize.opw.yaml) — Summarizes the PDF's text with an LLM and writes a Markdown summary to `to` (or a `.md` output.file). · _needs input · optional backend_
- [`translate`](13-document-intelligence-ai/translate.opw.yaml) — Translates the PDF's text to `lang` with an LLM. · _needs input · optional backend_
- [`semantic_search`](13-document-intelligence-ai/semantic_search.opw.yaml) — Finds passages by MEANING, not keywords — ask in plain language and get the matching passages back, ranked, with their page numbers. · _needs input · optional backend_
## Digital signatures

- [`sign`](14-digital-signatures/sign.opw.yaml) — Digitally signs the PDF with a PKCS#12 certificate. · _needs input · optional backend_
- [`validate_signature`](14-digital-signatures/validate_signature.opw.yaml) — Validates the PDF's digital signatures and writes a JSON report to `to`. · _optional backend_
- [`timestamp`](14-digital-signatures/timestamp.opw.yaml) — Adds an RFC-3161 trusted timestamp from a TSA. · _needs input · optional backend_
