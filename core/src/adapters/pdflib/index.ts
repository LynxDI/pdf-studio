// PdfLibAdapter — the bundled, zero-install execution backend.
//
// Implemented in pure JS/WASM (pdf-lib), so structural PDF operations work the
// moment the extension is installed — no Python, no native deps. It advertises
// the capabilities it can honor; everything else (extract_text, OCR, true
// redaction, deep compression) is left to an opt-in Python adapter, and the
// compiler reports those as "unsatisfied" until that backend is present.
//
// Every op is a pure bytes → bytes transform on ctx.current (except `split`,
// which emits sibling artifacts). Page params are 1-based in OPW and converted
// to 0-based here; out-of-range pages are skipped with a note rather than
// throwing, so one stray page number doesn't abort a batch. The exception is
// `reorder_pages`, where an incomplete list means silent page loss — it throws.

import { PDFDocument, PDFName, PDFString, PageSizes, StandardFonts, degrees, rgb, type PDFPage } from "pdf-lib";
import type { DocumentKind } from "../../opw/model.js";
import type { Capability } from "../../opw/operations.js";
import type { PlanStep } from "../../opw/compile.js";
import type { AdapterResult, ExecContext, RendererAdapter } from "../adapter.js";
import { expandPageIndices } from "../../opw/pages.js";
import { renderTemplate, parseByteSize, formatByteSize } from "../../opw/template.js";
import { winAnsiSanitize, wrapText } from "./text.js";
import type { PDFFont } from "pdf-lib";
// (parseByteSize/formatByteSize are shared with split's size packing and the CLI adapter's
//  compression ladder, so one unit vocabulary covers every size constraint in the engine.)
import { PDFLIB_CAPABILITIES } from "../capabilities.js";
import * as nodePath from "node:path";

export class PdfLibAdapter implements RendererAdapter {
  readonly id = "pdf-lib";
  readonly kinds: readonly DocumentKind[] = ["pdf"];
  readonly capabilities: readonly Capability[] = PDFLIB_CAPABILITIES;

  async isAvailable(): Promise<boolean> {
    return true; // bundled — always available
  }

  async apply(ctx: ExecContext, step: PlanStep): Promise<AdapterResult> {
    switch (step.op) {
      case "merge":
        return this.merge(ctx, step);
      case "delete_pages":
        return this.deletePages(ctx, step);
      case "extract_pages":
        return this.extractPages(ctx, step);
      case "reorder_pages":
        return this.reorderPages(ctx, step);
      case "move_pages":
        return this.movePages(ctx, step);
      case "swap_pages":
        return this.swapPages(ctx, step);
      case "rotate_pages":
        return this.rotatePages(ctx, step);
      case "insert_blank":
        return this.insertBlank(ctx, step);
      case "title_page":
        return this.titlePage(ctx, step);
      case "insert_pages":
        return this.insertPages(ctx, step);
      case "replace_pages":
        return this.replacePages(ctx, step);
      case "watermark":
        return this.watermark(ctx, step);
      case "set_metadata":
        return this.setMetadata(ctx, step);
      case "set_language":
        return this.setLanguage(ctx, step);
      case "compress":
        return this.compress(ctx, step);
      case "split":
        return this.split(ctx, step);
      case "crop":
        return this.crop(ctx, step);
      case "scale_pages":
        return this.scalePages(ctx, step);
      case "add_page_numbers":
        return this.addPageNumbers(ctx, step);
      case "header_footer":
        return this.headerFooter(ctx, step);
      case "stamp":
        return this.stamp(ctx, step);
      case "n_up":
        return this.nUp(ctx, step);
      case "overlay":
        return this.overlay(ctx, step);
      case "images_to_pdf":
        return this.imagesToPdf(ctx);
      case "single_page":
        return this.singlePage(ctx, step);
      default:
        throw new Error(`pdf-lib adapter cannot execute "${step.op}"`);
    }
  }

  // --- ops -----------------------------------------------------------------

  private async merge(ctx: ExecContext, step: PlanStep): Promise<AdapterResult> {
    const out = await PDFDocument.create();
    // One copyPages call per source, always: pdf-lib dedupes shared indirect objects
    // (fonts, images) within a single call, so copying page-by-page would bloat the
    // output — which matters most for the image-heavy documents people interleave.
    const docs: PDFPage[][] = [];
    let first: PDFDocument | null = null;
    for (const bytes of ctx.inputs) {
      const src = await PDFDocument.load(bytes, { updateMetadata: false });
      first ??= src; // the combined document inherits the FIRST input's title/author
      const pages = await out.copyPages(src, src.getPageIndices());
      // An empty document contributes nothing — and must not inject a blank into
      // every round of an interleave.
      if (pages.length) docs.push(pages);
    }
    if (first) carryInfoDict(first, out);

    if (!step.params["interleave"]) {
      let total = 0;
      for (const pages of docs) {
        pages.forEach((p) => out.addPage(p));
        total += pages.length;
      }
      return { current: await out.save(), note: `merged ${ctx.inputs.length} input(s) → ${total} pages` };
    }

    // Round-robin across every input: A p1, B p1, A p2, B p2, … Inputs that run out
    // early contribute a blank sized like their own last page, so a downstream n_up
    // keeps pairing the same source in the same cell right to the final sheet.
    const rounds = Math.max(0, ...docs.map((d) => d.length));
    let blanks = 0;
    for (let i = 0; i < rounds; i++) {
      for (const pages of docs) {
        const page = pages[i];
        if (page) {
          out.addPage(page);
        } else {
          const last = pages[pages.length - 1]!;
          out.addPage([last.getWidth(), last.getHeight()]);
          blanks++;
        }
      }
    }
    const note =
      `interleaved ${docs.length} input(s) → ${out.getPageCount()} pages` +
      (blanks ? ` (${blanks} blank pad${blanks === 1 ? "" : "s"})` : "");
    return { current: await out.save(), note };
  }

  private async deletePages(ctx: ExecContext, step: PlanStep): Promise<AdapterResult> {
    const src = await this.loadCurrent(ctx);
    const n = src.getPageCount();
    const drop = new Set(toIndices(step.params["pages"], n));
    const keep = src.getPageIndices().filter((i) => !drop.has(i));
    const out = await copySubset(src, keep);
    return { current: await out.save(), note: `deleted ${drop.size} page(s), ${keep.length} remain` };
  }

  private async extractPages(ctx: ExecContext, step: PlanStep): Promise<AdapterResult> {
    const src = await this.loadCurrent(ctx);
    const n = src.getPageCount();
    const keep = toIndices(step.params["pages"], n);
    const out = await copySubset(src, keep);
    return { current: await out.save(), note: `kept ${keep.length} page(s)` };
  }

  private async reorderPages(ctx: ExecContext, step: PlanStep): Promise<AdapterResult> {
    const src = await this.loadCurrent(ctx);
    const n = src.getPageCount();
    const order = toIndices(step.params["order"], n);
    // A reorder must be a COMPLETE permutation. Anything shorter would quietly
    // delete the pages it left out (the old behavior: order [2,1] on a 10-page
    // document returned 2 pages and reported success). Refuse instead — the ops
    // that legitimately drop or move pages say so in their names.
    const covered = new Set(order);
    if (covered.size !== n) {
      const missing: number[] = [];
      for (let i = 0; i < n && missing.length < 6; i++) if (!covered.has(i)) missing.push(i + 1);
      const shown = missing.slice(0, 5).join(", ") + (missing.length > 5 ? ", …" : "");
      throw new Error(
        `reorder_pages needs every page exactly once: this document has ${n} page(s) but the order covers ${covered.size}` +
          (missing.length ? ` (missing ${shown})` : "") +
          `. Use move_pages to move a few pages, swap_pages to exchange two, or extract_pages to keep a subset.`,
      );
    }
    const out = await copySubset(src, order);
    return { current: await out.save(), note: `reordered ${order.length} page(s)` };
  }

  private async movePages(ctx: ExecContext, step: PlanStep): Promise<AdapterResult> {
    const src = await this.loadCurrent(ctx);
    const n = src.getPageCount();
    const moving = toIndices(step.params["pages"], n);
    if (moving.length === 0) throw new Error("move_pages requires pages: [1-based pages to move]");

    const hasAfter = step.params["after"] !== undefined;
    const hasBefore = step.params["before"] !== undefined;
    if (hasAfter === hasBefore) throw new Error("move_pages requires exactly one of `after` or `before`");
    // The anchor is numbered in the ORIGINAL document — `after: 0` means the start.
    const anchorPage = Math.round(Number(hasAfter ? step.params["after"] : step.params["before"]));
    if (!Number.isInteger(anchorPage)) throw new Error("move_pages `after`/`before` must be a page number");
    const anchorIdx = anchorPage - 1;
    if (hasAfter ? anchorIdx < -1 || anchorIdx >= n : anchorIdx < 0 || anchorIdx >= n) {
      throw new Error(`move_pages ${hasAfter ? "after" : "before"} ${anchorPage} is outside this ${n}-page document`);
    }

    const movingSet = new Set(moving);
    if (movingSet.has(anchorIdx)) {
      throw new Error(
        `move_pages ${hasAfter ? "after" : "before"} ${anchorPage} is itself one of the pages being moved — pick a page that stays put`,
      );
    }

    // Walk the original document, dropping the moved pages and splicing the
    // block in at the anchor. Duplicates in `pages` collapse; the block keeps
    // the order the user wrote, so ["5-9"] and ["9-5"] differ as expected.
    const block = [...new Set(moving)];
    const order: number[] = [];
    if (hasAfter && anchorIdx === -1) order.push(...block); // after: 0 → the very start
    for (let i = 0; i < n; i++) {
      if (movingSet.has(i)) continue;
      if (!hasAfter && i === anchorIdx) order.push(...block);
      order.push(i);
      if (hasAfter && i === anchorIdx) order.push(...block);
    }
    const out = await copySubset(src, order);
    return {
      current: await out.save(),
      note: `moved ${block.length} page(s) ${hasAfter ? "after" : "before"} page ${anchorPage}`,
    };
  }

  private async swapPages(ctx: ExecContext, step: PlanStep): Promise<AdapterResult> {
    const src = await this.loadCurrent(ctx);
    const n = src.getPageCount();
    const a = Math.round(Number(step.params["a"]));
    const b = Math.round(Number(step.params["b"]));
    for (const [label, p] of [["a", a], ["b", b]] as const) {
      if (!Number.isInteger(p) || p < 1 || p > n) {
        throw new Error(`swap_pages ${label} (${step.params[label]}) is outside this ${n}-page document`);
      }
    }
    const order = src.getPageIndices();
    order[a - 1] = b - 1;
    order[b - 1] = a - 1;
    const out = await copySubset(src, order);
    return { current: await out.save(), note: `swapped pages ${a} and ${b}` };
  }

  private async rotatePages(ctx: ExecContext, step: PlanStep): Promise<AdapterResult> {
    const doc = await this.loadCurrent(ctx);
    const n = doc.getPageCount();
    const delta = Number(step.params["degrees"] ?? 0);
    const target = step.params["pages"] ? new Set(toIndices(step.params["pages"], n)) : null;
    const pages = doc.getPages();
    let count = 0;
    pages.forEach((page, i) => {
      if (target && !target.has(i)) return;
      const current = page.getRotation().angle;
      page.setRotation(degrees(normalizeAngle(current + delta)));
      count++;
    });
    return { current: await doc.save(), note: `rotated ${count} page(s) by ${delta}°` };
  }

  private async insertBlank(ctx: ExecContext, step: PlanStep): Promise<AdapterResult> {
    const doc = await this.loadCurrent(ctx);
    const n = doc.getPageCount();
    const at = clamp(Number(step.params["at"] ?? 1) - 1, 0, n);
    const dims = resolvePageSize(step.params["size"], () => {
      // "match" copies the neighbour; clamp so an append (at === n) still finds one.
      const neighbor = doc.getPage(Math.min(at, n - 1));
      return [neighbor.getWidth(), neighbor.getHeight()];
    }, n > 0);
    doc.insertPage(at, dims);
    return { current: await doc.save(), note: `inserted blank page at ${at + 1}` };
  }

  /**
   * Draw a cover page and insert it at `at` (default: the very front).
   *
   * One type knob (`title_size`); the subtitle/author/date sizes and colours derive from it,
   * so a cover with no styling params still looks deliberate. Secondary colours are blended
   * toward the BACKGROUND rather than toward grey — that is what keeps a dark cover readable
   * instead of muddy.
   */
  private async titlePage(ctx: ExecContext, step: PlanStep): Promise<AdapterResult> {
    const doc = await this.loadCurrent(ctx);
    const p = step.params;
    const n = doc.getPageCount();
    const at = clamp(Number(p["at"] ?? 1) - 1, 0, n);

    const family = FONT_FAMILIES[String(p["font"] ?? "Helv")] ?? FONT_FAMILIES["Helv"]!;
    const bold = await doc.embedFont(family.bold);
    const regular = await doc.embedFont(family.regular);

    // Sanitize ONCE, up front, so measuring and drawing can never disagree.
    const replaced: string[] = [];
    const clean = (v: unknown, font: PDFFont): string => {
      if (typeof v !== "string" || !v) return "";
      const r = winAnsiSanitize(font, v);
      for (const ch of r.replaced) if (!replaced.includes(ch)) replaced.push(ch);
      return r.text;
    };
    const title = clean(p["title"], bold);
    const subtitle = clean(p["subtitle"], regular);
    const author = clean(p["author"], regular);
    const date = clean(p["date"], regular);
    if (!title && !subtitle && !author && !p["image"]) {
      throw new Error("title_page needs at least one of title, subtitle, author or image — for an empty page use insert_blank");
    }
    // If a field sanitized down to nothing legible, drawing a page of "?" helps no one.
    if (!/[A-Za-z0-9]/.test(title + subtitle + author + date) && !p["image"]) {
      const ch = replaced[0] ?? "?";
      throw new Error(
        `title_page: "${ch}" (U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}) is outside the ` +
          `built-in PDF fonts' character set (WinAnsi/cp1252) and the bundled backend has no font embedding. ` +
          `For a non-Latin cover, build it with markdown_to_pdf (or html_to_pdf) and add it with ` +
          `insert_pages: { from: cover, at: 1 }.`,
      );
    }

    const dims = resolvePageSize(p["size"], () => {
      const neighbor = doc.getPage(Math.min(at, n - 1));
      return [neighbor.getWidth(), neighbor.getHeight()];
    }, n > 0);
    const [W, H] = dims;
    const margin = clamp(Number(p["margin"] ?? 72), 0, 300);
    const column = Math.max(1, W - margin * 2);
    const align = String(p["align"] ?? "center");
    const bg = hexToRgb(p["background"]);
    const fg = hexToRgb(p["color"]) ?? rgb(0.102, 0.102, 0.102);
    // Blend toward the background (white when unset) so secondary text stays legible on a
    // dark cover — a hardcoded grey would vanish on one.
    const toward = bg ?? rgb(1, 1, 1);
    const mix = (t: number) =>
      rgb(fg.red + (toward.red - fg.red) * t, fg.green + (toward.green - fg.green) * t, fg.blue + (toward.blue - fg.blue) * t);

    let S = clamp(Number(p["title_size"] ?? 36), 6, 288);
    const image = typeof p["image"] === "string" ? await embedImage(doc, ctx.assets[p["image"]] ?? new Uint8Array()) : null;
    if (typeof p["image"] === "string" && !image) {
      throw new Error(`title_page: asset "${String(p["image"])}" is not a PNG or JPEG (or wasn't found) — declare it under assets:`);
    }

    // Lay the block out, shrinking once if it overflows the page.
    let layout = titleLayout({ title, subtitle, author, date, S, bold, regular, column, image, W, p });
    const availH = Math.max(1, H - margin * 2);
    if (layout.height > availH) {
      S = Math.max(6, S * Math.max(0.5, availH / layout.height));
      layout = titleLayout({ title, subtitle, author, date, S, bold, regular, column, image, W, p });
    }

    const page = doc.insertPage(at, dims);
    if (bg) page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: bg });

    // Optical centring: the eye reads "centred" as slightly high, so lift by 1/8 of the slack.
    let top = H - margin - Math.max(0, (availH - layout.height)) * 0.375;
    const drawLines = (lines: string[], font: PDFFont, size: number, color: ReturnType<typeof rgb>, lead: number) => {
      for (const line of lines) {
        const w = font.widthOfTextAtSize(line, size);
        const x = align === "left" ? margin : (W - w) / 2;
        page.drawText(line, { x, y: top - size * 0.8, size, font, color });
        top -= size * lead;
      }
    };

    if (image) {
      const iw = clamp(Number(p["image_width"] ?? Math.min(column, W * 0.4)), 1, column);
      const ih = (image.height / image.width) * iw;
      page.drawImage(image.image, { x: align === "left" ? margin : (W - iw) / 2, y: top - ih, width: iw, height: ih });
      top -= ih + S * 0.75;
    }
    if (layout.titleLines.length) drawLines(layout.titleLines, bold, S, fg, 1.18);
    if (layout.subLines.length) {
      top -= S * 0.55;
      drawLines(layout.subLines, regular, layout.S2, mix(0.4), 1.35);
    }
    if (p["rule"] !== false && (layout.authorLines.length || date)) {
      top -= S * 0.9;
      const rw = Math.min(column, W * 0.25);
      page.drawRectangle({ x: align === "left" ? margin : (W - rw) / 2, y: top, width: rw, height: 1.2, color: mix(0.55) });
      top -= S * 0.7;
    }
    if (layout.authorLines.length) drawLines(layout.authorLines, regular, layout.S3, mix(0.25), 1.35);
    if (date) {
      top -= S * 0.35;
      drawLines([date], regular, layout.S4, mix(0.45), 1.35);
    }

    const note = `title page inserted at ${at + 1}`;
    return {
      current: await doc.save(),
      note: replaced.length
        ? `${note} — ${replaced.length} character(s) the built-in fonts can't draw were replaced with "?": ${replaced.join(", ")}`
        : note,
    };
  }

  /** Load a second PDF referenced by an asset-name param (like overlay's `over`). */
  private async loadAsset(ctx: ExecContext, op: string, name: unknown): Promise<PDFDocument> {
    if (typeof name !== "string") throw new Error(`${op} requires from: <asset PDF name>`);
    const bytes = ctx.assets[name];
    if (!bytes) throw new Error(`${op}: asset "${name}" not found`);
    return PDFDocument.load(bytes);
  }

  private async insertPages(ctx: ExecContext, step: PlanStep): Promise<AdapterResult> {
    const doc = await this.loadCurrent(ctx);
    const src = await this.loadAsset(ctx, "insert_pages", step.params["from"]);
    const n = doc.getPageCount();
    // 1-based `at`; insert BEFORE it. Omit → append at the end (clamp to [0, n]).
    const at = clamp(Number(step.params["at"] ?? n + 1) - 1, 0, n);
    const srcIdx = step.params["pages"] ? toIndices(step.params["pages"], src.getPageCount()) : src.getPageIndices();
    const copied = await doc.copyPages(src, srcIdx);
    copied.forEach((p, k) => doc.insertPage(at + k, p));
    return { current: await doc.save(), note: `inserted ${copied.length} page(s) from "${step.params["from"]}" at ${at + 1}` };
  }

  private async replacePages(ctx: ExecContext, step: PlanStep): Promise<AdapterResult> {
    const doc = await this.loadCurrent(ctx);
    const src = await this.loadAsset(ctx, "replace_pages", step.params["from"]);
    const n = doc.getPageCount();
    const targetIdx = toIndices(step.params["pages"], n); // sorted, de-duplicated, 0-based
    if (targetIdx.length === 0) throw new Error("replace_pages requires pages: [1-based pages to replace]");
    const insertAt = targetIdx[0]!; // drop the replacement where the first removed page was
    const srcIdx = step.params["from_pages"] ? toIndices(step.params["from_pages"], src.getPageCount()) : src.getPageIndices();
    // Insert the replacement first, then remove the (now shifted) originals high→low so
    // earlier removals don't renumber later ones. Every target ≥ insertAt, so all shift by `m`.
    const copied = await doc.copyPages(src, srcIdx);
    copied.forEach((p, k) => doc.insertPage(insertAt + k, p));
    const m = copied.length;
    for (const idx of targetIdx.map((t) => t + m).sort((a, b) => b - a)) doc.removePage(idx);
    return { current: await doc.save(), note: `replaced ${targetIdx.length} page(s) with ${m} from "${step.params["from"]}"` };
  }

  private async watermark(ctx: ExecContext, step: PlanStep): Promise<AdapterResult> {
    const doc = await this.loadCurrent(ctx);
    const n = doc.getPageCount();
    const target = step.params["pages"] ? new Set(toIndices(step.params["pages"], n)) : null;
    const opacity = clamp(Number(step.params["opacity"] ?? 0.15), 0, 1);
    const rotate = Number(step.params["rotate"] ?? 45);
    const pages = doc.getPages();

    if (typeof step.params["image"] === "string") {
      const bytes = ctx.assets[step.params["image"] as string];
      if (bytes) {
        const img = await embedImage(doc, bytes);
        if (img) {
          let count = 0;
          for (let i = 0; i < pages.length; i++) {
            if (target && !target.has(i)) continue;
            const page = pages[i]!;
            const w = page.getWidth() * 0.5;
            const scale = w / img.width;
            page.drawImage(img.image, {
              x: (page.getWidth() - w) / 2,
              y: (page.getHeight() - img.height * scale) / 2,
              width: w,
              height: img.height * scale,
              opacity,
            });
            count++;
          }
          return { current: await doc.save(), note: `image watermark on ${count} page(s)` };
        }
      }
    }

    const text = String(step.params["text"] ?? "");
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const size = 60;
    let count = 0;
    for (let i = 0; i < pages.length; i++) {
      if (target && !target.has(i)) continue;
      const page = pages[i]!;
      const textWidth = font.widthOfTextAtSize(text, size);
      page.drawText(text, {
        x: page.getWidth() / 2 - (textWidth / 2) * Math.cos((rotate * Math.PI) / 180),
        y: page.getHeight() / 2 - (textWidth / 2) * Math.sin((rotate * Math.PI) / 180),
        size,
        font,
        color: rgb(0.5, 0.5, 0.5),
        opacity,
        rotate: degrees(rotate),
      });
      count++;
    }
    return { current: await doc.save(), note: `text watermark "${text}" on ${count} page(s)` };
  }

  private async setMetadata(ctx: ExecContext, step: PlanStep): Promise<AdapterResult> {
    const doc = await this.loadCurrent(ctx);
    const p = step.params;
    if (typeof p["title"] === "string") doc.setTitle(p["title"] as string);
    if (typeof p["author"] === "string") doc.setAuthor(p["author"] as string);
    if (typeof p["subject"] === "string") doc.setSubject(p["subject"] as string);
    if (Array.isArray(p["keywords"])) doc.setKeywords((p["keywords"] as unknown[]).map(String));
    if (typeof p["creator"] === "string") doc.setCreator(p["creator"] as string);
    if (typeof p["producer"] === "string") doc.setProducer(p["producer"] as string);
    return { current: await doc.save(), note: "metadata updated" };
  }

  private async setLanguage(ctx: ExecContext, step: PlanStep): Promise<AdapterResult> {
    const doc = await this.loadCurrent(ctx);
    const lang = String(step.params["lang"] ?? "").trim();
    if (!lang) throw new Error('set_language requires lang (a BCP-47 tag, e.g. "en-US")');
    // /Lang lives on the document catalog (not the Info dict), so set it directly.
    doc.catalog.set(PDFName.of("Lang"), PDFString.of(lang));
    return { current: await doc.save(), note: `set document language to ${lang}` };
  }

  private async compress(ctx: ExecContext, step: PlanStep): Promise<AdapterResult> {
    // Already under a requested target? Don't re-encode at all. Same short-circuit the
    // CLI adapter makes, so the note reads the same whichever backend is installed.
    const want = parseByteSize(step.params["max_size"]);
    if (want !== null && ctx.current!.length <= want) {
      return {
        current: ctx.current!,
        note: `compress: already ${formatByteSize(ctx.current!.length)}, under the ${formatByteSize(want)} target — left unchanged`,
      };
    }
    // pdf-lib can only re-save with object streams (structural compaction).
    // Real image downsampling needs qpdf/Ghostscript via the CLI adapter.
    const doc = await this.loadCurrent(ctx);
    const bytes = await doc.save({ useObjectStreams: true });
    // Never grow the document — a re-save can be larger than a well-packed original.
    const out = bytes.length < ctx.current!.length ? bytes : ctx.current!;
    const base = bytes.length < ctx.current!.length ? "re-saved with object streams (basic compaction)" : "already compact — left unchanged";

    // `max_size` reached the BUNDLED backend, which means no Ghostscript/qpdf is
    // installed. Say that plainly instead of silently ignoring the constraint: a
    // re-save cannot hit a size target, and the user needs to know why.
    const target = parseByteSize(step.params["max_size"]);
    if (target !== null && out.length > target) {
      return {
        current: out,
        note:
          `${base} — ${formatByteSize(out.length)}, still over the ${formatByteSize(target)} target. ` +
          `The bundled engine can only re-save; install Ghostscript for image downsampling, ` +
          `or use split: { max_size: "${formatByteSize(target)}" } to break the file into parts.`,
      };
    }
    return { current: out, note: base };
  }

  private async split(ctx: ExecContext, step: PlanStep): Promise<AdapterResult> {
    const src = await this.loadCurrent(ctx);
    const n = src.getPageCount();
    const maxSize = parseByteSize(step.params["max_size"]);
    const notes: string[] = [];

    // Size-bounded packing needs to SERIALIZE to know a part's size, so it produces its
    // parts and their bytes together; the range modes stay a pure page-list calculation.
    const parts = maxSize
      ? await packBySize(src, n, maxSize, Math.max(1, Math.floor(Number(step.params["min_pages"] ?? 1))), notes)
      : await Promise.all(
          resolveRanges(step.params, n).map(async (r) => ({ pages: r, bytes: await (await copySubset(src, r)).save() })),
        );

    const tpl = typeof step.params["name"] === "string" ? String(step.params["name"]) : null;
    const inputName = nodePath.basename(ctx.inputPaths[0] ?? "document.pdf");
    const inputExt = nodePath.extname(inputName);
    const inputStem = inputName.slice(0, inputName.length - inputExt.length);
    const used = new Set<string>();

    const artifacts: AdapterResult["artifacts"] = [];
    parts.forEach((part, i) => {
      let path: string;
      if (tpl) {
        const first = (part.pages[0] ?? 0) + 1;
        const last = (part.pages[part.pages.length - 1] ?? 0) + 1;
        const rendered = safeFilename(
          renderTemplate(tpl, {
            stem: inputStem, name: inputName, ext: inputExt,
            i: i + 1, start: first, end: last, n: part.pages.length,
          }),
          `part_${String(i + 1).padStart(6, "0")}`,
        );
        // A template with no per-part token would name every part the same; de-duplicate
        // rather than silently overwriting seven of eight outputs.
        let unique = rendered;
        for (let k = 2; used.has(unique); k++) unique = `${rendered}-${k}`;
        used.add(unique);
        path = `__split_named__/${unique}.pdf`;
      } else {
        // Zero-pad so parts sort lexically == page order (part_000001 < part_000010 < part_000100).
        // 6 digits covers per-page splits of the largest decks (48K+ pages) without mis-sorting;
        // the "__split__/part_" prefix is a sentinel resolveArtifactPath / folder-output both strip,
        // yielding e.g. out_000001.pdf / part_000001.pdf.
        path = `__split__/part_${String(i + 1).padStart(6, "0")}.pdf`;
      }
      artifacts.push({ path, bytes: part.bytes, kind: "pdf" });
    });

    const head = maxSize
      ? `split into ${parts.length} file(s), each under ${formatByteSize(maxSize)}`
      : `split into ${parts.length} file(s)`;
    return { artifacts, note: [head, ...notes].join(" · ") };
  }

  private async crop(ctx: ExecContext, step: PlanStep): Promise<AdapterResult> {
    const doc = await this.loadCurrent(ctx);
    const box = step.params["box"];
    if (!Array.isArray(box) || box.length < 4) throw new Error("crop requires box: [x, y, width, height]");
    const x = Number(box[0]);
    const y = Number(box[1]);
    const w = Number(box[2]);
    const h = Number(box[3]);
    const n = doc.getPageCount();
    const target = step.params["pages"] ? new Set(toIndices(step.params["pages"], n)) : null;
    let count = 0;
    doc.getPages().forEach((page, i) => {
      if (target && !target.has(i)) return;
      page.setCropBox(x, y, w, h);
      count++;
    });
    return { current: await doc.save(), note: `cropped ${count} page(s) to [${x}, ${y}, ${w}, ${h}]` };
  }

  private async scalePages(ctx: ExecContext, step: PlanStep): Promise<AdapterResult> {
    const src = await this.loadCurrent(ctx);
    const sizes = NAMED_SIZES;
    const sizeName = step.params["size"] ? String(step.params["size"]) : null;
    const factor = step.params["factor"] != null ? Number(step.params["factor"]) : null;
    const out = await PDFDocument.create();
    const srcPages = src.getPages();
    const embedded = await embedPagesSafe(out, srcPages);
    for (let i = 0; i < srcPages.length; i++) {
      const sp = srcPages[i]!;
      const sw = sp.getWidth();
      const sh = sp.getHeight();
      let tw = sw;
      let th = sh;
      let scale = 1;
      if (sizeName && sizes[sizeName]) {
        [tw, th] = sizes[sizeName]!;
        scale = Math.min(tw / sw, th / sh);
      } else if (factor && factor > 0) {
        scale = factor;
        tw = sw * factor;
        th = sh * factor;
      }
      const page = out.addPage([tw, th]);
      const ep = embedded[i];
      if (ep) {
        const dw = sw * scale;
        const dh = sh * scale;
        page.drawPage(ep, { x: (tw - dw) / 2, y: (th - dh) / 2, width: dw, height: dh });
      }
    }
    carryInfoDict(src, out);
    return { current: await out.save(), note: `scaled ${srcPages.length} page(s)${sizeName ? ` to ${sizeName}` : factor ? ` ×${factor}` : ""}` };
  }

  private async addPageNumbers(ctx: ExecContext, step: PlanStep): Promise<AdapterResult> {
    const doc = await this.loadCurrent(ctx);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pages = doc.getPages();
    const total = pages.length;
    const start = Number(step.params["start"] ?? 1);
    const fmt = String(step.params["format"] ?? "{n} / {total}");
    const size = clamp(Number(step.params["size"] ?? 10), 4, 96);
    const pos = String(step.params["position"] ?? "bottom-center");
    pages.forEach((page, i) => {
      const label = fmt.replace(/\{n\}/g, String(start + i)).replace(/\{total\}/g, String(total));
      const tw = font.widthOfTextAtSize(label, size);
      const pw = page.getWidth();
      const ph = page.getHeight();
      let x = (pw - tw) / 2;
      if (pos.includes("right")) x = pw - tw - 36;
      else if (pos.includes("left")) x = 36;
      const y = pos.includes("top") ? ph - 24 - size : 24;
      page.drawText(label, { x, y, size, font, color: rgb(0.3, 0.3, 0.3) });
    });
    return { current: await doc.save(), note: `numbered ${total} page(s)` };
  }

  private async headerFooter(ctx: ExecContext, step: PlanStep): Promise<AdapterResult> {
    const doc = await this.loadCurrent(ctx);
    const p = step.params;
    const pages = doc.getPages();
    const total = pages.length;
    const start = Number(p["start"] ?? 1);
    const size = clamp(Number(p["size"] ?? 9), 4, 96);
    const margin = clamp(Number(p["margin"] ?? 36), 0, 300);
    const color = hexToRgb(p["color"]) ?? rgb(0.3, 0.3, 0.3);
    const dateStr = typeof p["date"] === "string" ? (p["date"] as string) : "";

    const fonts: Record<string, StandardFonts> = {
      Helv: StandardFonts.Helvetica,
      TiRo: StandardFonts.TimesRoman,
      Cour: StandardFonts.Courier,
    };
    const font = await doc.embedFont(fonts[String(p["font"] ?? "Helv")] ?? StandardFonts.Helvetica);

    // Slot templates. header = top row, footer = bottom row; each has left/center/right.
    const asSlots = (v: unknown): { left: string; center: string; right: string } => {
      const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
      return {
        left: typeof o["left"] === "string" ? (o["left"] as string) : "",
        center: typeof o["center"] === "string" ? (o["center"] as string) : "",
        right: typeof o["right"] === "string" ? (o["right"] as string) : "",
      };
    };
    const header = asSlots(p["header"]);
    const footer = asSlots(p["footer"]);

    // Bates numbering: configure the {bates} token. When bates is set but no slot
    // references {bates}, auto-place it in footer.right (the legal default corner).
    const batesRaw = p["bates"] && typeof p["bates"] === "object" ? (p["bates"] as Record<string, unknown>) : null;
    const bates = batesRaw
      ? {
          start: Number(batesRaw["start"] ?? 1),
          digits: clamp(Math.round(Number(batesRaw["digits"] ?? 6)), 1, 12),
          prefix: batesRaw["prefix"] != null ? String(batesRaw["prefix"]) : "",
          suffix: batesRaw["suffix"] != null ? String(batesRaw["suffix"]) : "",
        }
      : null;
    const allSlots = [header.left, header.center, header.right, footer.left, footer.center, footer.right];
    if (bates && !allSlots.some((s) => s.includes("{bates}")) && !footer.right) footer.right = "{bates}";

    if (!header.left && !header.center && !header.right && !footer.left && !footer.center && !footer.right) {
      return { current: await doc.save(), note: "header_footer: nothing to stamp (no header/footer/bates given)" };
    }

    const target = p["pages"] ? new Set(toIndices(p["pages"], total)) : null;
    const fill = (tpl: string, i: number): string => {
      if (!tpl) return "";
      const batesStr = bates ? `${bates.prefix}${String(bates.start + i).padStart(bates.digits, "0")}${bates.suffix}` : "";
      return tpl
        .replace(/\{n\}/g, String(start + i))
        .replace(/\{total\}/g, String(total))
        .replace(/\{date\}/g, dateStr)
        .replace(/\{bates\}/g, batesStr);
    };

    let count = 0;
    pages.forEach((page, i) => {
      if (target && !target.has(i)) return;
      const pw = page.getWidth();
      const ph = page.getHeight();
      const rowY: Record<"header" | "footer", number> = { header: ph - margin - size, footer: margin };
      let drew = false;
      for (const [row, slots] of [
        ["header", header],
        ["footer", footer],
      ] as const) {
        for (const slot of ["left", "center", "right"] as const) {
          const label = fill(slots[slot], i);
          if (!label) continue;
          const tw = font.widthOfTextAtSize(label, size);
          const x = slot === "left" ? margin : slot === "right" ? pw - tw - margin : (pw - tw) / 2;
          page.drawText(label, { x, y: rowY[row], size, font, color });
          drew = true;
        }
      }
      if (drew) count++;
    });

    const what = bates ? "header/footer + Bates" : "header/footer";
    return { current: await doc.save(), note: `${what} on ${count} page(s)` };
  }

  private async stamp(ctx: ExecContext, step: PlanStep): Promise<AdapterResult> {
    const doc = await this.loadCurrent(ctx);
    const n = doc.getPageCount();
    const target = step.params["pages"] ? new Set(toIndices(step.params["pages"], n)) : null;
    const opacity = clamp(Number(step.params["opacity"] ?? 1), 0, 1);
    const x = Number(step.params["x"] ?? 36);
    const y = Number(step.params["y"] ?? 36);
    const pages = doc.getPages();

    if (typeof step.params["image"] === "string") {
      const bytes = ctx.assets[step.params["image"] as string];
      if (!bytes) throw new Error(`stamp: image asset "${step.params["image"]}" not found`);
      const img = await embedImage(doc, bytes);
      if (!img) throw new Error(`stamp: asset "${step.params["image"]}" is not a PNG/JPEG image`);
      const w = step.params["width"] != null ? Number(step.params["width"]) : img.width;
      const scale = w / img.width;
      let count = 0;
      for (let i = 0; i < pages.length; i++) {
        if (target && !target.has(i)) continue;
        pages[i]!.drawImage(img.image, { x, y, width: w, height: img.height * scale, opacity });
        count++;
      }
      return { current: await doc.save(), note: `image stamp on ${count} page(s)` };
    }

    const text = String(step.params["text"] ?? "");
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const size = clamp(Number(step.params["size"] ?? 24), 4, 288);
    let count = 0;
    for (let i = 0; i < pages.length; i++) {
      if (target && !target.has(i)) continue;
      pages[i]!.drawText(text, { x, y, size, font, color: rgb(0, 0, 0), opacity });
      count++;
    }
    return { current: await doc.save(), note: `text stamp "${text}" on ${count} page(s)` };
  }

  private async nUp(ctx: ExecContext, step: PlanStep): Promise<AdapterResult> {
    const src = await this.loadCurrent(ctx);
    const cols = clamp(Math.round(Number(step.params["cols"] ?? 2)), 1, 8);
    const rows = clamp(Math.round(Number(step.params["rows"] ?? 1)), 1, 8);
    const per = cols * rows;
    const out = await PDFDocument.create();
    const srcPages = src.getPages();
    const embedded = await embedPagesSafe(out, srcPages);
    const first = srcPages[0];
    const pw = first ? first.getWidth() : 595.28;
    const ph = first ? first.getHeight() : 841.89;
    const cellW = pw / cols;
    const cellH = ph / rows;
    for (let i = 0; i < embedded.length; i += per) {
      const page = out.addPage([pw, ph]);
      for (let j = 0; j < per && i + j < embedded.length; j++) {
        const ep = embedded[i + j];
        if (!ep) continue;
        const col = j % cols;
        const row = Math.floor(j / cols);
        const scale = Math.min(cellW / ep.width, cellH / ep.height);
        const dw = ep.width * scale;
        const dh = ep.height * scale;
        const cx = col * cellW + (cellW - dw) / 2;
        const cy = ph - (row + 1) * cellH + (cellH - dh) / 2;
        page.drawPage(ep, { x: cx, y: cy, width: dw, height: dh });
      }
    }
    carryInfoDict(src, out);
    return { current: await out.save(), note: `${cols}×${rows}-up: ${srcPages.length} → ${out.getPageCount()} page(s)` };
  }

  private async overlay(ctx: ExecContext, step: PlanStep): Promise<AdapterResult> {
    const doc = await this.loadCurrent(ctx);
    const overName = step.params["over"];
    if (typeof overName !== "string") throw new Error("overlay requires over: <asset PDF name>");
    const overBytes = ctx.assets[overName];
    if (!overBytes) throw new Error(`overlay: asset "${overName}" not found`);
    const overDoc = await PDFDocument.load(overBytes);
    const embedded = await embedPagesSafe(doc, overDoc.getPages());
    if (embedded.length === 0) throw new Error(`overlay: "${overName}" has no pages`);
    const opacity = clamp(Number(step.params["opacity"] ?? 1), 0, 1);
    const pages = doc.getPages();
    let count = 0;
    for (let i = 0; i < pages.length; i++) {
      const ep = embedded[i % embedded.length];
      if (!ep) continue;
      const page = pages[i]!;
      page.drawPage(ep, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight(), opacity });
      count++;
    }
    return { current: await doc.save(), note: `overlaid "${overName}" on ${count} page(s)` };
  }

  private async imagesToPdf(ctx: ExecContext): Promise<AdapterResult> {
    const out = await PDFDocument.create();
    let count = 0;
    for (const bytes of ctx.inputs) {
      const img = await embedImage(out, bytes);
      if (!img) continue;
      const page = out.addPage([img.width, img.height]);
      page.drawImage(img.image, { x: 0, y: 0, width: img.width, height: img.height });
      count++;
    }
    if (count === 0) throw new Error("images_to_pdf: no embeddable PNG/JPEG images in inputs");
    return { current: await out.save(), note: `built PDF from ${count} image(s)` };
  }

  private async singlePage(ctx: ExecContext, step: PlanStep): Promise<AdapterResult> {
    const src = await this.loadCurrent(ctx);
    const srcPages = src.getPages();
    if (srcPages.length === 0) throw new Error("single_page: document has no pages");
    const gap = clamp(Number(step.params["gap"] ?? 0), 0, 500);
    const out = await PDFDocument.create();
    const embedded = await embedPagesSafe(out, srcPages);
    const widths = srcPages.map((p) => p.getWidth());
    const heights = srcPages.map((p) => p.getHeight());
    const maxW = Math.max(...widths);
    const totalH = heights.reduce((a, b) => a + b, 0) + gap * (srcPages.length - 1);
    const page = out.addPage([maxW, totalH]);
    let y = totalH;
    for (let i = 0; i < embedded.length; i++) {
      const w = widths[i]!;
      const h = heights[i]!;
      y -= h;
      const ep = embedded[i];
      if (ep) page.drawPage(ep, { x: (maxW - w) / 2, y, width: w, height: h });
      y -= gap;
    }
    carryInfoDict(src, out);
    return { current: await out.save(), note: `combined ${srcPages.length} page(s) into one ${Math.round(maxW)}×${Math.round(totalH)}pt page` };
  }

  // --- helpers -------------------------------------------------------------

  private async loadCurrent(ctx: ExecContext): Promise<PDFDocument> {
    if (!ctx.current) throw new Error("no working document — is the first op a load/merge?");
    // `updateMetadata: false` is load-bearing, not a tidy-up. pdf-lib's default rewrites
    // /Producer to "pdf-lib (…)" and stamps /ModDate with the WALL CLOCK on every load, so
    // two identical renders of the same workflow produced different bytes — breaking the
    // determinism the spec promises and the content-hash in hashing.ts depends on. It also
    // silently overwrote the Producer the user's own set_metadata had just written.
    return PDFDocument.load(ctx.current, { updateMetadata: false });
  }
}

type EmbeddedPage = Awaited<ReturnType<PDFDocument["embedPage"]>>;

/** Embed each source page, tolerating contentless/blank pages (which pdf-lib
 *  refuses to embed — it throws at save() time, not at embedPage) by returning
 *  null for them. Callers leave that slot blank rather than aborting the whole
 *  op. Pre-filtering on the /Contents entry is what actually prevents the crash;
 *  the try/catch is a belt-and-suspenders. */
async function embedPagesSafe(out: PDFDocument, pages: ReturnType<PDFDocument["getPages"]>): Promise<(EmbeddedPage | null)[]> {
  const res: (EmbeddedPage | null)[] = [];
  for (const p of pages) {
    let hasContents = false;
    try {
      hasContents = Boolean(p.node.Contents());
    } catch {
      hasContents = false;
    }
    if (!hasContents) {
      res.push(null);
      continue;
    }
    try {
      res.push(await out.embedPage(p));
    } catch {
      res.push(null);
    }
  }
  return res;
}

/** Copy the document Info dictionary from `src` onto `out`.
 *
 *  `copyPages` copies PAGE objects — the Info dict lives on the trailer, so every op built
 *  on copySubset (delete_pages, extract_pages, reorder_pages, move_pages, swap_pages,
 *  split, scale_pages, n_up, single_page) used to drop the title/author on the floor with
 *  no diagnostic: `set_metadata` followed by `delete_pages` silently produced an untitled
 *  PDF. Read through pdf-lib's getters so an absent field stays absent rather than becoming
 *  an empty string. Dates are skipped when unparseable rather than throwing. */
function carryInfoDict(src: PDFDocument, out: PDFDocument): void {
  const str = [
    ["getTitle", "setTitle"],
    ["getAuthor", "setAuthor"],
    ["getSubject", "setSubject"],
    ["getCreator", "setCreator"],
    ["getProducer", "setProducer"],
  ] as const;
  for (const [get, set] of str) {
    try {
      const v = (src as unknown as Record<string, () => string | undefined>)[get]!();
      if (typeof v === "string" && v.length) (out as unknown as Record<string, (s: string) => void>)[set]!(v);
    } catch {
      /* a malformed Info entry must not abort the op */
    }
  }
  try {
    const kw = src.getKeywords();
    // pdf-lib's getter returns the raw joined string; setKeywords takes an array.
    if (typeof kw === "string" && kw.length) out.setKeywords(kw.split(/[,;]\s*/).filter(Boolean));
  } catch {
    /* ignore */
  }
  for (const [get, set] of [["getCreationDate", "setCreationDate"], ["getModificationDate", "setModificationDate"]] as const) {
    try {
      const d = (src as unknown as Record<string, () => Date | undefined>)[get]!();
      if (d instanceof Date && !Number.isNaN(d.getTime())) {
        (out as unknown as Record<string, (d: Date) => void>)[set]!(d);
      }
    } catch {
      /* ignore */
    }
  }
}

async function copySubset(src: PDFDocument, indices: number[]): Promise<PDFDocument> {
  const out = await PDFDocument.create();
  const valid = indices.filter((i) => i >= 0 && i < src.getPageCount());
  const copied = await out.copyPages(src, valid);
  copied.forEach((p) => out.addPage(p));
  carryInfoDict(src, out);
  return out;
}

async function embedImage(
  doc: PDFDocument,
  bytes: Uint8Array,
): Promise<{ image: Awaited<ReturnType<PDFDocument["embedPng"]>>; width: number; height: number } | null> {
  // Sniff PNG magic; otherwise assume JPEG.
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  try {
    const image = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    return { image, width: image.width, height: image.height };
  } catch {
    return null;
  }
}

/** Convert a 1-based page list param to sorted, de-duplicated 0-based indices. */
function toIndices(param: unknown, pageCount: number): number[] {
  // Page lists accept numbers and compact range tokens alike ([1, "5-8", "last"]);
  // expandPageIndices is the single parser shared with the validator.
  return expandPageIndices(param, pageCount);
}

/** Resolve split `ranges` / `every` params into arrays of 0-based indices. */
/** One emitted split part: which source pages it holds, and its serialized bytes. */
interface SplitPart {
  pages: number[];
  bytes: Uint8Array;
}

/**
 * Pack pages greedily into parts that each serialize to under `maxSize` bytes.
 *
 * The only way to know a part's size is to build and save it, so the cost model matters:
 * a naive "add one page, re-save" is O(n²) saves and unusable at 1,500 pages. Instead,
 * for each part we EXPONENTIALLY PROBE outward from an estimate and then BINARY SEARCH
 * the boundary — O(log n) saves per part. The estimate is seeded from the bytes-per-page
 * of the parts already emitted, so after the first part the probe starts near the answer
 * instead of at 1.
 *
 * Sizes are not additive: pdf-lib copies shared resources (fonts, ICC profiles) into every
 * part, so the parts sum to MORE than the original, and a part's size is not the sum of its
 * pages' sizes. That is exactly why this measures instead of estimating and stopping.
 *
 * A single page that cannot fit is emitted alone with a warning rather than failing the
 * run — a 6 MB scan in the middle of a 1,500-page filing must not cost someone their
 * deadline. Everything else still lands under the cap.
 */
async function packBySize(
  src: PDFDocument,
  n: number,
  maxSize: number,
  minPages: number,
  notes: string[],
): Promise<SplitPart[]> {
  const parts: SplitPart[] = [];
  const build = async (start: number, count: number): Promise<Uint8Array> =>
    (await copySubset(src, range(start, Math.min(start + count, n)))).save();

  const oversized: number[] = [];
  let bytesPerPage = 0; // running estimate, 0 until the first part is measured
  let start = 0;

  while (start < n) {
    const remaining = n - start;
    // Seed from the running estimate; clamp into [1, remaining].
    let lo = 1; // known to fit (verified below) — pages, not index
    let loBytes: Uint8Array | null = null;
    let guess = bytesPerPage > 0 ? clamp(Math.floor(maxSize / bytesPerPage), 1, remaining) : 1;

    // Does even one page fit? If not, emit it alone and move on.
    const onePage = await build(start, 1);
    if (onePage.byteLength > maxSize) {
      oversized.push(start + 1);
      parts.push({ pages: range(start, start + 1), bytes: onePage });
      start += 1;
      continue;
    }
    loBytes = onePage;

    // Exponential probe upward for the first count that does NOT fit.
    let hi = -1; // smallest known-too-big count
    let count = Math.max(1, guess);
    while (count <= remaining) {
      const bytes = await build(start, count);
      if (bytes.byteLength <= maxSize) {
        lo = count;
        loBytes = bytes;
        if (count === remaining) { hi = remaining + 1; break; } // everything left fits
        count = Math.min(count * 2, remaining);
        if (count === lo) { hi = remaining + 1; break; }
      } else {
        hi = count;
        break;
      }
    }
    if (hi === -1) hi = remaining + 1;

    // Binary search the boundary in (lo, hi).
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const bytes = await build(start, mid);
      if (bytes.byteLength <= maxSize) {
        lo = mid;
        loBytes = bytes;
      } else {
        hi = mid;
      }
    }

    // `min_pages` is a floor on part size, deliberately allowed to exceed max_size — a
    // user who sets it is choosing chunk shape over the cap, and the note says so.
    const take = Math.max(lo, Math.min(minPages, remaining));
    const bytes = take === lo && loBytes ? loBytes : await build(start, take);
    if (take > lo) notes.push(`min_pages: ${take} page(s) kept together, exceeding the size cap`);
    parts.push({ pages: range(start, start + take), bytes });

    // Refine the estimate from what we just measured.
    bytesPerPage = bytes.byteLength / take;
    start += take;
  }

  if (oversized.length) {
    const shown = oversized.slice(0, 5).join(", ");
    const more = oversized.length > 5 ? ` (+${oversized.length - 5} more)` : "";
    notes.push(
      `page(s) ${shown}${more} exceed the limit on their own and were written as single-page parts — ` +
        `add compress or rasterize before split to bring them down`,
    );
  }
  return parts;
}

/** Font families available to the bundled backend, by the PDF base-font shorthand
 *  `header_footer` already established as the param vocabulary. */
const FONT_FAMILIES: Record<string, { regular: StandardFonts; bold: StandardFonts }> = {
  Helv: { regular: StandardFonts.Helvetica, bold: StandardFonts.HelveticaBold },
  TiRo: { regular: StandardFonts.TimesRoman, bold: StandardFonts.TimesRomanBold },
  Cour: { regular: StandardFonts.Courier, bold: StandardFonts.CourierBold },
};

/** Wrapped lines and derived type sizes for a cover page, plus the block's total height
 *  so the caller can centre it (and shrink once if it doesn't fit). */
function titleLayout(a: {
  title: string; subtitle: string; author: string; date: string;
  S: number; bold: PDFFont; regular: PDFFont; column: number;
  image: { width: number; height: number } | null; W: number; p: Record<string, unknown>;
}): { titleLines: string[]; subLines: string[]; authorLines: string[]; S2: number; S3: number; S4: number; height: number } {
  const { S } = a;
  const S2 = Math.max(9, Math.round(S * 0.5));
  const S3 = Math.max(9, Math.round(S * 0.42));
  const S4 = Math.max(8, Math.round(S * 0.33));
  const titleLines = wrapText(a.bold, a.title, S, a.column);
  const subLines = wrapText(a.regular, a.subtitle, S2, a.column);
  const authorLines = wrapText(a.regular, a.author, S3, a.column);

  let h = 0;
  if (a.image) {
    const iw = clamp(Number(a.p["image_width"] ?? Math.min(a.column, a.W * 0.4)), 1, a.column);
    h += (a.image.height / a.image.width) * iw + S * 0.75;
  }
  h += titleLines.length * S * 1.18;
  if (subLines.length) h += S * 0.55 + subLines.length * S2 * 1.35;
  if (a.p["rule"] !== false && (authorLines.length || a.date)) h += S * 0.9 + 1.2 + S * 0.7;
  if (authorLines.length) h += authorLines.length * S3 * 1.35;
  if (a.date) h += S * 0.35 + S4 * 1.35;
  return { titleLines, subLines, authorLines, S2, S3, S4, height: h };
}

/**
 * The page sizes OPW's `size` params advertise, resolved from pdf-lib's own table so there
 * is exactly one set of numbers in the codebase. Previously `scale_pages` had A4/Letter/Legal
 * inline while `insert_blank` hardcoded only A4/Letter and silently ignored Legal.
 */
const NAMED_SIZES: Record<string, [number, number]> = {
  A4: [PageSizes.A4[0], PageSizes.A4[1]],
  Letter: [PageSizes.Letter[0], PageSizes.Letter[1]],
  Legal: [PageSizes.Legal[0], PageSizes.Legal[1]],
};

/**
 * Turn a `size` param into page dimensions. `"match"` (the established sentinel for "copy
 * the neighbouring page") calls `matcher`, but only when `canMatch` — a document with no
 * pages has no neighbour, so it falls back to A4 the way insert_blank always has.
 */
function resolvePageSize(
  size: unknown,
  matcher: () => [number, number],
  canMatch: boolean,
): [number, number] {
  const name = String(size ?? "match");
  if (name === "match") return canMatch ? matcher() : NAMED_SIZES["A4"]!;
  return NAMED_SIZES[name] ?? NAMED_SIZES["A4"]!;
}

/** Make a rendered template safe to use as a filename: no separators, traversal, control
 *  characters, Windows-illegal characters or reserved device names. Falls back to
 *  `fallback` if nothing usable survives. */
function safeFilename(s: string, fallback: string): string {
  let out = s
    .replace(/[/\\]+/g, "-")
    .replace(/\.\.+/g, ".")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f<>:"|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(out)) out = `${out}_`;
  if (out.length > 120) out = out.slice(0, 120).trim();
  return out.length ? out : fallback;
}

function resolveRanges(params: Record<string, unknown>, n: number): number[][] {
  if (Array.isArray(params["ranges"])) {
    return (params["ranges"] as unknown[]).map((r) => parseRange(String(r), n));
  }
  const every = Number(params["every"] ?? 0);
  if (every >= 1) {
    const out: number[][] = [];
    for (let start = 0; start < n; start += every) {
      out.push(range(start, Math.min(start + every, n)));
    }
    return out;
  }
  return [range(0, n)];
}

function parseRange(spec: string, n: number): number[] {
  const m = spec.split("-");
  const lo = clamp(Number(m[0]) - 1, 0, n - 1);
  const hi = clamp(Number(m[1] ?? m[0]) - 1, 0, n - 1);
  return range(Math.min(lo, hi), Math.max(lo, hi) + 1);
}

function range(startIncl: number, endExcl: number): number[] {
  const out: number[] = [];
  for (let i = startIncl; i < endExcl; i++) out.push(i);
  return out;
}

function normalizeAngle(a: number): number {
  return ((Math.round(a / 90) * 90) % 360 + 360) % 360;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Parse a "#RRGGBB" (or "RRGGBB") string into a pdf-lib rgb color, or null. */
function hexToRgb(v: unknown): ReturnType<typeof rgb> | null {
  if (typeof v !== "string") return null;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(v.trim());
  if (!m) return null;
  const int = parseInt(m[1]!, 16);
  return rgb(((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255);
}
