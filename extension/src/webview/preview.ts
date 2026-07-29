// Webview-side PDF renderer (runs in the Chromium webview, bundled for browser).
//
// Loads the output PDF with pdf.js and paints each page to a <canvas>. The host
// (preview-panel.ts) injects the resource URLs on window.__PDF_STUDIO__.
//
// Worker: the pdf.worker bundle is served from a cross-origin webview URI, and a
// cross-origin `new Worker(url)` is blocked (→ pdf.js falls back to a broken
// "fake worker"). So we fetch the worker script (allowed by connect-src), wrap
// it in a same-origin blob, and hand pdf.js that Worker via `workerPort`.

import * as pdfjs from "pdfjs-dist";

interface Bootstrap {
  pdfUrl: string;
  workerUrl: string;
}

declare global {
  interface Window {
    __PDF_STUDIO__?: Bootstrap;
  }
  function acquireVsCodeApi(): { postMessage(message: unknown): void };
}

const api = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;

function log(level: "info" | "warn" | "error", msg: string): void {
  try {
    api?.postMessage({ type: "log", level, msg });
  } catch {
    /* no-op */
  }
}

window.addEventListener("error", (e) => log("error", `uncaught: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`));
window.addEventListener("unhandledrejection", (e) =>
  log("error", `unhandledrejection: ${String((e as PromiseRejectionEvent).reason)}`),
);

/** Build a same-origin blob Worker from the cross-origin worker bundle URL. */
async function makeWorkerPort(workerUrl: string): Promise<Worker> {
  const resp = await fetch(workerUrl);
  if (!resp.ok) throw new Error(`worker fetch failed: HTTP ${resp.status}`);
  const code = await resp.text();
  const blobUrl = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  return new Worker(blobUrl);
}

async function main(): Promise<void> {
  const boot = window.__PDF_STUDIO__;
  const status = document.getElementById("status");
  const pages = document.getElementById("pages");
  if (!boot || !status || !pages) {
    log("error", "bootstrap data or DOM elements missing");
    return;
  }

  try {
    log("info", "initializing pdf.js worker (blob port)…");
    pdfjs.GlobalWorkerOptions.workerPort = await makeWorkerPort(boot.workerUrl);

    log("info", `loading PDF: ${boot.pdfUrl}`);
    const doc = await pdfjs.getDocument({ url: boot.pdfUrl }).promise;
    const numPages = doc.numPages;
    log("info", `loaded ${numPages} page(s); rendering lazily…`);
    status.textContent = `${numPages} page${numPages === 1 ? "" : "s"}`;

    const dpr = window.devicePixelRatio || 1;
    const scale = 1.3 * dpr;
    const jobs = new Map<Element, { pageNo: number }>();
    let firstReported = false;
    let rendered = 0;

    const renderCanvas = async (canvas: HTMLCanvasElement, pageNo: number): Promise<void> => {
      const page = await doc.getPage(pageNo);
      const viewport = page.getViewport({ scale });
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      await page.render({ canvasContext: ctx, viewport }).promise;
      rendered++;
      if (!firstReported) {
        firstReported = true;
        // Report success as soon as the first page paints — a large doc is
        // usable immediately instead of blocking on all pages.
        api?.postMessage({ type: "render", ok: true, pages: numPages });
        log("info", "first page rendered");
      }
    };

    // Only paint pages as they scroll near the viewport.
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const job = jobs.get(e.target);
          if (!job) continue;
          jobs.delete(e.target);
          io.unobserve(e.target);
          void renderCanvas(e.target as HTMLCanvasElement, job.pageNo).catch((err) =>
            log("warn", `page ${job.pageNo} render failed: ${(err as Error).message}`),
          );
        }
      },
      { root: null, rootMargin: "300px 0px" },
    );

    // Lay out correctly-sized placeholder canvases first (so scroll extent is right).
    for (let n = 1; n <= numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = `${viewport.width / dpr}px`;
      pages.appendChild(canvas);
      jobs.set(canvas, { pageNo: n });
      io.observe(canvas);
    }
    // Safety net: if nothing intersected (edge cases), report success anyway.
    setTimeout(() => {
      if (!firstReported) {
        firstReported = true;
        api?.postMessage({ type: "render", ok: true, pages: numPages });
      }
    }, 1500);
    log("info", `laid out ${numPages} page(s); ${rendered} painted so far`);
  } catch (err) {
    const message = (err as Error).message;
    status.textContent = `Failed to render PDF: ${message}`;
    log("error", `render failed: ${message}\n${(err as Error).stack ?? ""}`);
    api?.postMessage({ type: "render", ok: false, error: message });
  }
}

void main();
