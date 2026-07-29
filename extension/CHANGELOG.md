# Changelog

All notable changes to Lynx PDF Studio Automation are documented here.

## 0.27.7 — security fixes, and telemetry is now opt-in

**Please update.** A pre-publication security review of the source found four issues
reachable from an untrusted workflow or a hostile example manifest — the case this engine
is built to defend, and one that matters more now the source is public. All are fixed here.

- **Example downloads could write outside your workspace.** The folder name for each
  downloaded example came from the manifest without validation, so a manifest served from
  a redirected `pdfStudio.examplesUrl` could walk the extraction target out of the project
  — into a Startup folder, for instance. Ids are validated and the destination is confined;
  `examplesUrl` is now https-only and machine-scoped, so a workspace cannot redirect it.
- **A workflow could write into `.git/`, `.vscode/` and friends.** Path confinement kept
  workflows inside their own directory, but when that directory is a repository root, an
  ordinary relative path like `.git/hooks/pre-commit` was already inside it — and runs on
  your next commit. Writes into `.git`, `.hg`, `.svn`, `.vscode`, `.github` and
  `.lynx-pdf-studio` are now refused, reported as `path_protected_dir` before a render
  starts and enforced again on the resolved path.
- **`url_to_pdf` could reach your own network.** It took any URL, including
  `169.254.169.254` (cloud metadata), `localhost` services and RFC1918 addresses. The
  target is now resolved and checked before any engine fetches it, redirects included.
  Public pages — the point of the operation — are unaffected; intranet rendering needs
  `pdfStudio.allowRemoteRender`.
- **`sanitize: false` is no longer accepted from a workflow.** The HTML sanitizer defends
  against HTML the workflow author controls, so that same author could not be the one
  waiving it. It is honoured only when remote render is enabled.

**Telemetry is now off by default.** It was opt-out; it is opt-in. Nothing is reported
unless you turn on `pdfStudio.telemetry.enabled`, and it stays anonymous when you do. A
local-first document tool should not report anything you did not ask it to.

Also: the full licence texts of every bundled component now ship in
`THIRD-PARTY-LICENSES.txt`, the fail-fast path check covers every operation rather than
four, and `docs/security.md` has been corrected where it described intent rather than the
code.

## 0.27.5 — open source, and a new name

**The source is now public**, at [github.com/LynxDI/pdf-studio](https://github.com/LynxDI/pdf-studio),
under AGPL-3.0-or-later. That closes the note left in 0.27.3: AGPL §6 obliges the source to
be offered to anyone the binary is distributed to, and it is now simply there for everyone.

What you get: the OPW engine (`core/`), the VS Code extension, the MCP server, the CLI, and
every example project — the same code that renders your PDFs, readable and forkable.

**Renamed to Lynx PDF Studio Automation.** The extension's name inside VS Code is
unchanged — it is still **PDF Studio Automation** in the Marketplace, the command palette
and the sidebar. Only the product branding now carries the company name.

**No functional changes.** No new operations, no behaviour differences, nothing to relearn.
The operation set stays at 100. If you are upgrading from 0.27.3, nothing you have written
needs to change.

## 0.27.3 — relicensed to AGPL-3.0-or-later

Lynx PDF Studio Automation is now licensed under the **GNU Affero General Public License, version 3 or
later**, replacing the previous proprietary licence.

The reason is compatibility: several optional backends it builds on are themselves AGPL —
notably **PyMuPDF** and **Ghostscript**, both dual-licensed by Artifex Software. Adopting
the same licence removes any question about how this project relates to them.

**Using it stays free and unrestricted, including commercially.** The AGPL constrains
redistribution and modification, not use. Your documents still never leave your machine.

A **commercial licence** is available for anyone who needs to embed Lynx PDF Studio Automation in a
closed-source product, or whose organisation prohibits AGPL — the same arrangement Artifex
offers for Ghostscript and PyMuPDF. See `LICENSING.md`.

- `LICENSE` is now the verbatim FSF text, unmodified, so GitHub and the Marketplace
  recognise it as AGPL-3.0 rather than showing "NOASSERTION".
- `LICENSING.md` explains the choice and how to obtain a commercial licence.
- Every `package.json` declares `AGPL-3.0-or-later`; `NOTICE`, both READMEs, the site
  footers and the public-repo playbook no longer describe the product as proprietary.
- The public-repo sync now pushes `LICENSE`, `NOTICE` and `LICENSING.md` alongside the
  README — legal text drifting between what ships and what the public repo shows is
  exactly the kind of mismatch people quote back at you.

> The source is not yet published. Note the ordering: AGPL §6 obliges you to offer
> corresponding source to anyone you distribute a binary to, and that attaches on the next
> release made under this licence — not on the licence change itself.

## 0.27.2 — the Dependencies view now says which ones matter

The dependency list was flat, so every row looked equally consequential: `pillow-heif`
(one image format) sat beside PyMuPDF (two-thirds of the operation set), and Marker — a
multi-gigabyte GPU model stack — beside qpdf. The panel told you *what* was installed but
not *whether to bother*.

It's now grouped into four tiers:

- **Bundled** — pdf-lib. **25 operations, nothing to install.**
- **Recommended** — Python + PyMuPDF + pikepdf. Unlocks **66 more**.
- **Per-feature** — Ghostscript, qpdf, Tesseract, LibreOffice, Chrome/Edge, ffmpeg,
  pillow-heif, pyHanko, MarkItDown, pymupdf4llm. One capability each.
- **Heavy · opt-in** — Marker, PaddleOCR-VL, Qwen3-VL. Large models, usually a GPU.
  Collapsed by default so they don't dominate the view.

Deliberately **"recommended", not "required"**: the bundled engine genuinely runs
standalone, and that is both the onboarding story and a plain statement of fact.

- The section header now reads **"core 3/4 ready"** rather than counting every optional
  tool — a healthy install used to look like "8/20 ready", which is the opposite of
  reassuring. Only the recommended tier warns when incomplete; per-feature and heavy are
  *meant* to be mostly uninstalled, so a warning there would cry wolf.
- Tiers are assigned from one table rather than at each probe site, so a newly added
  dependency can't slip in untiered.
- **Fixed:** Ghostscript displayed as `gswin64c` — the raw Windows binary name, which is
  what the probe happened to try first.
- The agent map now mirrors the tiers, so an agent suggests the recommended install
  unprompted, a per-feature tool only when the workflow needs it, and never suggests a
  multi-gigabyte model stack unless asked for AI-grade OCR by name.

## 0.27.1 — README guard

The Marketplace README lists every operation by category, with a count per category and a
total in three places — all hand-maintained, and it has drifted before (the public-README
sync tool's own header records it falling eight operations behind). A test now compares it
against the registry: a new operation left undocumented, a stale category count, or a stale
total now fails the build instead of shipping.

## 0.27.0 — video to PDF, and the image formats we claimed but couldn't open

**`video_to_pdf`.** Samples a video every N seconds and writes one page per frame with the
source time burned into the corner. It deliberately does **not** build a grid — `n_up`
already does, so a contact sheet is two lines and every other page operation composes:

```yaml
- video_to_pdf: { every: 30 }
- n_up: { cols: 3, rows: 4 }
- add_page_numbers: { position: bottom-center }
```

Lecture recordings, site-survey footage, UI walkthroughs, security review. `max_frames`
(default 200) is a guard rather than a preference: a three-hour recording at `every: 1` would
otherwise quietly produce ten thousand pages. Requires **ffmpeg**, now probed in the
Dependencies view with a one-click install on every platform.

**Fixed: `images_to_pdf` advertised SVG, HEIC and PSD it could not accept.** The summary
promised them and the Python backend could decode them, but the format list `merge` consults
listed none — so a folder of iPhone photos was rejected before anything tried to open it.
`.svg`, `.heic`, `.heif` and `.psd` are now registered.

**HEIC needed more than registration.** Pillow cannot decode HEIC on its own; it needs
`pillow-heif`, which was not installed — so the claim was doubly untrue. It is now a probed
dependency with one-click install, and a skipped `.heic` says exactly that instead of a
generic "no readable images".

**Fixed: staged image files lost their extension.** The Python adapter wrote inputs to temp
files as `img_0` with no suffix, so PyMuPDF lost a decoding hint it uses (SVG in particular)
and the sidecar could not tell a `.heic` from anything else when reporting a failure.

> **On ffmpeg's scope:** it is used for video only. It has no PDF muxer and cannot read PSD or
> AI, so still images stay with Pillow/PyMuPDF — a Python wheel rather than a ~100 MB binary.

## 0.26.0 — title pages

**`title_page`.** Draws a cover — title, subtitle, author, date, optional logo and background
— and inserts it at the front. It runs on the bundled engine, so a cover page needs nothing
installed.

The motivating case: a PDF sideloaded onto a Kindle shows a placeholder in the library. That
is two problems wearing one coat — the **thumbnail** comes from page 1, the **shelf title**
comes from the Title metadata. `title_page` fixes the first. It deliberately does *not* write
`/Title` (two operations fighting over one field is order-dependent behaviour); instead a new
warning names the second half:

> `title_page_no_metadata` — the cover page sets a title but the document's Title metadata is
> not. E-readers take the shelf entry from the metadata, not from page 1.

- **One type knob.** `title_size` drives the subtitle/author/date sizes, and their colours are
  blended toward the **background** rather than a fixed grey — so a dark cover stays readable
  instead of muddy, without tuning six parameters.
- Long titles wrap to the column set by `margin`, and the whole block shrinks once if it still
  overflows.
- `at:` puts a divider mid-document. Insert them **back to front** so each position still
  refers to the original numbering — the docs say so, because it's the mistake everyone makes.
- Non-Latin covers are refused with the way out (`markdown_to_pdf` + `insert_pages`) rather
  than drawn as a page of question marks.

**Fixed: `insert_blank: { size: Legal }` never worked.** The adapter advertised Legal but fell
back to A4, and the parameter's enum rejected it at validate time — so the documented size was
unreachable from both ends. Page sizes now come from one shared table.

**Fixed a latent crash in four existing operations.** pdf-lib's `widthOfTextAtSize` throws on
a newline or tab while `drawText` accepts them, and every centring path measures first — so a
two-line string would have taken down `watermark`, `stamp`, `header_footer` and
`add_page_numbers` too. The new text helper splits on newlines *before* measuring.

Worth recording, since it nearly shaped the design the wrong way: WinAnsi is cp1252 and
**does** encode em dashes, curly quotes, ellipses, bullets, degrees and all of Latin-1. A
sanitizer that "fixed" those would have corrupted correct output. What it genuinely cannot
draw is ligatures, Latin Extended, non-Latin scripts and the whitespace controls above.

## 0.25.0 — compress to a target size

**`compress: { max_size: "9MB" }`.** The companion to `split: { max_size }`: instead of
picking a quality setting and hoping, state the outcome. It walks a quality ladder
(prepress → printer → ebook → screen → explicit low-DPI passes) and stops at the **best
setting that fits** — the highest quality that satisfies the constraint, not the most
aggressive one available. `quality` still works and acts as the ceiling.

The last two rungs override `-dColorImageResolution` explicitly, which the stock Ghostscript
presets never do — `/screen` bottoms out around 72 dpi and cannot go further. That is where a
real size target is either met or honestly reported as unreachable.

- **Descending stops when it stops paying.** Re-encoding at a very low DPI can make an
  already-compact document *larger* (observed: a `/screen @50dpi` pass ballooning 565 KB to
  4.7 MB). Once a rung is worse than the one before it, the ladder stops and keeps the best
  result rather than burning another pass.
- **An unreachable target is a note, not a failure** — you get the smallest valid version
  with both numbers and a pointer to `rasterize` or `split: { max_size }`. The smaller file is
  still wanted, and only the author can decide how to trade the rest.
- Every candidate keeps the existing safety checks: it must still load and preserve its page
  count, and the output is never larger than the input.
- With only qpdf (lossless, no quality ladder) or the bundled engine (re-save only), the note
  says exactly why the target could not be considered instead of ignoring it silently.

`compress` + `split` compose, and the optimizer will not reorder them — that fix shipped in
0.23.0.

## 0.24.0 — PDF to PNG

**`pdf_to_png` and `pdf_to_jpg`.** The engine could always do this — `render_pages` renders
any page to PNG, JPG or SVG — but nobody could find it. The name is what the code does, not
what people search for, and it sat under *Text, image & Markdown extraction* while everyone
looking for it opened *Convert from PDF*, which listed Word, Excel, PowerPoint, HTML and EPUB
and **no image option at all**. Both new operations are presets of the same capability, in the
category where you'd look, and "png" / "image" / "thumbnail" / "screenshot" now find them.

Two things the capability genuinely lacked, added while there:

- **`pages`** — render a subset. A cover thumbnail is `pdf_to_png: { pages: [1], dpi: 72 }`,
  not a 400-page render you then delete.
- **`transparent`** — PNG only; keeps the page background clear instead of painting it white,
  which is the difference between a picture of a page and an asset you can composite. Asking
  for a transparent JPG is refused by name rather than silently producing a white one.
- **`name`** templates the filenames (`{stem} {i} {page}`, padded as `{i:03}`). The default
  `page_1.png … page_10.png` sorts 10 before 2, which matters the moment you import a sequence.

`extract_images`, `render_pages` and `rasterize` are easy to confuse — images **in** the page,
a picture **of** the page, and flatten-to-images-but-still-a-PDF. Each now names the other two.

## 0.23.0 — split to fit, and two determinism fixes

**`split` can target a file SIZE, not just a page count.** "Every part must be under 5 MB"
is a hard constraint — an upload form, an email attachment, a court e-filing cap — and page
counts cannot satisfy it, because pages are not uniform: one part full of scans blows the
limit while a text-only part wastes it. `max_size` packs as many pages as actually fit,
**measuring** each part rather than estimating.

```yaml
operations:
  - compress: {}
  - split:
      max_size: "4.8MB"                # headroom under a 5 MB cap
      name: "application-part-{i:02}"
output: { folder: output/parts }
```

Verified on the shape that motivated it — 1,500 pages, packed into parts at 99.9% of the
cap, none over, no pages lost, in under 9 seconds. The packer probes exponentially from a
running bytes-per-page estimate and binary-searches the boundary, so it stays O(log n) saves
per part instead of re-serialising after every page.

- Units are explicit: `"5MB"` is 5,000,000 and `"5MiB"` is 5,242,880. Most upload validators
  check the binary one, so **leave your own headroom** — no hidden safety margin is applied,
  because a file rejected by a limit we had silently shaved would be undebuggable.
- A page too large to fit on its own is written as a single-page part **with a warning**
  rather than failing the run. A 6 MB scan on page 900 must not cost someone a deadline.
- **`name` templates the part filenames** — `{stem} {name} {ext} {i} {start} {end} {n}`,
  zero-padded as `{i:03}`. `part_000001.pdf` is fine for a person and useless to a Makefile.
  The same tokens now work in a batch `output.file`, and padding works in both.
- **`burst`** is `split` with `every: 1`, spelled the way pdftk users expect.
- **New example project — "Split by size"**, with a deliberately uneven sample document so
  you can see `every: 10` fail the cap where `max_size` doesn't.

**Fixed: two identical renders produced different bytes.** Every bundled operation loaded the
PDF with pdf-lib's default `updateMetadata`, which rewrites `/Producer` and stamps `/ModDate`
with the wall clock. That contradicted the determinism the format promises and the premise of
content-hashing a plan — and it silently overwrote a `/Producer` that `set_metadata` had just
written.

**Fixed: structural operations silently dropped the document metadata.** `delete_pages`,
`extract_pages`, `reorder_pages`, `move_pages`, `swap_pages`, `split`, `scale_pages`, `n_up`
and `single_page` rebuild the document, and the Info dictionary lives on the trailer rather
than the pages — so `set_metadata` followed by `delete_pages` produced an untitled PDF with no
diagnostic. Metadata now survives, and `merge` inherits the first input's title and author.

**Fixed: the optimizer hoisted `compress` past `split`.** `split` emits the real output as
files; the working document afterwards is discarded. Moving a later `compress` to the end
therefore left every emitted part uncompressed while reporting success — the exact opposite of
what "compress, then split into 5 MB parts" asks for. Operations whose artifacts *are* the
output are now barriers the optimizer will not reorder across.

## 0.22.0 — merge anything

**`merge` combines mixed file types.** Hand it a PDF, a Word document, a Markdown file and
two images and it produces one PDF. Each non-PDF input is converted first, with the
converter chosen from the file's extension (`.docx`/`.pptx`/`.xlsx` → LibreOffice,
`.png`/`.jpg` → the bundled image path, `.md`/`.html`/`.eml`/`.epub` → their renderers);
PDFs pass through untouched. Previously any non-PDF input died with `No PDF header found`,
so nothing that worked before behaves differently.

```yaml
inputs:
  - cover.pdf
  - finance-summary.docx
  - engineering-notes.md
  - revenue-chart.png
operations:
  - merge: {}
output: { file: output/board-pack.pdf }
```

- `inputs: [input/*]` merges a whole folder of mixed types in sorted filename order.
- **`merge: { convert: false }`** keeps the strict, PDF-only behaviour.
- **Missing backends are reported at compile time.** The conversion is implied by the
  inputs rather than written as a step, so `opw_compile` now lists it — "merge must convert
  `report.docx` to PDF first, but no available adapter provides `office_to_pdf`" — instead
  of failing halfway through a render.
- An input whose type nothing can convert is refused **by name**, not silently dropped.
- **New example project — "Merge anything"**, with all five mixed sample files.
- **Operations search finds ops by what you have, not by their name.** Searching
  "powerpoint" returned only `pdf_to_pptx`, never `office_to_pdf`, because that op's
  description says "Office document". Search now indexes explicit synonyms across 30 ops —
  product names, file extensions, and plain verbs ("shrink" → `compress`, "password" →
  `encrypt`) — matches names typed without underscores, and ANDs multi-word queries.
- **Fixed:** a creator written as an alias (`ebook_to_pdf` for `epub_to_pdf`) skipped the
  input-type check that its canonical spelling got.

## 0.21.0 — a folder of PowerPoint decks, either way

**`office_to_pdf` + `merge` now works on a whole folder.** Converting a folder of `.pptx`
into one combined PDF validated clean and then failed at render: `merge` reads the
workflow's *inputs*, while `office_to_pdf` converted only the working document, so `merge`
was handed raw `.pptx` bytes and died on a PDF parse error. Operations that create a PDF
from one non-PDF document — `office_to_pdf`, `markdown_to_pdf`, `html_to_pdf`,
`eml_to_pdf`, `epub_to_pdf` — are now applied **once per input** before a folding op, so
both shapes are one workflow and the only difference is whether `merge` is there:

```yaml
inputs: ["decks/*.pptx"]                    # one PDF per deck
operations: [ { office_to_pdf: { from: pptx } } ]
output: { file: "output/{stem}.pdf" }
```

```yaml
inputs: ["decks/*.pptx"]                    # every deck → ONE PDF, sorted by filename
operations:
  - office_to_pdf: { from: pptx }
  - merge: {}
output: { file: output/course.pdf }
```

- **New example project — "PowerPoint → PDF"**, in **Get Example Projects**. Ships three
  real sample decks plus both workflows.
- **New validation error `creator_before_fold`.** A creator that reads every input at once
  (`images_to_pdf`) or none (`url_to_pdf`) can't be folded that way; it's now an error while
  you edit rather than a confusing parse failure mid-render.
- **`office_to_pdf` documentation says it needs LibreOffice.** The reverse direction
  (`pdf_to_docx`/`pptx`/`xlsx`/`html`) always named it; the direction people actually start
  from didn't, and the generated example pointed at the Python setup guide — which cannot
  run this op at all.

## 0.20.0 — page surgery that says what it does

**`reorder_pages` no longer deletes pages silently.** It documented "every page exactly
once" but only checked for duplicates, so `order: [2, 1]` on a 10-page PDF validated
clean, returned a **2-page** document, and reported success. That is the obvious way to
write "swap the first two pages", so it was reachable by accident. It is now refused —
statically when the order provably can't cover any document, and at render time against
the real page count. **If you have a workflow relying on a partial `order` to drop pages,
it will now fail; use `extract_pages`.**

- **`move_pages`** — `{ pages: [2, "5-9"], after: 50 }` moves pages and leaves every other
  page where it was. `after`/`before` are numbered in the *original* document, and
  `after: 0` means the very start, so you never work out what the numbers become mid-edit.
- **`swap_pages`** — `{ a: 2, b: 10 }` exchanges two pages. Previously an *alias* for
  `replace_pages`, which needs a second PDF — so asking to swap two pages of one document
  produced `requires param "from"`. It is now its own operation.
- Both run on the bundled engine (no Python) and never change the page count. Both are on
  the page right-click menu in the Document tree.

**Page ranges everywhere.** Any `pages` / `from_pages` / `order` list now takes compact
tokens alongside plain numbers — `[1, "5-8", "10-last", "last"]`. Deleting pages 300–800 is
one token instead of 501 integers, and `order: ["last-1"]` reverses a document of any
length. `split.ranges` always spoke this notation; now the rest of the format does too.
A malformed token (`"5-8-10"`) is a validation error rather than a silently ignored entry.

**Page-targeted edits land in the right place.** The Document tree lists the *input* file's
pages, but operations were appended to the end of the program — so clicking "Page 5" in a
workflow that already deleted page 1 wrote an operation hitting the wrong page. Operations
now declare whether they renumber the document, and a page-targeted edit is inserted before
the first one that does, with a note saying why.

**Alternating-page merge.** `merge` gained `interleave` (also written `interleave: {}`):
combine a document and its translation page-by-page, or rejoin a duplex scan whose fronts
and backs landed in two files. Pair it with `n_up: { cols: 2, rows: 1 }` to print 2-up.
Sources that run out contribute a blank sized from their own last page, so each input keeps
its slot to the final sheet.

**Aliases now behave like the operations they name.** Adding an alias to `merge` exposed
several places that compared operation names as string literals. Fixing them also fixed two
long-standing bugs: the `metadata` alias never coalesced, and an aliased seal operation
didn't block the optimizer's compress move. `opw_scaffold` no longer silently drops aliases.

**96 operations** (was 94).

## 0.19.27 — find a workflow in the tree

**Search the Workflows tree by what a workflow *does*, not just its file name.** A project
accumulates `.opw.yaml` files, and what you remember is rarely the path — it's "the one that
watermarks", "the one that reads `invoices/*.pdf`", "the one that writes `bundle.pdf`".

- **Find a Workflow…** (🔍 in the view title, or on the Workflows row) — a picker over every
  workflow, matching its path, **operations**, param values, inputs, output, and vars, plus a
  hand-written top-level `name:` and the parse error of a file that won't load. Terms are ANDed
  and order-free: `watermark invoice` finds the invoice workflow that watermarks. Enter reveals
  the hit in the tree and opens it.
- **Filter Workflows…** — keep the query as a narrowing of the Workflows section (the picker's
  ⧩ button does this too). The section header shows `3 of 41 · "watermark"`, each surviving row
  says *why* it matched (`op: watermark`), and a ✕ appears in the title bar to clear it.

## 0.19.24 — accessibility auto-tagging (`tag_pdf`) + `highlight`

**New operation: `tag_pdf` — auto-tag an untagged PDF for accessibility (now 94 operations).**
The fix for `check_accessibility`'s "untagged" fail: it builds a **real** tag tree
(`StructTreeRoot`) with reading-order marked content, so a screen reader can actually navigate
the document — not a shallow single-tag wrapper that only fools a checker.

```yaml
- tag_pdf:
    lang: "en-US"
    title: "Q3 Report"
    alt: ["Bar chart of quarterly revenue"]
```

It reads each page's content stream, recovers every text run's position and font size, and:

- **Headings & paragraphs** — text blocks become `<H1>`/`<H2>`/`<H3>` (level inferred by ranking
  the distinct heading sizes against the document's body size) and `<P>`, each linked to its
  on-page content by marked-content IDs — and a paragraph split across several text objects is
  still tagged as one `<P>`.
- **Figures** — image XObjects become tagged `<Figure>`s carrying `/Alt`; `alt` supplies the
  descriptions in reading order, and any figure left without one is reported as still needing
  real alt text.
- **Catalog** — sets `MarkInfo/Marked`, and optionally `/Lang` and the document title +
  `DisplayDocTitle`, so a single pass can clear the tagging, language, title and title-shown checks.

It is **idempotent** (an already-tagged PDF is left untouched unless `force: true`) and preserves
the page content byte-for-byte — the text still extracts identically. Best on text documents with a
single-column reading order; **OCR a scanned PDF first** (otherwise a page is just one big figure),
and complex tables/lists are flattened to paragraphs. Needs the Python backend.

**New operation: `highlight`.** The non-destructive twin of
`auto_redact`. It takes the *same matcher* — literal strings (`text`), regular expressions
(`regex`), PII presets (`patterns: [email, ssn]`), with the same `ignore_case` and
`whole_word` switches — but instead of permanently deleting each hit, it **marks** it.

```yaml
- highlight:
    text: ["Confidential", "Net 30"]
    patterns: [email]
    style: highlight        # highlight | underline | strikeout | squiggly | box
    color: "#ffd400"
    ignore_case: true
    note: "flagged for review"
```

Until now the only way to mark found text was `annotate` with a literal `find` — which
needed the page number up front, matched case-sensitively, and could only highlight.
`highlight` sweeps the whole document (or just `pages`), and picks how each hit is marked:

- **`style`** — `highlight` (default, translucent fill), `underline`, `strikeout`,
  `squiggly`, or `box` (a rectangle around each line of the match; `width` sets its border).
- **`color`** / **`opacity`** — any `"#RRGGBB"`; each style has a sensible default
  (highlighter yellow, red for strikeout, blue for the rest).
- **`note`** / **`author`** — a popup comment on every mark, shown in a viewer's comment list.

The marks are **real PDF annotations**, so they round-trip: `extract_annotations` pulls them
back out (with the text each one covers) and `remove_annotations` clears them. `flatten: true`
bakes them into the page instead — permanent, and no longer visible to either op. As with
`auto_redact`, **`preview: true`** writes a dry-run report of every match and marks nothing —
worth doing first with a regex or a PII preset. Matching is per visual line, so a phrase broken
across a line break won't match; search for a fragment that fits on one line.

## 0.19.22 — Text-span inspection, regex replace + zero-config GitHub Copilot

**`replace_text` gained regex mode.** Set `regex: true` and `find` becomes a regular
expression — re-date a template (`find: "\\d{2}/\\d{2}/\\d{4}"`), mask IDs (`find: "Order
#\\d+"`), etc. — and the `replace` string may reference capture groups (`\\1`, `\\g<name>`).
Literal matching stays the default; `preview: true` still reports every match (now showing
each rewrite) before anything changes.

**New operation: `inspect_text` (now 92 operations).** A read-only op that maps the exact
**text spans** on each page — every span's `text`, bounding box, `origin`, `font`, `size`,
`color` and `bold`/`italic` — to a JSON (or Markdown) report. It gives a coding agent the
numbers it otherwise has to guess: the coordinates for a precise `redact` / `crop` / `stamp`
/ `annotate` / `add_links`, and the font/size/color a `replace_text` should match. Scope it
with `pages` and `terms` (report only spans containing a substring). `origin: top-left`
(default) matches `redact`; `origin: bottom-left` matches `crop`/`stamp`/`annotate`, and each
page carries its `width`/`height` for manual conversion.

**Lynx PDF Studio Automation now shows up in GitHub Copilot / VS Code agent mode with no setup.** Two
native VS Code hooks, both light up automatically on VS Code 1.101+ (older builds are
unaffected):

- **Native MCP registration.** The bundled `pdf-studio` MCP server is now advertised to
  VS Code's own MCP host via `registerMcpServerDefinitionProvider`, so Copilot's agent
  mode gets the deterministic OPW helpers (`opw_validate`, `opw_compile`, `form_*`, …)
  without hand-editing any config. This complements the Claude-Code-style `.mcp.json`
  that "Set Up MCP" writes — Claude Code, Cursor, and Copilot each get the tools in their
  own way, no manual wiring.
- **Copilot chat instructions.** The extension ships a `chatInstructions` file so Copilot
  Chat learns *here, edit the `.opw.yaml`, not the PDF* — byte-for-byte the same OPW
  onboarding the generated `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` give the other agents,
  generated from one source at build time.

## 0.19.20 — The OPW rules engine: variables + conditionals (and 8 new operations)

**One workflow, many jobs — and it decides what to do.** OPW gained the two pieces that
turn a linear script into a rules engine:

- **Variables.** Declare `vars:` (scalar values) and reference them with `${name}` in
  operation params and the output path, so one workflow is a reusable template — edit the
  values, or override them at run time, instead of hand-editing every step. A whole-value
  reference like `size: "${n}"` keeps the number's type. Variables are file-local (they
  never read environment variables).
- **Conditionals.** An operation can carry a `when:` guard — a safe predicate over document
  **facts** and your variables — so it runs only when needed. The headline case: **skip OCR
  when the document already has a text layer** (`when: "has_text == false"`). Facts: `pages`,
  `pdf_version`, `encrypted`, `tagged`, `size_kb` (zero-install) plus `has_text` / `has_images`
  (Python backend). In batch, each file is judged independently.

Your coding agent knows about both now — the generated `CLAUDE.md` / `AGENTS.md` and the
bundled MCP guidance teach it to reach for a variable or a `when:` guard on its own.

**Eight new operations (now 91 across 14 categories):**

- `header_footer` — running headers/footers with page-number, date, and legal **Bates** tokens.
- `insert_pages` / `replace_pages` — insert or swap pages from another PDF at a position.
- `extract_annotations` — export comments/highlights/notes (author, text, page) to JSON + CSV.
- `check_accessibility` — audit PDF/UA (title, language, tags, alt text, tooltips) to a report.
- `add_links` — make bare URLs clickable and add explicit links (the inverse of `extract_links`).
- `convert_colors` — true grayscale / CMYK / RGB conversion via Ghostscript (vectors preserved).
- `set_language` — set the document's default language (`/Lang`) for accessibility.

**Repositioned** as *the agent-native PDF editor — PDFs as code*, across the README and site.

(Earlier 0.19.x builds, not separately noted here, added the MinerU 2.5-Pro and PaddleOCR-VL
document-parsing engines to `extract_markdown` / `pdf_to_markdown`.)

## 0.18.4 — Docs: folder-merge in the operations reference + MCP guidance

Documentation follow-up to 0.18.3 (no engine changes): the operations reference and the
bundled MCP server's guidance now describe merging a whole folder with a glob
(`inputs: [docs/*.pdf]` → one PDF, sorted filename order).

## 0.18.3 — Merge a whole folder

- **`merge` now takes a folder glob.** `inputs: [docs/*.pdf]` merges **every** matching PDF
  into one, in **sorted filename order** — no need to list files. (Previously a glob + merge
  errored; the optimizer also no longer mistakes a glob for a single "no-op" input.) To merge
  specific files in an exact order, list them as before: `inputs: [a.pdf, b.pdf]`.
- New **Merge a folder** example under **Get Example Projects** — a quick start (with sample
  PDFs) that combines a folder of PDFs into one.

## 0.18.2 — Runnable example gallery (clean re-release of 0.18.1)

Clean rebuild of the 0.18.1 engine (OCR & extraction hardening — see below), shipped
alongside a corrected example catalog delivered through **Get Example Projects**:

- The operations gallery now **runs out of the box** — every example ships the small input
  file it needs, instead of referencing illustrative filenames that failed to Render.
  Examples that need your own input (a live URL, a form, an LLM, a signing certificate,
  LibreOffice, or a specific object) are clearly marked.
- **fill-forms** examples clarify that the blank government form is fetched by the PDF Fill
  sidebar (or dropped into `input/`) before rendering.
- New **Redact identity** example — permanently remove a name, address, email, phone, SSN,
  and IP with `auto_redact`.

(The example catalog is served from the CDN, so these fixes also reach 0.18.1; 0.18.2 is a
clean rebuild with a fresh version number.)

## 0.18.1 — OCR & extraction hardening (from real, painful data)

Extracting text/OCR from a real customer deck — 7,609 pages, bilingual English+Hindi, with
pages 28 metres tall and damaged content streams — turned up a class of *silent wrong results
and hard crashes*. This release fixes them so a pathological PDF gets a correct answer (or a
clear message), not a stack trace.

- **No more "Overly large image" crashes.** Oversized pages (a 1-px image scaled to fill a
  huge canvas) crashed `rasterize`, `render_pages`, `recolor`, `scanner_effect`, and
  redaction. Rendering now caps the pixel *area*, auto-reducing DPI only as far as needed and
  noting which pages were affected. A generous tier for plain rasterization, a tighter one for
  OCR-bound rendering — so a legitimate A0 sheet is never silently downscaled.
- **OCR that survives damaged PDFs.** On a file with damaged stream lengths, OCRmyPDF OCR'd the
  pages fine but rejected its *own* output — every chunk produced nothing. The `ocr` op now
  repairs such output with pikepdf and (if needed) normalizes the source and retries once.
- **A real `ocr` op.** New `mode: skip-text | redo-ocr | force-ocr`, `output_type: pdf|pdfa`,
  `optimize`, and `page_range`. Requested languages are checked against installed tessdata
  *up front* (with an install hint) instead of failing opaquely mid-run; the Dependencies panel
  now lists which Tesseract languages you have.
- **`text_report` — "does this even need OCR?"** A new read-only op (and additive fields on
  `pdf_info`) reporting per-page char counts, which pages are image-only vs blank vs oversized,
  the scripts present, and a conservative `needs_ocr` with a recommended action. Re-OCR'ing a
  doc that already has a good text layer *degrades* it — now you can tell before you do.
- **`extract_markdown` OCR control** via `ocr: off | auto | force` (default **auto** — OCR only
  a doc with no usable text layer, and *keep* existing text rather than destroying sparse
  labels a prior layer held). markitdown no longer silently writes an empty file on image PDFs;
  one bad page no longer kills the whole run.
- **Remote OCR over HTTP.** `extract_markdown { endpoint: … }` sends the PDF to a Marker/Surya
  HTTP service — chunked and **resumable**: a job killed or interrupted mid-run continues from a
  local cache instead of restarting, with live per-chunk progress. Requires
  `pdfStudio.allowRemoteRender` (it uploads document bytes off-box). A timed-out job returns a
  resumable partial rather than publishing a truncated file. Killed jobs now reap the whole
  process tree (no orphaned Tesseract/SSH).
- **`split` output is zero-padded** (`part_000001.pdf`) so parts sort in page order — a
  **behavior change**: parts are no longer named `part_1.pdf`. Update any workflow that
  hard-codes the old names.

## 0.17.6 — Docs: the Dependencies table tells the whole truth

The README section formerly titled "Execution backends" is now **Dependencies** — matching what
the product itself calls that panel — and the table gains the row it was missing:
**MarkItDown** (any file — Word, Excel, PowerPoint, HTML, EPUB, CSV, images — to Markdown),
which the extension has probed and used all along. Same fix in the Get Started walkthrough.

## 0.17.5 — `replace_text`: find-and-replace, in place

The workflow-shaped answer to "can it edit a PDF?" — no canvas, one line per replacement,
batchable over a folder:

```yaml
- replace_text: { find: "ACME Corp", replace: "Initech LLC" }
```

- The matched text is **truly deleted** (redaction, not a cover-up), and the replacement lands
  on the **original baseline in the original size and colour**. `ignore_case`, `whole_word`,
  and `pages` refine the match; `replace: ""` deletes; `preview: true` reports every match and
  changes nothing.
- **Font honesty:** an embedded, subsetted original font cannot render *new* glyphs, so the
  replacement uses the closest base-14 look — serif originals map to Times, monospace to
  Courier, everything else to Helvetica, keeping bold/italic (read from the span's own flags,
  which are more reliable than subset font names). Use it for utility edits — re-dating a
  template, fixing a recurring typo, swapping an entity name — not typography-preserving ones.
- Matching is per **line** and literal: text that wraps across lines won't match, and the note
  says so when nothing is found. A replacement much wider than what it replaced is warned
  about, with the overflow measured in points.

## 0.17.4 — The whole form lifecycle: make one, fill one, read them all back

Lynx PDF Studio Automation turns PDFs into **programmable build artifacts**: you edit an
**OpenPDF Workflow (OPW)** file — human-readable YAML — and a deterministic engine renders the
result through a `parse → validate → optimize → plan → render` pipeline. The workflow is the
source of truth; the PDF is a build artifact; **git is the undo stack**. Everything runs
**locally**. **79 operations across thirteen categories.**

This release closes the loop on forms. You can now **build** a fillable PDF from a Word
document, **fill** it (or any of 12 real government forms) from your own records, and **read**
a stack of completed ones back into a spreadsheet — all on your machine, nothing uploaded.

### Start here — a Get Started walkthrough

- **Help → Get Started → Lynx PDF Studio Automation.** Four steps, each one command: render a PDF from a
  workflow · fill a real government form from your records · turn a Word doc into a fillable
  PDF and read the answers back as a CSV · light up the optional backends.

### Make a form — `create_form`

Every fillable form used to be one *someone else* authored. Now you make your own: write the
document in **Word** (or Markdown/HTML), type a marker where each field belongs, and get a real
AcroForm PDF. Word controls the layout; the fields are injected after conversion — so the same
operation works for Markdown and HTML too, and there's no OOXML parsing anywhere.

```yaml
inputs:  [onboarding.docx]
operations:
  - office_to_pdf: {}
  - create_form: { debug: true }
output:  { file: output/onboarding-fillable.pdf }
```

- **That's the whole config.** Tags are type names — `[[text]]`, `[[check]]`, `[[date]]`,
  `[[money]]`, `[[sign]]` — used as often as you like. You never invent a unique name: they're
  numbered in reading order (`checkbox_01`, `text_03`…), so tagging a 100-checkbox intake form
  is copy-paste. Fields **size themselves to their table cell** and get a visible border.
- **text · date · money · number · phone · ssn · zip · checkbox · dropdown · listbox ·
  signature.** A typed field is a plain box with a **tooltip** stating what it wants and a
  **length cap** — both work in every viewer and cannot fail. **A generated form contains no
  JavaScript**: a PDF can only police typing with JS, which Chrome/Edge/Preview mostly ignore
  and our own `sanitize` strips — while a picture validator will reject a date you typed
  correctly and throw it away. Validate in the pipeline instead, where nothing can be destroyed.
- **A generated codebook.** `form-map.json` records the text printed beside every field
  (`"near": "I/We would like any REFUND electronically deposited…"`), so you always know which
  `checkbox_47` is which question. `debug: true` outlines every field so you can see where they
  landed; `preview: true` dry-runs and writes no PDF.
- **It fails loudly rather than shipping a broken form.** A marker too long for its column is
  *clipped* by the renderer — a naive tool then creates no field **and** bakes a mangled
  `[[emplo` into the page while reporting success. The run stops and names the tag. Duplicate
  tags, undeclared tags, rotated pages, off-page and overlapping fields are all reported.
- **`[[sign]]` creates a real signature field** — hand it to `sign` (pyHanko) for a complete
  local signing pipeline, no cloud round-trip.
- Verified on a real 4-page accounting-firm tax worksheet: **117 fields** (95 checkboxes, 22
  text) across Yes/No tables, checklists, a quarterly-payments grid and contact rows — layout,
  logo and typography untouched.

### Fill a form — `fill_form`, now with 12 forms and a spreadsheet

- **12 real forms across 4 categories**, mapped to their actual field names so you don't have to
  know that a W-9's name box is `topmostSubform[0].Page1[0].f1_01[0]`: **Passport** (DS-11,
  DS-82) · **Tax** (1040, **Schedule C**, **Schedule SE**, W-9, **W-8BEN**, W-4, W-7 ITIN,
  1099-NEC) · **Employment** (I-9) · **Immigration** (I-765 EAD). The freelancer set chains:
  1099-NEC → Schedule C → Schedule SE fills end to end from one set of values, and W-9/W-8BEN
  are the U.S. and foreign-vendor counterparts you hand a payer.
- **Records from a spreadsheet.** A household has a `people.yaml`; a business has a CSV already
  exported from a system that holds the data. `records: vendors.csv` now works — one row per
  record, column headers as the field keys. Headers normalise the way humans title them
  (`First Name` → `first_name`), dotted headers nest so a flat sheet carries the address block
  (`address.city`), and RFC 4180 quoting, embedded newlines and Excel's BOM are handled.
- The pack handles the hard parts: shared-name **radio groups**, **split** fields (SSN across
  boxes, dates into M/D/Y), **dropdowns**, date masks, comb/`maxlen` truncation, and
  **multi-copy** forms (1099-NEC's four copies fill from one set of values).
- **Form packs record their provenance** — `source_url` + `captured`, the issuer's canonical URL
  for the blank and the date the field snapshot was taken, so a new revision can be diffed
  against what a pack was built from.

### Read them back — `extract_form`

- **The inverse of `fill_form`.** Point at one PDF or a whole folder (`inputs: ["intake/*.pdf"]`
  — all matches fold into **one table**) and get structured data out. Each PDF is auto-identified
  from its field signature, so a folder of mixed forms works.
- **JSON *and* CSV, every run.** Per-form JSON plus a combined `forms.json`, and **one CSV per
  form type** (`w9.csv`, `f1040.csv`) — unrelated schemas never share a table. A CSV's columns
  come from the pack in the form's own field order, so the **header is stable across runs** and
  a downstream table built once keeps working.
- **A form you built with `create_form` needs no pack at all** — nothing matches it, so its
  fields are read **raw** (field name → value) into `raw.csv`, which is exactly right because
  its field names *are* the keys. Template → fillable → filled → CSV, with nothing authored.
- **Bulk with stop/resume.** `forms.json` doubles as a ledger keyed by **content hash**: drop new
  files in and run again, and only the new or changed forms are read. Walk a 500-form backlog in
  as many sittings as you like.

### Read, search & understand

- **`semantic_search` — ask a PDF a question.** Find passages by *meaning*, not keywords, ranked
  **with page numbers**. Embeds with a **local** model (`nomic-embed-text` via Ollama); a repeat
  search reuses cached embeddings. Nothing leaves your machine.
- **`summarize` & `translate`** via a local LLM by default, or Claude with an API key;
  `translate: { layout: true }` keeps the layout. Opt-in behind `pdfStudio.allowAiRequests`.
- **Cleaner text extraction** (`extract_text: { clean: true }` strips running headers/footers,
  rejoins hyphen-split words, reflows hard wraps) and **AI OCR for scans (Marker)** with an
  optional **remote-GPU offload** over SSH.

### Dark mode & appearance

- **`recolor: { mode: dark }`** — a real dark mode for reading: light-on-dark text, while
  embedded **photos and logos stay normal** instead of becoming negatives. `invert` and
  `grayscale` too. **`scanner_effect`** makes a born-digital PDF look scanned.

### Redaction & security inspection

- **`redact` / `auto_redact` that truly delete.** Match by exact `text`, named PII **`patterns`**
  (`ssn`, `email`, `phone`, `credit_card`, `ein`, `ipv4`, `iban`), or custom `regex`.
  **`rasterize: true`** flattens to an image-only PDF so nothing hidden survives; `preview: true`
  lists every match first.
- **`extract_js`** reports embedded JavaScript for inspection; **`sanitize`** strips JS,
  metadata, embedded files, and links.

### Compare, convert & assemble

- **`compare_pdfs`** — page-aligned text diff plus a precise visual diff; `side_by_side: true`
  assembles one shareable `diff.pdf`.
- **Convert to/from PDF.** Office (docx/xlsx/pptx), HTML, Markdown, URL, `.eml`, EPUB, and images
  (PNG/JPEG/WEBP/TIFF/GIF/BMP/SVG, HEIC with pillow-heif) → PDF; PDF →
  DOCX/PPTX/XLSX/HTML/Markdown/SVG/EPUB.
- **`split_invoices`** — one file per invoice, named from the detected number/vendor/date.
- Merge, split, delete/reorder/rotate/flip/insert/extract pages, crop, scale, `n_up`, booklet,
  poster, watermark, stamp, `annotate`, metadata, bookmarks, tables, page numbers,
  `set_view_preferences`, compress, linearize, repair, PDF/A, OCR, encrypt/decrypt, permissions,
  and digital signatures (`sign` / `validate_signature` / `timestamp`).
- **Batch** a whole workflow over many files with a glob in `inputs` → per-input outputs, one bad
  file skipped and reported. An op can declare `consumesAllInputs`, so a glob feeds **one** run
  instead of running once per file — the mechanism behind `extract_form`'s single table.

### Rendering, UI & backends

- **Bundled pdf-lib** renders layout/stamps/watermarks/metadata and PNG/JPEG→PDF with **zero
  dependencies**; **live pdf.js preview** re-renders on save. Guided **Add Operation**, a
  searchable **Operations** panel, per-operation **Documentation**, a **PDF Fill** catalog, and a
  colour-coded **Dependencies** view for optional backends (Python/PyMuPDF, Ghostscript/qpdf,
  Tesseract, LibreOffice, Chrome/Edge, pyHanko, Marker, Calibre).

### Agent-native (MCP)

- A local **MCP server** exposes deterministic OPW helpers (`opw_validate`, `opw_compile`,
  `opw_optimize`, `opw_diff`, `opw_scaffold`, `opw_operations`) plus form tools (`form_list`,
  `form_fields`, `form_people`, `form_scaffold`). It **never renders or writes files**.
- A generated **agent map** (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`) teaches a coding agent the
  OPW vocabulary and ready recipes — redact-and-share, fill-a-form, make-a-form, ask-a-PDF, batch.

### Security & privacy

- **Untrusted-workflow hardening.** Input/output/asset paths (including the records file,
  `output.folder`, and batch globs) are confined to the project — no `..`/absolute/UNC escape;
  the Python interpreter is pinned; `pythonPath` / `allowRemoteRender` / `allowAiRequests` are
  machine-scoped; webviews use a strict nonce CSP; `encrypt`/`decrypt`/`sign` secrets use
  `${ENV_VAR}` and never touch a command line, log, or output. DPI is clamped so a crafted
  workflow can't request a memory-exhausting render. Hardened against a **four-part security
  review** (see `docs/security-review.md`).
- **Safe rendering of untrusted content.** HTML→PDF keeps the system browser's exploit sandbox
  **on** and strips `<script>`/embeds/handlers first; **`eml_to_pdf` blocks remote images by
  default** so an email can't phone home with a tracking pixel.
- **Private by design.** New projects auto-gitignore `people.yaml`, `*.people.yaml` and the
  embedding cache, and seed a `.gitattributes` (`*.pdf binary`) so git knows what it's storing.
  AI ops stay local (Ollama) unless you opt in. **Anonymous, opt-out telemetry** keyed only by
  `machineId` — **no** paths, contents, names, or personal data.

Verified end-to-end by a real VS Code integration harness (`npm run verify`): 145 engine tests,
a 25-test form-creation suite, and a live VS Code that installs the built extension and drives
its commands.
