// Dependency probing — powers the color-coded "Dependencies" sidebar section.
//
// PDF Studio runs out of the box on the bundled pdf-lib backend. The Python
// execution layer (PyMuPDF / pikepdf / pypdf / qpdf / Ghostscript / OCR) is
// OPTIONAL and unlocks advanced capabilities (extract_text, redaction, deep
// compression, OCR). This module reports, per backend, whether it is available
// and at what version, so the UI can render:
//
//     ● pdf-lib     available (bundled 1.17.1)     ← green
//     ● PyMuPDF     available (1.24.0)             ← green
//     ⚠ qpdf        not installed — click to set up ← yellow
//
// Pure Node (node:child_process) so it works identically in the extension and
// in CI. Never throws — a probe failure becomes a "missing"/"error" status.

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import * as path from "node:path";

export type DependencyState = "available" | "missing" | "error";

/**
 * How much a dependency matters — the axis a user actually needs when deciding what to
 * install. `kind` says how a thing is delivered; this says whether to bother.
 *
 * Without it every row looks equally consequential: `pillow-heif` (one image format) sits
 * beside PyMuPDF (two-thirds of the operation set), and Marker — a multi-gigabyte GPU model
 * stack — beside qpdf.
 *
 * Note "recommended", not "required": the bundled engine really does run standalone, and
 * that is worth preserving both as an onboarding story and as a plain statement of fact.
 */
export type DependencyTier = "bundled" | "recommended" | "feature" | "heavy";

/** Display order + copy for each tier. */
export const DEPENDENCY_TIERS: ReadonlyArray<{ tier: DependencyTier; title: string; blurb: string }> = [
  { tier: "bundled", title: "Bundled", blurb: "Ships with the extension — nothing to install." },
  { tier: "recommended", title: "Recommended", blurb: "Unlocks most of the operation set: text, redaction, forms, OCR." },
  { tier: "feature", title: "Per-feature", blurb: "Each one unlocks a specific capability. Install only what you use." },
  { tier: "heavy", title: "Heavy · opt-in", blurb: "Large models or GPU workloads. Only for AI-grade OCR and extraction." },
];

export interface DependencyStatus {
  /** Stable id, e.g. "pymupdf", "qpdf". */
  id: string;
  /** Display label, e.g. "PyMuPDF". */
  label: string;
  /** How it's delivered. */
  kind: "bundled" | "python" | "cli";
  /** How much it matters — see {@link DependencyTier}. */
  tier: DependencyTier;
  state: DependencyState;
  /** Detected version, when available. */
  version?: string;
  /** Human status line, e.g. "available (1.24.0)" / "not installed". */
  detail: string;
  /** Capabilities this backend unlocks (for tooltips). */
  unlocks?: string[];
  /** One-line install hint shown when missing. */
  installHint?: string;
  /** Installed OCR languages (Tesseract), when applicable — the `ocr` op preflights these. */
  languages?: string[];
}

export interface CheckDependenciesOptions {
  /** Python executable (default: python3/python on PATH). */
  pythonPath?: string;
  /** Interpreter of the SEPARATE PaddleOCR-VL venv (engine: paddleocr-vl), probed
   *  independently from the main one. Undefined → the row shows "not installed". */
  paddlePythonPath?: string;
  /** The configured extract_receipt VLM endpoint (setting or env). Set → the receipt-OCR
   *  row reports "configured"; undefined → "not set up (click)". */
  vlmEndpoint?: string;
  /** Per-probe timeout in ms (default 4000). */
  timeoutMs?: number;
}

const BUNDLED_PDFLIB_VERSION = "1.17.1"; // keep in sync with core/package.json

/**
 * Which tier each dependency belongs to, in ONE table rather than at each probe site —
 * so a new dependency can't be added without the taxonomy noticing, and the whole
 * hierarchy is readable in one place. Anything unlisted defaults to "feature", which is
 * the safe assumption: it unlocks something specific and isn't required.
 */
const TIER_BY_ID: Record<string, DependencyTier> = {
  "pdf-lib": "bundled",

  // The Python engine and the two libraries that carry most of the operation set.
  python: "recommended",
  pymupdf: "recommended",
  pikepdf: "recommended",

  // Heavy: gigabyte-scale models, a dedicated venv, or a GPU to be worth running.
  marker: "heavy",
  "paddleocr-vl": "heavy",
  "receipt-ocr": "heavy",

  // Everything else is per-feature: pypdf, reportlab, ocrmypdf, pyhanko, pymupdf4llm,
  // markitdown, pillow-heif, qpdf, ghostscript, tesseract, libreoffice, ffmpeg, browser.
};

function tierFor(id: string): DependencyTier {
  return TIER_BY_ID[id] ?? "feature";
}

/** A probe result before the tier is stamped on centrally. */
type ProbedStatus = Omit<DependencyStatus, "tier">;

interface PythonProbe {
  python: string | null;
  libs: Record<string, string | null>;
}

/**
 * Probe every backend and return one status per dependency. The list always
 * leads with the bundled pdf-lib backend (always available), then the optional
 * Python libraries, then the CLI tools.
 */
export async function checkDependencies(
  opts: CheckDependenciesOptions = {},
): Promise<DependencyStatus[]> {
  const timeoutMs = opts.timeoutMs ?? 4000;
  const python = opts.pythonPath || defaultPython();

  const out: ProbedStatus[] = [
    {
      id: "pdf-lib",
      label: "pdf-lib (bundled)",
      kind: "bundled",
      state: "available",
      version: BUNDLED_PDFLIB_VERSION,
      detail: `available (bundled ${BUNDLED_PDFLIB_VERSION})`,
      unlocks: ["merge", "split", "rotate", "reorder", "delete", "watermark", "metadata"],
    },
  ];

  const probe = await probePython(python, timeoutMs);

  const pyLibs: Array<{ id: string; label: string; dist: string; pipName?: string; unlocks: string[] }> = [
    { id: "pymupdf", label: "PyMuPDF", dist: "PyMuPDF", unlocks: ["extract_text", "extract_markdown", "extract_images", "redact"] },
    { id: "pymupdf4llm", label: "pymupdf4llm (better Markdown)", dist: "pymupdf4llm", unlocks: ["extract_markdown quality"] },
    { id: "markitdown", label: "MarkItDown (any file → Markdown)", dist: "markitdown", pipName: "markitdown[pdf]", unlocks: ["extract_markdown (alt engine)"] },
    { id: "marker", label: "Marker (Surya OCR → Markdown)", dist: "marker-pdf", pipName: "marker-pdf", unlocks: ["extract_markdown (engine: marker)"] },
    // HEIC is what an iPhone photo actually is. Pillow cannot decode it alone — pillow-heif
    // registers the codec — so images_to_pdf advertised HEIC support it did not have.
    { id: "pillow-heif", label: "pillow-heif (iPhone HEIC photos)", dist: "pillow_heif", pipName: "pillow-heif", unlocks: ["images_to_pdf (.heic/.heif)"] },
    { id: "pikepdf", label: "pikepdf", dist: "pikepdf", unlocks: ["replace_image", "compress"] },
    { id: "pypdf", label: "pypdf", dist: "pypdf", unlocks: ["merge", "split"] },
    { id: "reportlab", label: "ReportLab", dist: "reportlab", unlocks: ["watermark", "generate"] },
    { id: "ocrmypdf", label: "OCRmyPDF", dist: "ocrmypdf", pipName: '"ocrmypdf<17"', unlocks: ["ocr"] },
    { id: "pyhanko", label: "pyHanko (digital signatures)", dist: "pyHanko", unlocks: ["sign", "validate_signature", "timestamp"] },
  ];

  if (!probe.python) {
    // No Python at all — one entry explains the whole optional layer is off.
    out.push({
      id: "python",
      label: "Python engine",
      kind: "python",
      state: "missing",
      detail: "not found — advanced ops disabled",
      unlocks: ["extract_text", "redact", "ocr", "deep compress"],
      installHint: installCommand("python"),
    });
  } else {
    out.push({
      id: "python",
      label: "Python engine",
      kind: "python",
      state: "available",
      version: probe.python,
      detail: `available (${probe.python})`,
    });
    for (const lib of pyLibs) {
      const v = probe.libs[lib.dist] ?? null;
      out.push({
        id: lib.id,
        label: lib.label,
        kind: "python",
        state: v ? "available" : "missing",
        version: v ?? undefined,
        detail: v ? `available (${v})` : "not installed — click to set up",
        unlocks: lib.unlocks,
        installHint: `${python} -m pip install ${lib.pipName ?? lib.dist}`,
      });
    }
  }

  // CLI tools. Ghostscript's binary is named differently per platform/installer
  // (gswin64c/gswin32c on Windows, gs elsewhere) — probe every candidate.
  out.push(await probeCli("qpdf", ["qpdf"], ["--version"], timeoutMs, ["compress", "linearize"], installCommand("qpdf") ?? ""));
  // Label it "Ghostscript", not the probed binary name — probeCli labels from cmds[0],
  // which on Windows is the distinctly unhelpful "gswin64c".
  out.push({
    ...(await probeCli("ghostscript", ["gswin64c", "gswin32c", "gs"], ["--version"], timeoutMs,
      ["deep compress", "convert_colors", "pdf_to_pdfa"], installCommand("ghostscript") ?? "")),
    label: "Ghostscript",
  });
  // Tesseract is the OCR engine ocrmypdf shells out to; without it the `ocr` op
  // fails even when the ocrmypdf Python lib is installed. Also reports installed
  // languages (tessdata) so a missing `hin`/Devanagari is visible before a run.
  out.push(await probeTesseract(timeoutMs));
  // LibreOffice (soffice) powers Office ⇆ PDF conversion.
  out.push(await probeLibreOffice(timeoutMs));
  // ffmpeg decodes video for video_to_pdf (frames → contact sheet). It is deliberately NOT
  // used for still images: it has no PDF muxer and cannot read PSD or AI, so Pillow/PyMuPDF
  // cover that ground more cheaply.
  out.push(await probeCli("ffmpeg", ["ffmpeg"], ["-version"], timeoutMs, ["video_to_pdf"], installCommand("ffmpeg") ?? ""));
  // A system Chrome/Edge renders Markdown/HTML/URL → PDF at full fidelity.
  out.push(await probeBrowser(timeoutMs));

  // PaddleOCR-VL lives in its OWN venv (a heavy PaddlePaddle stack kept out of the main
  // interpreter to avoid pin conflicts), so it's probed separately. Always listed: when
  // missing, clicking the row runs the one-shot setup (venv + install + model warm-up).
  const paddleVer = await probePaddle(opts.paddlePythonPath, timeoutMs);
  out.push({
    id: "paddleocr-vl",
    label: "PaddleOCR-VL (local doc parser)",
    kind: "python",
    state: paddleVer ? "available" : "missing",
    version: paddleVer ?? undefined,
    detail: paddleVer ? `available (paddleocr ${paddleVer})` : "not installed — click to auto-create its venv",
    unlocks: ["extract_markdown (engine: paddleocr-vl)"],
    installHint: "click to create a dedicated PaddleOCR-VL venv and install it automatically",
  });

  // Receipt OCR (extract_receipt) talks to a vision-language model over an OpenAI-compatible
  // endpoint — not a local package, so "available" here means an endpoint is configured.
  out.push({
    id: "receipt-ocr",
    label: "Receipt OCR (Qwen3-VL)",
    kind: "cli",
    state: opts.vlmEndpoint ? "available" : "missing",
    detail: opts.vlmEndpoint ? `configured (${opts.vlmEndpoint})` : "not set up — click to install a local vision model",
    unlocks: ["extract_receipt"],
    installHint: "click to set up a local vision model (Ollama + qwen2.5vl) for receipt extraction",
  });

  // Stamp the tier on centrally — see TIER_BY_ID.
  return out.map((s) => ({ ...s, tier: tierFor(s.id) }));
}

/** Probe the separate PaddleOCR-VL interpreter for the `paddleocr` package. Returns its
 *  version, or null when the interpreter is unset / missing / lacks the package. */
async function probePaddle(paddlePython: string | undefined, timeoutMs: number): Promise<string | null> {
  if (!paddlePython) return null;
  const res = await run(paddlePython, ["-c", "import paddleocr,sys; sys.stdout.write(getattr(paddleocr,'__version__','?'))"], timeoutMs);
  if (res.code !== 0) return null;
  const v = res.stdout.trim();
  return v || null;
}

/**
 * The recommended install command (or download URL) for an optional backend on
 * the given platform. Returns a real, copy-pasteable shell command — never
 * prose. A value that starts with `http(s)://` is a download page to open in a
 * browser, not a command to run in a terminal (some tools, e.g. Ghostscript on
 * Windows, aren't in a package manager). `id` matches DependencyStatus.id.
 */
export function installCommand(
  id: string,
  platform: NodeJS.Platform = process.platform,
  opts: { scoop?: boolean } = {},
): string | undefined {
  const win = platform === "win32";
  const mac = platform === "darwin";
  // On Windows, prefer scoop when present: per-user, no admin/UAC, and it
  // installs Ghostscript (which isn't in winget). `opts.scoop` is injectable
  // so tests stay deterministic.
  const scoop = win && (opts.scoop ?? hasScoop());
  switch (id) {
    case "qpdf":
      return win
        ? scoop
          ? "scoop install qpdf"
          : "winget install --id QPDF.QPDF -e --accept-package-agreements --accept-source-agreements"
        : mac
          ? "brew install qpdf"
          : "sudo apt-get install -y qpdf";
    case "ghostscript":
      return win
        ? scoop
          ? "scoop install ghostscript"
          : "https://ghostscript.com/releases/gsdnld.html" // not in winget; official installer
        : mac
          ? "brew install ghostscript"
          : "sudo apt-get install -y ghostscript";
    case "python":
      return win
        ? scoop
          ? "scoop install python"
          : "winget install --id Python.Python.3.12 -e --accept-package-agreements --accept-source-agreements"
        : mac
          ? "brew install python"
          : "sudo apt-get install -y python3 python3-pip";
    case "tesseract":
      return win
        ? scoop
          ? "scoop install tesseract"
          : "winget install --id UB-Mannheim.TesseractOCR -e --accept-package-agreements --accept-source-agreements"
        : mac
          ? "brew install tesseract"
          : "sudo apt-get install -y tesseract-ocr";
    case "libreoffice":
      return win
        ? scoop
          ? "scoop install libreoffice"
          : "winget install --id TheDocumentFoundation.LibreOffice -e --accept-package-agreements --accept-source-agreements"
        : mac
          ? "brew install --cask libreoffice"
          : "sudo apt-get install -y libreoffice";
    case "ffmpeg":
      return win
        ? scoop
          ? "scoop install ffmpeg"
          : "winget install --id Gyan.FFmpeg -e --accept-package-agreements --accept-source-agreements"
        : mac
          ? "brew install ffmpeg"
          : "sudo apt-get install -y ffmpeg";
    case "browser":
      // Optional: enables high-fidelity HTML/Markdown/URL → PDF. Windows already
      // ships Edge, so this only surfaces on Mac/Linux without a browser.
      return win
        ? scoop
          ? "scoop install googlechrome"
          : "winget install --id Google.Chrome -e --accept-package-agreements --accept-source-agreements"
        : mac
          ? "brew install --cask google-chrome"
          : "sudo apt-get install -y chromium-browser";
    default:
      return undefined;
  }
}

/** Run one Python probe that reports the interpreter version + lib versions. */
async function probePython(python: string, timeoutMs: number): Promise<PythonProbe> {
  const script =
    "import json,sys\n" +
    "try:\n import importlib.metadata as md\nexcept Exception:\n md=None\n" +
    "libs=['PyMuPDF','pikepdf','pypdf','reportlab','ocrmypdf','pymupdf4llm','markitdown','marker-pdf','pyHanko','pillow_heif']\n" +
    "out={}\n" +
    "for l in libs:\n" +
    " try: out[l]=md.version(l) if md else None\n" +
    " except Exception: out[l]=None\n" +
    "print(json.dumps({'python':sys.version.split()[0],'libs':out}))\n";
  const res = await run(python, ["-c", script], timeoutMs);
  if (res.code !== 0) return { python: null, libs: {} };
  try {
    const parsed = JSON.parse(res.stdout.trim()) as PythonProbe;
    return parsed;
  } catch {
    return { python: null, libs: {} };
  }
}

async function probeCli(
  id: string,
  cmds: string[],
  args: string[],
  timeoutMs: number,
  unlocks: string[],
  hint: string,
): Promise<ProbedStatus> {
  const label = cmds[0] ?? id;
  for (const cmd of cmds) {
    const res = await run(cmd, args, timeoutMs);
    if (res.code === 0) {
      const version = firstVersion(res.stdout + " " + res.stderr);
      return {
        id,
        label,
        kind: "cli",
        state: "available",
        version,
        detail: version ? `available (${version})` : "available",
        unlocks,
      };
    }
  }
  return {
    id,
    label,
    kind: "cli",
    state: "missing",
    detail: "not installed",
    unlocks,
    installHint: hint,
  };
}

/**
 * Standard absolute paths to LibreOffice's `soffice` binary. Scoop (and some
 * Windows installers) don't put it on PATH, so both the deps probe and the
 * office adapter resolve it by checking these locations.
 */
export function sofficeInstallPaths(): string[] {
  const out: string[] = [];
  if (process.platform === "win32") {
    for (const r of [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"]]) {
      if (r) out.push(path.join(r, "LibreOffice", "program", "soffice.exe"));
    }
    const home = process.env["USERPROFILE"];
    if (home) out.push(path.join(home, "scoop", "apps", "libreoffice", "current", "LibreOffice", "program", "soffice.exe"));
  }
  return out;
}

/** Probe LibreOffice by known install path first (soffice usually isn't on
 *  PATH), then fall back to a PATH-based `soffice --version` probe. */
async function probeLibreOffice(timeoutMs: number): Promise<ProbedStatus> {
  const unlocks = ["office_to_pdf", "pdf_to_docx"];
  if (sofficeInstallPaths().some((p) => existsSync(p))) {
    return { id: "libreoffice", label: "LibreOffice", kind: "cli", state: "available", detail: "available (installed)", unlocks };
  }
  const probed = await probeCli("libreoffice", ["soffice", "libreoffice"], ["--version"], timeoutMs, unlocks, installCommand("libreoffice") ?? "");
  return { ...probed, label: "LibreOffice" };
}

/**
 * Standard absolute paths to a Chromium-family browser (Edge ships with Windows;
 * Chrome is common on all three OSes). Used to render HTML/Markdown/URL → PDF at
 * full fidelity via headless print, with no bundled browser. Kept in sync with
 * the sidecar's `_find_browser` in resources/python/pdf_exec.py.
 */
export function browserInstallPaths(): string[] {
  const out: string[] = [];
  if (process.platform === "win32") {
    for (const r of [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"], process.env["LOCALAPPDATA"]]) {
      if (!r) continue;
      out.push(path.join(r, "Microsoft", "Edge", "Application", "msedge.exe"));
      out.push(path.join(r, "Google", "Chrome", "Application", "chrome.exe"));
    }
  } else if (process.platform === "darwin") {
    out.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    out.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
  } else {
    out.push("/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge");
  }
  return out;
}

/** Probe a system Chrome/Edge/Chromium — the high-fidelity HTML/Markdown/URL →
 *  PDF engine — by known install path first, then a PATH-based probe. It's
 *  optional: without it those ops fall back to the built-in renderer. */
async function probeBrowser(timeoutMs: number): Promise<ProbedStatus> {
  const unlocks = ["html_to_pdf (high fidelity)", "markdown_to_pdf (high fidelity)", "url_to_pdf"];
  if (browserInstallPaths().some((p) => existsSync(p))) {
    return { id: "browser", label: "Chrome / Edge (HTML→PDF)", kind: "cli", state: "available", detail: "available (installed)", unlocks };
  }
  const probed = await probeCli(
    "browser",
    ["google-chrome", "chromium", "chromium-browser", "chrome", "msedge", "microsoft-edge"],
    ["--version"],
    timeoutMs,
    unlocks,
    installCommand("browser") ?? "",
  );
  return { ...probed, label: "Chrome / Edge (HTML→PDF)" };
}

/** Probe Tesseract AND report which languages are installed (tessdata). The `ocr` op
 *  preflights the requested language against these, so surfacing them in the sidebar
 *  turns a deep, opaque "language X has no data" failure into an at-a-glance check. */
async function probeTesseract(timeoutMs: number): Promise<ProbedStatus> {
  const base = await probeCli("tesseract", ["tesseract"], ["--version"], timeoutMs, ["ocr"], installCommand("tesseract") ?? "");
  if (base.state !== "available") return base;
  const langs = await tesseractLangs(timeoutMs);
  if (!langs.length) return base;
  const shown = langs.slice(0, 8).join(", ");
  const more = langs.length > 8 ? ` +${langs.length - 8}` : "";
  return { ...base, languages: langs, detail: `${base.detail} · langs: ${shown}${more}` };
}

/** Installed Tesseract languages via `--list-langs`. Modern Tesseract prints to stdout,
 *  older builds to stderr — read both; keep only lang-code-shaped tokens (drops the
 *  "List of available languages (N):" header and any path lines). */
async function tesseractLangs(timeoutMs: number): Promise<string[]> {
  const res = await run("tesseract", ["--list-langs"], timeoutMs);
  if (res.code !== 0) return [];
  const langs: string[] = [];
  for (const raw of `${res.stdout}\n${res.stderr}`.split(/\r?\n/)) {
    const ln = raw.trim();
    if (/^[A-Za-z0-9_]+$/.test(ln)) langs.push(ln);
  }
  return langs.sort();
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn a command with a hard timeout; resolves to code 127 if unspawnable. */
function run(cmd: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      resolve({ code, stdout, stderr });
    };
    let child: ReturnType<typeof spawn>;
    try {
      // Augment PATH with on-disk tool locations so a freshly-installed tool is
      // found without a full editor restart (VS Code's PATH is fixed at launch).
      child = spawn(cmd, args, { windowsHide: true, env: envWithToolPath() });
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
    child.stdout?.on("data", (d) => (stdout += String(d)));
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

function firstVersion(text: string): string | undefined {
  const m = text.match(/\d+\.\d+(\.\d+)?/);
  return m ? m[0] : undefined;
}

function defaultPython(): string {
  return process.platform === "win32" ? "python" : "python3";
}

/** True when Scoop is installed for the current user (per-user, no admin). */
function hasScoop(): boolean {
  const home = process.env["USERPROFILE"] || process.env["HOME"] || "";
  if (!home) return false;
  const shims = path.join(home, "scoop", "shims");
  return existsSync(path.join(shims, "scoop.cmd")) || existsSync(path.join(shims, "scoop.ps1"));
}

/** Immediate subdirectories of `parent` matching `pattern`, joined with `sub`. */
function versionedBinDirs(parent: string, pattern: RegExp, sub = "bin"): string[] {
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isDirectory() && pattern.test(e.name))
      .map((e) => path.join(parent, e.name, sub))
      .filter(existsSync);
  } catch {
    return [];
  }
}

/**
 * On-disk directories where optional PDF tools commonly land but which aren't
 * necessarily on PATH — versioned Program Files installs (winget), Scoop shims,
 * and the winget Links shim dir. Empty on non-Windows (package managers there
 * put binaries on PATH already; we still add the common Homebrew prefixes).
 */
function extraToolDirs(): string[] {
  if (process.platform !== "win32") {
    return ["/opt/homebrew/bin", "/usr/local/bin"].filter(existsSync);
  }
  const pf = process.env["ProgramFiles"] || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = process.env["LOCALAPPDATA"] || "";
  const home = process.env["USERPROFILE"] || "";
  const dirs: string[] = [];
  dirs.push(...versionedBinDirs(pf, /^qpdf/i)); // "C:\Program Files\qpdf 12.3.2\bin"
  dirs.push(...versionedBinDirs(pf86, /^qpdf/i));
  dirs.push(...versionedBinDirs(path.join(pf, "gs"), /^gs/i)); // "C:\Program Files\gs\gs10.07.1\bin"
  dirs.push(...versionedBinDirs(path.join(pf86, "gs"), /^gs/i));
  if (home) dirs.push(path.join(home, "scoop", "shims"));
  if (local) dirs.push(path.join(local, "Microsoft", "WinGet", "Links"));
  return dirs.filter(existsSync);
}

/** PATH with `extraToolDirs()` appended (deduped). */
export function toolAugmentedPath(base = process.env["PATH"] ?? ""): string {
  const sep = process.platform === "win32" ? ";" : ":";
  const have = new Set(base.split(sep).map((d) => d.toLowerCase()));
  const extra = extraToolDirs().filter((d) => !have.has(d.toLowerCase()));
  return extra.length ? [base, ...extra].join(sep) : base;
}

/** process.env with PATH augmented, overwriting the existing key in its own casing. */
export function envWithToolPath(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  env[key] = toolAugmentedPath(env[key] ?? "");
  return env;
}
