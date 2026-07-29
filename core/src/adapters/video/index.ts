// CliVideoAdapter — video → PDF via ffmpeg (optional, probed like LibreOffice).
//
// Extracts frames at a fixed interval and lays them out ONE PER PAGE. It deliberately does
// not build a grid: `n_up` already does that, so a contact sheet is
//
//     - video_to_pdf: { every: 30 }
//     - n_up: { cols: 3, rows: 4 }
//
// which also means every other page op (header_footer, add_page_numbers, title_page)
// composes for free. Building a bespoke grid here would duplicate n_up and compose with
// nothing.
//
// ffmpeg is used ONLY for decoding video. It has no PDF muxer, and for still images
// Pillow/PyMuPDF cover more formats (PSD, HEIC via pillow-heif) at a fraction of the
// install size — so `images_to_pdf` does not route through here.

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm, readdir } from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { Capability } from "../../opw/operations.js";
import type { DocumentKind } from "../../opw/model.js";
import type { PlanStep } from "../../opw/compile.js";
import type { AdapterResult, ExecContext, RendererAdapter } from "../adapter.js";
import { VIDEO_CAPABILITIES } from "../capabilities.js";
import { envWithToolPath } from "../../deps/check.js";

function run(exe: string, args: string[], timeoutMs: number): Promise<{ code: number; stderr: string }> {
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

/** Seconds as h:mm:ss, for the per-frame timestamp label. */
function hhmmss(total: number): string {
  const s = Math.max(0, Math.round(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export class CliVideoAdapter implements RendererAdapter {
  readonly id = "cli-video";
  readonly kinds: readonly DocumentKind[] = ["pdf"];
  readonly capabilities: readonly Capability[] = VIDEO_CAPABILITIES;
  private exe: string | null = null;
  private resolved = false;

  async isAvailable(): Promise<boolean> {
    if (!this.resolved) {
      const res = await run("ffmpeg", ["-version"], 20_000);
      this.exe = res.code === 0 ? "ffmpeg" : null;
      this.resolved = true;
    }
    return this.exe !== null;
  }

  async apply(ctx: ExecContext, step: PlanStep): Promise<AdapterResult> {
    if (!(await this.isAvailable()) || !this.exe) {
      throw new Error("video_to_pdf needs ffmpeg — install it (the Dependencies view has the command for your platform)");
    }
    const src = ctx.current;
    if (!src || src.length === 0) throw new Error("video_to_pdf: no input video");

    const p = step.params;
    const every = Math.max(0.1, Number(p["every"] ?? 30));
    const maxFrames = Math.max(1, Math.floor(Number(p["max_frames"] ?? 200)));
    const width = Math.max(64, Math.floor(Number(p["width"] ?? 1280)));
    const showTimes = p["timestamps"] !== false;

    const inExt = nodePath.extname(ctx.inputPaths[0] ?? ".mp4") || ".mp4";
    const tmpDir = await mkdtemp(nodePath.join(os.tmpdir(), "opw-video-"));
    try {
      const inFile = nodePath.join(tmpDir, `in${inExt}`);
      await writeFile(inFile, src);

      // fps=1/every samples one frame per `every` seconds; -vsync vfr keeps the sampling
      // honest on variable-frame-rate sources. -frames:v caps the work so a 3-hour video
      // at every: 1 can't quietly produce 10,000 pages.
      const res = await run(
        this.exe,
        [
          "-hide_banner", "-loglevel", "error", "-nostdin",
          "-i", inFile,
          "-vf", `fps=1/${every},scale=${width}:-2`,
          "-vsync", "vfr",
          "-frames:v", String(maxFrames),
          "-q:v", "3",
          nodePath.join(tmpDir, "f_%05d.jpg"),
        ],
        600_000,
      );
      const names = (await readdir(tmpDir)).filter((f) => f.startsWith("f_") && f.endsWith(".jpg")).sort();
      if (names.length === 0) {
        const why = res.stderr.trim().slice(-300);
        throw new Error(
          `video_to_pdf: ffmpeg produced no frames${why ? ` — ${why}` : ""}. ` +
            `Check the file is a video ffmpeg can read, or raise \`every\` if it is shorter than the interval.`,
        );
      }

      const out = await PDFDocument.create();
      const font = showTimes ? await out.embedFont(StandardFonts.Helvetica) : null;
      for (let i = 0; i < names.length; i++) {
        const bytes = await readFile(nodePath.join(tmpDir, names[i]!));
        const jpg = await out.embedJpg(bytes);
        const page = out.addPage([jpg.width, jpg.height]);
        page.drawImage(jpg, { x: 0, y: 0, width: jpg.width, height: jpg.height });
        if (font) {
          // Burn the source timestamp in with pdf-lib rather than ffmpeg's drawtext filter,
          // which needs libfreetype and a font path and fails differently on every build.
          const label = hhmmss(i * every);
          const size = Math.max(10, Math.round(jpg.height * 0.03));
          const pad = size * 0.4;
          const tw = font.widthOfTextAtSize(label, size);
          page.drawRectangle({ x: pad, y: pad, width: tw + pad * 2, height: size + pad, color: rgb(0, 0, 0), opacity: 0.55 });
          page.drawText(label, { x: pad * 2, y: pad * 1.4, size, font, color: rgb(1, 1, 1) });
        }
      }
      const capped = names.length >= maxFrames ? ` (capped at max_frames: ${maxFrames})` : "";
      return {
        current: await out.save(),
        note: `extracted ${names.length} frame(s) every ${every}s → ${names.length} page(s)${capped}`,
      };
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
