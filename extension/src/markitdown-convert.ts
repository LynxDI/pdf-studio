// Spawns the MarkItDown sidecar (resources/python/markitdown_convert.py) to
// convert an arbitrary file to Markdown. Standalone from the OPW pipeline — the
// input is any file, not a PDF working document.

import { spawn } from "node:child_process";
import { parseLastJsonObject, envWithToolPath, type PythonCmd } from "@pdf-studio/core";

export interface MarkitdownResult {
  ok: boolean;
  chars?: number;
  out?: string;
  error?: string;
}

export interface MarkitdownOptions {
  inputPath: string;
  outputPath: string;
  scriptPath: string;
  python: PythonCmd;
  timeoutMs?: number;
}

/** Run MarkItDown on `inputPath`, writing Markdown to `outputPath`. Resolves to
 *  the sidecar's JSON result (ok/false with an error message on any failure). */
export function convertToMarkdown(opts: MarkitdownOptions): Promise<MarkitdownResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (v: MarkitdownResult) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(opts.python.exe, [...opts.python.args, opts.scriptPath, opts.inputPath, opts.outputPath], { windowsHide: true, env: envWithToolPath() });
    } catch (e) {
      finish({ ok: false, error: (e as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish({ ok: false, error: "conversion timed out" });
    }, timeoutMs);
    child.stdout?.on("data", (d) => (stdout += String(d)));
    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.on("error", (e) => {
      clearTimeout(timer);
      finish({ ok: false, error: e.message });
    });
    child.on("close", () => {
      clearTimeout(timer);
      const parsed = parseLastJsonObject(stdout) as MarkitdownResult | null;
      if (parsed) finish(parsed);
      else finish({ ok: false, error: stderr.trim().slice(-300) || "no output from MarkItDown" });
    });
  });
}
