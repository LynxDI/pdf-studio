// CliCompressAdapter — deep PDF compression via Ghostscript (preferred) or qpdf.
//
// pdf-lib can only re-save (weak). When Ghostscript or qpdf is installed this
// adapter downsamples/recompresses for real size reductions. It advertises only
// `compress`; register it BEFORE pdf-lib so compress resolves here when a tool
// is available, and falls back to pdf-lib's re-save otherwise. Executables are
// found via the shared augmented PATH (versioned Program Files installs, Scoop
// shims, winget Links) so a bare extension-host PATH still locates them.

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { PDFDocument } from "pdf-lib";
import type { Capability } from "../../opw/operations.js";
import type { DocumentKind } from "../../opw/model.js";
import type { PlanStep } from "../../opw/compile.js";
import type { AdapterResult, ExecContext, RendererAdapter } from "../adapter.js";
import { envWithToolPath } from "../../deps/check.js";
import { parseByteSize, formatByteSize } from "../../opw/template.js";

const CAPABILITIES: Capability[] = ["compress", "convert_colors"];

/** Ghostscript color-conversion recipes: OPW mode → (strategy, process model). */
const COLOR_MODES: Record<string, { strategy: string; model: string }> = {
  gray: { strategy: "Gray", model: "/DeviceGray" },
  cmyk: { strategy: "CMYK", model: "/DeviceCMYK" },
  rgb: { strategy: "RGB", model: "/DeviceRGB" },
};

/** Ghostscript's console binary is named differently per platform. */
const GS_BINS = process.platform === "win32" ? ["gswin64c", "gswin32c", "gs"] : ["gs"];

/**
 * Quality rungs, best first. `max_size` walks DOWN this ladder until the output fits.
 *
 * The last two rungs override `-dColorImageResolution` explicitly, which the stock
 * `-dPDFSETTINGS` presets never do — /screen bottoms out around 72 dpi and simply cannot
 * go further. That is where a real size target is either met or honestly reported as
 * unreachable, and it is the whole reason this is a ladder rather than a preset picker.
 */
const GS_LADDER: Array<{ label: string; setting: string; imageDpi?: number }> = [
  { label: "prepress", setting: "/prepress" },
  { label: "printer", setting: "/printer" },
  { label: "ebook", setting: "/ebook" },
  { label: "screen", setting: "/screen" },
  { label: "screen @72dpi", setting: "/screen", imageDpi: 72 },
  { label: "screen @50dpi", setting: "/screen", imageDpi: 50 },
];

/** Where on the ladder a 1..100 `quality` starts. max_size never climbs ABOVE this —
 *  it is the ceiling the author asked for, and only degrades from there as needed. */
function ladderStart(quality: number): number {
  if (quality > 90) return 0; // prepress
  if (quality > 75) return 1; // printer
  if (quality > 40) return 2; // ebook
  return 3; // screen
}

interface Tool {
  kind: "ghostscript" | "qpdf";
  exe: string;
}

interface RunResult {
  code: number;
  stderr: string;
}

/** Spawn with the augmented PATH; resolve with exit code (127 if unspawnable). */
function run(exe: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let stderr = "";
    let done = false;
    const finish = (code: number) => {
      if (!done) {
        done = true;
        resolve({ code, stderr });
      }
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(exe, args, { windowsHide: true, env: envWithToolPath() });
    } catch {
      finish(127);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish(124);
    }, timeoutMs);
    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.on("error", () => {
      clearTimeout(timer);
      finish(127);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code ?? 0);
    });
  });
}

function kb(n: number): string {
  return `${(n / 1024).toFixed(0)}KB`;
}

/** Page count, or null if the bytes aren't a loadable PDF. */
async function pageCount(bytes: Uint8Array): Promise<number | null> {
  try {
    return (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount();
  } catch {
    return null;
  }
}

export class CliCompressAdapter implements RendererAdapter {
  readonly id = "cli-compress";
  readonly kinds: readonly DocumentKind[] = ["pdf"];
  readonly capabilities: readonly Capability[] = CAPABILITIES;
  private tool: Tool | null = null;
  private resolved = false;

  async isAvailable(): Promise<boolean> {
    if (!this.resolved) {
      this.tool = await this.resolveTool();
      this.resolved = true;
    }
    return this.tool !== null;
  }

  private async resolveTool(): Promise<Tool | null> {
    for (const exe of GS_BINS) {
      const res = await run(exe, ["--version"], 6000);
      if (res.code === 0) return { kind: "ghostscript", exe };
    }
    const q = await run("qpdf", ["--version"], 6000);
    if (q.code === 0) return { kind: "qpdf", exe: "qpdf" };
    return null;
  }

  async apply(ctx: ExecContext, step: PlanStep): Promise<AdapterResult> {
    if (!ctx.current) throw new Error(`cli-compress: no working document for "${step.op}"`);
    if (!(await this.isAvailable()) || !this.tool) {
      throw new Error("cli-compress: no Ghostscript/qpdf available");
    }
    if (step.op === "convert_colors") return this.convertColors(ctx, step);
    const target = parseByteSize(step.params["max_size"]);
    if (target !== null) return this.compressToSize(ctx, step, target);
    const tmpDir = await mkdtemp(nodePath.join(os.tmpdir(), "opw-compress-"));
    const inPdf = nodePath.join(tmpDir, "in.pdf");
    const outPdf = nodePath.join(tmpDir, "out.pdf");
    const before = ctx.current.length;
    try {
      await writeFile(inPdf, ctx.current);
      const res =
        this.tool.kind === "ghostscript"
          ? await this.runGhostscript(inPdf, outPdf, step.params)
          : await this.runQpdf(inPdf, outPdf);
      // qpdf exits 3 on warnings but still writes valid output; gs exits 0.
      const ok = this.tool.kind === "qpdf" ? res.code === 0 || res.code === 3 : res.code === 0;
      if (!ok) throw new Error(`${this.tool.kind} exited ${res.code}${res.stderr ? `: ${res.stderr.trim().slice(-300)}` : ""}`);

      const bytes = await readFile(outPdf);
      const after = bytes.length;

      // Safety: the tool can exit 0 yet drop pages / emit a broken PDF. Only
      // accept the compressed output if it still loads AND preserves the page
      // count; otherwise keep the original untouched.
      const [inPages, outPages] = await Promise.all([pageCount(ctx.current), pageCount(bytes)]);
      if (outPages === null || (inPages !== null && outPages !== inPages)) {
        return {
          current: ctx.current,
          note: `compress (${this.tool.kind}): skipped — output failed validation (${inPages ?? "?"}→${outPages ?? "invalid"} pages); kept original`,
        };
      }
      // Never grow the document — keep the smaller of the two.
      if (after >= before) {
        return { current: ctx.current, note: `compress (${this.tool.kind}): already optimal (${kb(before)}, ${outPages} pages)` };
      }
      const pct = Math.round((1 - after / before) * 100);
      return {
        current: bytes,
        note: `compressed with ${this.tool.kind} (${kb(before)} → ${kb(after)}, ${pct}% smaller, ${outPages} pages)`,
      };
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Compress until the document fits `target` bytes.
   *
   * Walks the quality ladder downward from whatever `quality` asks for, measuring each
   * rung, and stops at the FIRST one that fits — so the result is the best quality that
   * satisfies the constraint, not the most aggressive setting available. Every candidate
   * goes through the same page-count validation as a plain compress, so a rung that
   * produces a broken PDF is discarded rather than accepted for being small.
   *
   * If no rung reaches the target it returns the smallest VALID result and says so, with
   * both numbers. Failing the run instead would be worse: the user still wants the
   * smaller file, and only they can decide whether to split it, drop pages, or rasterize.
   */
  private async compressToSize(ctx: ExecContext, step: PlanStep, target: number): Promise<AdapterResult> {
    const before = ctx.current!.length;
    if (before <= target) {
      return { current: ctx.current!, note: `compress: already ${formatByteSize(before)}, under the ${formatByteSize(target)} target — left unchanged` };
    }
    if (this.tool!.kind === "qpdf") {
      // qpdf has no quality ladder — one lossless pass is all it can offer. Run it, then
      // report honestly rather than pretending a target was considered.
      const res = await this.compressOnce(ctx, step, null);
      const size = res.current ? res.current.length : before;
      const met = size <= target;
      return {
        current: res.current ?? ctx.current!,
        note:
          `${res.note}${met ? "" : ` — still ${formatByteSize(size)}, over the ${formatByteSize(target)} target. ` +
            `qpdf only recompresses losslessly; install Ghostscript for image downsampling, or split the file.`}`,
      };
    }

    const quality = typeof step.params["quality"] === "number" ? (step.params["quality"] as number) : 75;
    let best: { bytes: Uint8Array; label: string } | null = null;
    const tried: string[] = [];

    let prevSize = Infinity;
    for (let i = ladderStart(quality); i < GS_LADDER.length; i++) {
      const rung = GS_LADDER[i]!;
      const res = await this.compressOnce(ctx, step, rung);
      if (!res.current) continue; // invalid output at this rung — skip it, keep looking
      const size = res.current.length;
      // Descending is not monotonic: re-encoding at a very low DPI can make an
      // already-compact image LARGER (observed: a /screen @50dpi pass ballooning a
      // 565 KB document to 4.7 MB). Once a rung stops paying, further degradation only
      // costs quality and another Ghostscript run — stop and keep the best so far.
      if (size > prevSize) {
        tried.push(`${rung.label} ${formatByteSize(size)} (worse — stopped)`);
        break;
      }
      prevSize = size;
      tried.push(`${rung.label} ${formatByteSize(size)}`);
      if (!best || size < best.bytes.length) best = { bytes: res.current, label: rung.label };
      if (size <= target) {
        const pct = Math.round((1 - size / before) * 100);
        return {
          current: res.current,
          note: `compressed to ${formatByteSize(size)} at "${rung.label}" quality (${formatByteSize(before)} → ${pct}% smaller, under the ${formatByteSize(target)} target)`,
        };
      }
    }

    if (!best || best.bytes.length >= before) {
      return {
        current: ctx.current!,
        note: `compress: could not reach ${formatByteSize(target)} — the document is ${formatByteSize(before)} and no quality setting made it smaller. Try split: { max_size: "${formatByteSize(target)}" } to break it into parts.`,
      };
    }
    return {
      current: best.bytes,
      note:
        `compress: ${formatByteSize(before)} → ${formatByteSize(best.bytes.length)} at "${best.label}", but that is still over the ` +
        `${formatByteSize(target)} target (tried ${tried.join(", ")}). Add rasterize, or split: { max_size: "${formatByteSize(target)}" } to break it into parts.`,
    };
  }

  /** One compression pass at an optional ladder rung. Returns `current: null` when the
   *  result failed validation or wasn't smaller — the caller decides what to do. */
  private async compressOnce(
    ctx: ExecContext,
    step: PlanStep,
    rung: { label: string; setting: string; imageDpi?: number } | null,
  ): Promise<{ current: Uint8Array | null; note: string }> {
    const tmpDir = await mkdtemp(nodePath.join(os.tmpdir(), "opw-compress-"));
    const inPdf = nodePath.join(tmpDir, "in.pdf");
    const outPdf = nodePath.join(tmpDir, "out.pdf");
    try {
      await writeFile(inPdf, ctx.current!);
      const res =
        this.tool!.kind === "ghostscript"
          ? await this.runGhostscript(inPdf, outPdf, step.params, rung)
          : await this.runQpdf(inPdf, outPdf);
      const ok = this.tool!.kind === "qpdf" ? res.code === 0 || res.code === 3 : res.code === 0;
      if (!ok) return { current: null, note: `${this.tool!.kind} exited ${res.code}` };
      const bytes = await readFile(outPdf);
      const [inPages, outPages] = await Promise.all([pageCount(ctx.current!), pageCount(bytes)]);
      if (outPages === null || (inPages !== null && outPages !== inPages)) {
        return { current: null, note: `output failed validation (${inPages ?? "?"}→${outPages ?? "invalid"} pages)` };
      }
      const pct = Math.round((1 - bytes.length / ctx.current!.length) * 100);
      return {
        current: bytes,
        note: `compressed with ${this.tool!.kind} (${kb(ctx.current!.length)} → ${kb(bytes.length)}, ${pct}% smaller, ${outPages} pages)`,
      };
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private runGhostscript(
    inPdf: string,
    outPdf: string,
    params: Record<string, unknown>,
    rung?: { setting: string; imageDpi?: number } | null,
  ): Promise<RunResult> {
    const quality = typeof params["quality"] === "number" ? (params["quality"] as number) : 75;
    // Map 1..100 → Ghostscript image-downsampling presets, unless a ladder rung overrides.
    const setting = rung?.setting ?? (quality <= 40 ? "/screen" : quality <= 75 ? "/ebook" : quality <= 90 ? "/printer" : "/prepress");
    // Below /screen the stock presets have nothing left; force the image resolution down
    // explicitly. Mono (1-bit scan) art stays higher — dropping it to 50 dpi turns text
    // into unreadable mush long before it saves a comparable number of bytes.
    const dpiArgs = rung?.imageDpi
      ? [
          "-dDownsampleColorImages=true",
          "-dDownsampleGrayImages=true",
          "-dColorImageDownsampleType=/Bicubic",
          "-dGrayImageDownsampleType=/Bicubic",
          `-dColorImageResolution=${rung.imageDpi}`,
          `-dGrayImageResolution=${rung.imageDpi}`,
          `-dMonoImageResolution=${Math.max(150, rung.imageDpi * 2)}`,
        ]
      : [];
    return run(
      this.tool!.exe,
      [
        "-dSAFER", // explicit: sandbox PostScript/PDF (don't rely on GS-version default)
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.5",
        `-dPDFSETTINGS=${setting}`,
        "-dNOPAUSE",
        "-dQUIET",
        "-dBATCH",
        "-dDetectDuplicateImages=true",
        ...dpiArgs,
        `-sOutputFile=${outPdf}`,
        inPdf,
      ],
      120_000,
    );
  }

  private runQpdf(inPdf: string, outPdf: string): Promise<RunResult> {
    return run(
      this.tool!.exe,
      ["--optimize-images", "--compress-streams=y", "--object-streams=generate", inPdf, outPdf],
      120_000,
    );
  }

  /** convert_colors — Ghostscript color-space conversion (gray/cmyk/rgb), vectors preserved. */
  private async convertColors(ctx: ExecContext, step: PlanStep): Promise<AdapterResult> {
    if (this.tool!.kind !== "ghostscript") {
      throw new Error("convert_colors needs Ghostscript (qpdf can't convert color spaces) — install Ghostscript");
    }
    const raw = String(step.params["mode"] ?? "gray").toLowerCase();
    const mode = raw === "grayscale" || raw === "grey" || raw === "greyscale" ? "gray" : raw;
    const recipe = COLOR_MODES[mode];
    if (!recipe) throw new Error(`convert_colors: unknown mode "${raw}" (use gray, cmyk, or rgb)`);

    const tmpDir = await mkdtemp(nodePath.join(os.tmpdir(), "opw-color-"));
    const inPdf = nodePath.join(tmpDir, "in.pdf");
    const outPdf = nodePath.join(tmpDir, "out.pdf");
    try {
      await writeFile(inPdf, ctx.current!);
      const res = await run(
        this.tool!.exe,
        [
          "-dSAFER",
          "-sDEVICE=pdfwrite",
          "-dCompatibilityLevel=1.5",
          "-dNOPAUSE",
          "-dQUIET",
          "-dBATCH",
          `-sColorConversionStrategy=${recipe.strategy}`,
          `-dProcessColorModel=${recipe.model}`,
          `-sOutputFile=${outPdf}`,
          inPdf,
        ],
        120_000,
      );
      if (res.code !== 0) {
        throw new Error(`ghostscript exited ${res.code}${res.stderr ? `: ${res.stderr.trim().slice(-300)}` : ""}`);
      }
      const bytes = await readFile(outPdf);
      // Safety: gs can exit 0 yet drop pages — keep the original if the output doesn't
      // load or lost pages, rather than silently returning a broken document.
      const [inPages, outPages] = await Promise.all([pageCount(ctx.current!), pageCount(bytes)]);
      if (outPages === null || (inPages !== null && outPages !== inPages)) {
        return {
          current: ctx.current!,
          note: `convert_colors: skipped — output failed validation (${inPages ?? "?"}→${outPages ?? "invalid"} pages); kept original`,
        };
      }
      return { current: bytes, note: `converted colors → ${mode} (${outPages} page(s))` };
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
