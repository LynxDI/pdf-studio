# Changelog

Notable changes to Lynx PDF Studio Automation.

## 0.27.7 — 2026-07-29

**The first release whose source is public**, at
[github.com/LynxDI/pdf-studio](https://github.com/LynxDI/pdf-studio) under
AGPL-3.0-or-later. That satisfies AGPL §6 — the corresponding source has to be
offered to anyone the binary reaches — and it means the engine that renders your
documents can now be read, audited and forked by anyone who cares to.

Publishing the source meant reviewing it as if someone hostile already had it.
That review found four issues, all fixed here. **Please update.**

### Security

Each of these is reachable from an untrusted workflow or a hostile example
manifest — the case this engine exists to defend, since the whole premise is that
an agent writes the `.opw.yaml` and you render it. All require a workspace you
have trusted; VS Code's Restricted Mode blocks the extension entirely until then.

- **Example downloads could write outside your workspace.** The folder name for
  each downloaded example came from the manifest without validation, so a
  manifest served from a redirected `pdfStudio.examplesUrl` could walk the
  extraction target out of the project — into a Startup folder, say. Example ids
  are now validated, the destination is confined the same way the archive's own
  entries always were, and `pdfStudio.examplesUrl` is https-only and
  machine-scoped so a workspace cannot redirect it.

- **A workflow could write into `.git/`, `.vscode/` and similar.** Path
  confinement kept workflows inside their own directory — but when that directory
  is a repository root, `.git/hooks/pre-commit` is *already* inside it. No
  traversal required, just an ordinary relative path, and your next commit runs
  it. Writes into `.git`, `.hg`, `.svn`, `.vscode`, `.github` and
  `.lynx-pdf-studio` are now refused, reported before a render starts and
  enforced again on the resolved path, so `output/../.git/hooks/x` is caught too.

- **`url_to_pdf` could reach your own network.** It accepted any URL, including
  `169.254.169.254` (cloud instance metadata), services on `localhost`, and
  addresses on your LAN. The target is now resolved and checked before any engine
  fetches it, with redirects re-checked at every hop. Rendering public pages — the
  point of the operation — is unaffected; intranet rendering needs
  `pdfStudio.allowRemoteRender`.

- **`sanitize: false` is no longer accepted from a workflow.** The HTML sanitizer
  exists to defend against HTML the workflow author controls, so that same author
  could not also be the one waiving it. It is honoured only when remote render is
  enabled.

### Changed

- **Telemetry is off by default.** It was opt-out; it is now opt-in. Nothing is
  reported unless you turn on `pdfStudio.telemetry.enabled`, and it stays
  anonymous when you do — which features and operations get used, never file
  names, paths, or contents. A local-first document tool should not report
  anything you did not ask it to.
- **Every operation now gets fail-fast path validation.** An escaping `to` path
  used to fail partway through a render on about fifteen operations; it is caught
  in the editor now, like the rest.
- **Bundled licence texts ship.** `THIRD-PARTY-LICENSES.txt` carries the full
  licence of every component compiled into the extension — required by MIT and by
  Apache-2.0 §4(a), and previously only referenced rather than included.
- **`docs/security.md` corrected** where it described intent rather than the
  code: it had claimed `.git/hooks` was already protected, promised a two-layer
  path check that existed for four operations, and warned that the headless
  browser runs with `--no-sandbox` when in fact the sandbox stays on unless
  Chrome reports it cannot start.

---

## Before 0.27.7

Earlier releases are summarised here by what they built rather than version by
version; the per-version history through 0.27.7 is kept by the maintainers.
Versions up to 0.27.6 were published to the Marketplace with the source closed.

**The OPW language.** Workflows are YAML: `inputs`, an ordered list of
`operations`, an `output`. A glob in `inputs` runs the whole workflow once per
matched file; `merge` instead folds a whole folder into one document. `vars`
declare values reused across params and output paths, `when:` guards run an
operation only if a predicate over document facts holds, and output paths take
`{stem}`/`{name}`/`{i}` templates. Unknown fields survive a parse–serialize round
trip, so a newer file stays readable by an older client.

**100 operations across 14 categories** — page surgery (merge, split, n-up,
booklet, poster, crop, rotate, reorder), stamps and overlays (watermark, page
numbers, headers/footers, highlight, annotate), metadata and bookmarks,
extraction (text, tables, images, links, attachments, form fields), OCR,
redaction, forms, encryption and permissions, optimisation and repair, PDF/A,
conversion into and out of PDF, digital signatures, and AI-assisted
summarise/translate/search.

**Forms.** Twelve US government forms — W-9, W-4, I-9, 1040, DS-11, DS-82, W-7,
W-8BEN, 1099-NEC, Schedule C, Schedule SE, I-765 — ship pre-mapped to their real
field names. Records come from a local `people.yaml` or an existing CSV, and one
record fills any of them. You can also author your own fillable form by typing
`[[text]]` and `[[check]]` markers in Word or Markdown, and read completed forms
back out as JSON or CSV.

**OCR and document understanding.** Tesseract for searchable-PDF output; Marker
(Surya), PaddleOCR-VL and MinerU for Markdown with real table structure; Qwen3-VL
for typed receipt and invoice fields. Heavy OCR can be offloaded to a GPU box you
own over SSH, or to an HTTP service, both opt-in.

**Backends.** The bundled pdf-lib engine runs everything it can with nothing
installed. PyMuPDF, pikepdf, qpdf, Ghostscript, LibreOffice, Calibre, ffmpeg and
Tesseract are each optional, detected rather than required, and shown in a
colour-coded Dependencies view that says which ones actually matter for the
workflow in front of you.

**Agent-native.** A bundled MCP server exposes deterministic OPW helpers —
validate, optimize, compile, diff, scaffold — and never renders or touches the
filesystem. Generated `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` teach any coding
agent how to edit PDFs in your project, and GitHub Copilot picks the server up
automatically.

**In VS Code.** A sidebar of workflows and dependencies, a live pdf.js preview
that re-renders on save, a searchable Operations panel with per-operation
documentation, guided parameter entry, a project render log, and a walkthrough.
Plus a CLI that runs the same pipeline from a terminal.

**Determinism throughout.** `parse → validate → optimize → plan → render`. The
plan is a pure function of the workflow and its inputs — previewable, diffable
and content-hashable — so the same workflow and inputs produce the same PDF, and
unchanged work can be skipped.
