// Deep PDF object map via the bundled PyMuPDF sidecar (resources/python/
// pdf_inspect.py). Runs only when a Python with PyMuPDF is available; any
// failure resolves to null so the sidebar silently falls back to the pdf-lib
// object map (pages + metadata).

import { spawn } from "node:child_process";
import { parseLastJsonObject, envWithToolPath, type PythonCmd } from "@pdf-studio/core";

export interface DeepImage {
  object_name: string;
  xref: number;
  width: number;
  height: number;
  bbox: number[] | null;
}
export interface DeepPage {
  index: number;
  width: number;
  height: number;
  rotation: number;
  images: DeepImage[];
  text_chars: number;
}
export interface DeepFont {
  name: string;
  type: string;
  pages: number[];
}
export interface DeepField {
  name: string | null;
  type: string | null;
  page: number;
  value: string | null;
}
export interface DeepBookmark {
  title: string;
  page: number;
  level: number;
}
export interface DeepPdfInfo {
  page_count: number;
  metadata: Record<string, string>;
  is_form: boolean;
  fields: DeepField[];
  fonts: DeepFont[];
  bookmarks: DeepBookmark[];
  pages: DeepPage[];
  error?: string;
}

export interface InspectDeepOptions {
  pdfPath: string;
  scriptPath: string;
  python: PythonCmd;
  timeoutMs?: number;
}

/** Run the PyMuPDF sidecar; resolves to the object map or null on any failure. */
export function inspectPdfDeep(opts: InspectDeepOptions): Promise<DeepPdfInfo | null> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return new Promise((resolve) => {
    let stdout = "";
    let done = false;
    const finish = (v: DeepPdfInfo | null) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(opts.python.exe, [...opts.python.args, opts.scriptPath, opts.pdfPath], { windowsHide: true, env: envWithToolPath() });
    } catch {
      finish(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish(null);
    }, timeoutMs);
    child.stdout?.on("data", (d) => (stdout += String(d)));
    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const parsed = parseLastJsonObject(stdout) as DeepPdfInfo | null;
      finish(parsed && !parsed.error ? parsed : null);
    });
  });
}
