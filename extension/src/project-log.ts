// A persistent, human-readable render log written INTO the user's project, so a
// render failure or a slow op can be diagnosed (and shared) after the fact —
// without needing the VS Code Output panel open at the time. Best-effort:
// logging must never break or slow a render.
//
// Location: <project>/.lynx-pdf-studio/pdf-studio.log  (rolls over at ~1 MB).

import * as fs from "node:fs";
import * as path from "node:path";

const MAX_LOG_BYTES = 1_000_000;

/** Workflow-relative path of the project log (for messages/commands). */
export const PROJECT_LOG_REL = path.join(".lynx-pdf-studio", "pdf-studio.log");

/** Absolute path of the project log for a given workflow directory. */
export function projectLogPath(baseDir: string): string {
  return path.join(baseDir, PROJECT_LOG_REL);
}

/** Append a block of text to the project log. Rolls the file over when it grows
 *  past ~1 MB (keeps the previous file as `.1`). Never throws. */
export function appendProjectLog(baseDir: string, block: string): void {
  try {
    const file = projectLogPath(baseDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {
      /* no existing file — fine */
    }
    fs.appendFileSync(file, block.endsWith("\n") ? block : `${block}\n`, "utf8");
  } catch {
    /* logging is best-effort; a render must never fail because of it */
  }
}

/** Accumulates one render's lines, then flushes them as a single block. */
export class RenderLog {
  private readonly lines: string[] = [];
  private readonly startedAt = Date.now();
  private lastStep = Date.now();

  constructor(
    private readonly baseDir: string,
    relPath: string,
  ) {
    this.lines.push("─".repeat(64));
    this.lines.push(`${stamp()}  RENDER  ${relPath}`);
  }

  /** Record a completed operation with its elapsed time + note. */
  step(index: number, op: string, note?: string): void {
    const now = Date.now();
    const secs = ((now - this.lastStep) / 1000).toFixed(1);
    this.lastStep = now;
    this.lines.push(`  [${index + 1}] ${op} (${secs}s)${note ? ` — ${note}` : ""}`);
  }

  line(text: string): void {
    this.lines.push(text);
  }

  private elapsed(): string {
    return ((Date.now() - this.startedAt) / 1000).toFixed(1);
  }

  /** Flush a successful render + return nothing. */
  ok(output: string | null, artifactCount: number): void {
    const extra = artifactCount > 0 ? ` (+${artifactCount} artifact${artifactCount === 1 ? "" : "s"})` : "";
    this.lines.push(`✓ OK in ${this.elapsed()}s → ${output ?? "(no PDF output)"}${extra}`);
    this.flush();
  }

  /** Flush a failed render, adding a hint for known failure modes. */
  fail(message: string): void {
    this.lines.push(`✗ FAILED in ${this.elapsed()}s: ${message}`);
    if (/timed out/i.test(message)) {
      this.lines.push("  hint: large document. Heavy ops (markdown/OCR/rasterize) allow up to 10 min; re-render, or split the PDF / reduce pages.");
    }
    this.flush();
  }

  private flush(): void {
    appendProjectLog(this.baseDir, this.lines.join("\n"));
  }
}

function stamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}
