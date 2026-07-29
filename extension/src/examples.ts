// "Get Example Projects" — download runnable OPW example projects from the Lynx
// CDN straight into the user's workspace, so a first-time user has something real
// to render in one click.
//
// The bundles (one deterministic .zip per example + a manifest.json) are produced
// by the bundle generator and served publicly from the CDN. The base URL
// is configurable via `pdfStudio.examplesUrl` (so it can point at a local
// `npm run site:serve` during development, or move hosts later).
//
// Integrity: every zip's sha256 is checked against the manifest before a single
// byte is written, and archive entries are path-checked, so a corrupt download or
// a tampered/malicious archive can't write outside the target folder.

import * as vscode from "vscode";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { workspaceRoot } from "./project.js";
import { PdfStudioExplorer } from "./sidebar/explorer-provider.js";

const DEFAULT_BASE = "https://cdn.lynxdi.org/pdf-studio/examples/";

export interface ManifestExample {
  id: string;
  title: string;
  description: string;
  tags: string[];
  workflow: string | null;
  files: number;
  bytes: number;
  zip: string;
  zipBytes: number;
  sha256: string;
}

interface Manifest {
  schema: number;
  examples: ManifestExample[];
}

/**
 * The configured CDN base URL for example bundles, always with a trailing slash.
 *
 * https only, so the manifest that decides where bytes get written cannot be
 * supplied by anyone on the network path. Loopback is exempt because serving
 * bundles locally is the documented way to develop them.
 */
function examplesBaseUrl(): string {
  const raw = vscode.workspace.getConfiguration("pdfStudio").get<string>("examplesUrl")?.trim();
  const base = raw && raw.length ? raw : DEFAULT_BASE;
  const withSlash = base.endsWith("/") ? base : base + "/";
  let url: URL;
  try {
    url = new URL(withSlash);
  } catch {
    throw new Error(`pdfStudio.examplesUrl is not a valid URL: ${base}`);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`pdfStudio.examplesUrl must be an https:// URL (got ${url.protocol}//${url.hostname})`);
  }
  return withSlash;
}

/**
 * An example id names ONE folder under examples/ — nothing else. It arrives from
 * a downloaded manifest, so it is untrusted input that decides a write location:
 * unvalidated, an id of "../../../../AppData/.../Startup" walked the extraction
 * target out of the workspace entirely, and every archive entry then landed
 * there perfectly "safely" relative to it. safeJoin() guards the entries; this
 * guards the thing the entries are relative to.
 */
const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/i;

function safeExampleId(id: unknown): string {
  if (typeof id !== "string" || !SAFE_ID.test(id) || id.includes("..")) {
    throw new Error(`manifest declares an unsafe example id: ${JSON.stringify(id)}`);
  }
  return id;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function fetchManifest(base: string): Promise<Manifest> {
  const bytes = await fetchBytes(base + "manifest.json");
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Manifest;
  if (!parsed || !Array.isArray(parsed.examples)) throw new Error("manifest.json is not in the expected shape");
  // Validate every id once, here, so nothing downstream has to remember to. An
  // entry with a bad id is dropped rather than failing the whole download: the
  // rest of the catalogue is still usable, and the reason is reported.
  const safe: ManifestExample[] = [];
  for (const ex of parsed.examples) {
    try {
      safeExampleId(ex?.id);
      safe.push(ex);
    } catch (err) {
      console.warn(`[pdf-studio] skipping example from manifest: ${(err as Error).message}`);
    }
  }
  return { ...parsed, examples: safe };
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Reject archive entries that would escape the target dir (absolute or ../ paths). */
function safeJoin(root: string, rel: string): string | undefined {
  if (rel.startsWith("/") || rel.startsWith("\\") || /^[a-zA-Z]:/.test(rel)) return undefined;
  const dest = path.resolve(root, rel);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  return dest === root || dest.startsWith(rootWithSep) ? dest : undefined;
}

/** Extract a verified zip into destDir. Returns the number of files written. */
async function extractInto(zip: Uint8Array, destDir: string): Promise<number> {
  const files = unzipSync(zip);
  let written = 0;
  for (const [rel, data] of Object.entries(files)) {
    if (rel.endsWith("/")) continue; // directory entry
    const dest = safeJoin(destDir, rel);
    if (!dest) throw new Error(`refusing unsafe archive path: ${rel}`);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(dest)));
    await vscode.workspace.fs.writeFile(vscode.Uri.file(dest), data);
    written++;
  }
  return written;
}

async function dirExistsNonEmpty(dir: string): Promise<boolean> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
    return entries.length > 0;
  } catch {
    return false;
  }
}

/**
 * Download selected example projects from the CDN into `<workspace>/examples/<id>/`.
 * Multi-select, all pre-checked, so the default gesture grabs every example.
 */
export async function downloadExamples(explorer?: PdfStudioExplorer): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    void vscode.window.showErrorMessage("Lynx PDF Studio: open a folder first, then download examples into it.");
    return;
  }
  const base = examplesBaseUrl();

  // 1. Fetch the manifest.
  let manifest: Manifest;
  try {
    manifest = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Lynx PDF Studio: fetching example catalog…" },
      () => fetchManifest(base),
    );
  } catch (err) {
    const detail = (err as Error).message;
    const openSettings = "Change Examples URL";
    void vscode.window
      .showErrorMessage(`Couldn't load the example catalog from ${base} (${detail}).`, openSettings)
      .then((c) => {
        if (c === openSettings)
          void vscode.commands.executeCommand("workbench.action.openSettings", "pdfStudio.examplesUrl");
      });
    return;
  }
  if (manifest.examples.length === 0) {
    void vscode.window.showInformationMessage("Lynx PDF Studio: the example catalog is empty.");
    return;
  }

  // 2. Let the user pick (everything pre-selected).
  const items: (vscode.QuickPickItem & { ex: ManifestExample })[] = manifest.examples.map((ex) => ({
    label: ex.title,
    description: `${ex.id} · ${(ex.zipBytes / 1024).toFixed(1)} KB`,
    detail: ex.description,
    picked: true,
    ex,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: "Get Example Projects",
    placeHolder: "Select the example projects to download (all selected by default)",
  });
  if (!picked || picked.length === 0) return;
  const chosen = picked.map((p) => p.ex);

  // 3. Handle collisions once, up front.
  const examplesRoot = path.join(root, "examples");
  const existing: string[] = [];
  for (const ex of chosen) {
    if (await dirExistsNonEmpty(path.join(examplesRoot, ex.id))) existing.push(ex.id);
  }
  let overwrite = false;
  if (existing.length) {
    const ov = "Overwrite";
    const skip = "Skip existing";
    const answer = await vscode.window.showWarningMessage(
      `${existing.length} example folder(s) already exist under examples/ (${existing.join(", ")}).`,
      { modal: true },
      ov,
      skip,
    );
    if (answer === undefined) return; // cancelled
    overwrite = answer === ov;
  }

  // 4. Download → verify → extract, with progress.
  const results = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Lynx PDF Studio: downloading examples…", cancellable: true },
    async (progress, token) => {
      const done: { id: string; workflow: string | null }[] = [];
      const skipped: string[] = [];
      const failed: { id: string; why: string }[] = [];
      const step = 100 / chosen.length;
      for (const ex of chosen) {
        if (token.isCancellationRequested) break;
        // Belt and braces: ids are validated in fetchManifest, and the result is
        // re-confined here so the destination is subject to the same check as
        // every file written into it.
        const destDir = safeJoin(examplesRoot, safeExampleId(ex.id));
        if (!destDir) throw new Error(`unsafe example id: ${ex.id}`);
        if (existing.includes(ex.id) && !overwrite) {
          skipped.push(ex.id);
          progress.report({ increment: step });
          continue;
        }
        progress.report({ message: ex.title });
        try {
          const zip = await fetchBytes(base + ex.zip);
          const got = sha256(zip);
          if (got !== ex.sha256) throw new Error(`checksum mismatch (expected ${ex.sha256.slice(0, 12)}, got ${got.slice(0, 12)})`);
          await extractInto(zip, destDir);
          done.push({ id: ex.id, workflow: ex.workflow });
        } catch (err) {
          failed.push({ id: ex.id, why: (err as Error).message });
        }
        progress.report({ increment: step });
      }
      return { done, skipped, failed };
    },
  );

  explorer?.refresh();

  // 5. Report + open the first downloaded workflow.
  const first = results.done.find((d) => d.workflow);
  if (first) {
    // `workflow` is another manifest-supplied string, so it decides which file
    // gets opened in the editor — confine it to the example's own directory.
    const exDir = safeJoin(examplesRoot, first.id);
    const wfPath = exDir ? safeJoin(exDir, first.workflow!) : undefined;
    try {
      if (wfPath) await vscode.window.showTextDocument(vscode.Uri.file(wfPath), { preview: false });
    } catch {
      /* best effort */
    }
  }

  const parts: string[] = [];
  if (results.done.length) parts.push(`downloaded ${results.done.length}`);
  if (results.skipped.length) parts.push(`skipped ${results.skipped.length}`);
  if (results.failed.length) parts.push(`failed ${results.failed.length}`);
  const summary = `Lynx PDF Studio: ${parts.join(", ") || "nothing to do"}.`;
  if (results.failed.length) {
    void vscode.window.showWarningMessage(`${summary} (${results.failed.map((f) => `${f.id}: ${f.why}`).join("; ")})`);
  } else if (results.done.length) {
    const reveal = "Reveal in Explorer";
    void vscode.window.showInformationMessage(summary, reveal).then((c) => {
      if (c === reveal) void vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(examplesRoot));
    });
  } else {
    void vscode.window.showInformationMessage(summary);
  }
}
