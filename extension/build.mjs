// esbuild bundler for the PDF Studio extension.
//
// Produces four artifacts:
//   dist/extension.js          — the extension host (CJS, Node, external vscode)
//   dist/webview/preview.js     — the pdf.js viewer (IIFE, browser)
//   dist/webview/pdf.worker.js  — pdf.js worker (IIFE, browser)
//   dist/mcp/index.cjs          — the self-contained OPW MCP server (staged into
//                                 the user's home dir + referenced by .mcp.json)
//
// tsc -b runs first (typecheck + project refs); this script does the bundling.

import { build } from "esbuild";
import { existsSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const watch = process.argv.includes("--watch");

// Bundle the user-facing guides INTO the VSIX so the Documentation panel opens them in an
// in-editor Markdown preview — offline, no external URL. (The docs live in the private source
// repo, so a public GitHub link 404s; this ships the content instead.)
{
  const dest = "resources/docs";
  mkdirSync(dest, { recursive: true });
  for (const [src, name] of [
    ["../docs/python-setup.md", "python-setup.md"],
    ["../examples/ocr-engines/README.md", "ocr-engines.md"],
    ["../docs/cli.md", "cli.md"],
  ]) {
    if (existsSync(src)) copyFileSync(src, `${dest}/${name}`);
  }
}

// Generate the Copilot `chatInstructions` markdown from the SAME source as the
// agent map (buildAgentMap), so Copilot users get byte-for-byte the onboarding
// Claude Code / Codex / Gemini get. agent-map-content.ts is vscode-free, so we
// esbuild it to a throwaway CJS bundle, run it, and write the result. Fails the
// build loudly if it can't be produced — it's a shipped VSIX artifact.
{
  const version = require("./package.json").version;
  const instrDir = "resources/instructions";
  const tmp = resolve("dist", ".agent-map-content.cjs");
  mkdirSync("dist", { recursive: true });
  await build({
    entryPoints: ["src/agents/agent-map-content.ts"],
    outfile: tmp,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    logLevel: "silent",
  });
  try {
    const { buildAgentMap } = require(tmp);
    const md = buildAgentMap({ extensionVersion: version });
    mkdirSync(instrDir, { recursive: true });
    writeFileSync(`${instrDir}/pdf-studio.instructions.md`, md);
    console.log(`Generated ${instrDir}/pdf-studio.instructions.md`);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Resolve the pdf.js worker entry across pdfjs-dist layouts. */
function pdfWorkerEntry() {
  for (const cand of ["pdfjs-dist/build/pdf.worker.mjs", "pdfjs-dist/build/pdf.worker.js"]) {
    try {
      return require.resolve(cand);
    } catch {
      /* try next */
    }
  }
  throw new Error("could not resolve pdfjs-dist worker entry");
}

const common = {
  bundle: true,
  minify: !watch,
  sourcemap: watch,
  logLevel: "info",
};

const jobs = [
  build({
    ...common,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
  }),
  build({
    ...common,
    entryPoints: ["src/webview/preview.ts"],
    outfile: "dist/webview/preview.js",
    platform: "browser",
    format: "iife",
    target: "es2020",
  }),
  build({
    ...common,
    entryPoints: [pdfWorkerEntry()],
    outfile: "dist/webview/pdf.worker.js",
    platform: "browser",
    format: "iife",
    target: "es2020",
  }),
  // Self-contained MCP server: core + the MCP SDK inlined, so the staged copy in
  // ~/.lynx-pdf-studio/mcp runs with just `node` (no node_modules alongside it).
  build({
    ...common,
    entryPoints: ["../mcp/src/index.ts"],
    outfile: "dist/mcp/index.cjs",
    platform: "node",
    format: "cjs",
    target: "node20",
  }),
];

await Promise.all(jobs);

for (const artifact of ["dist/extension.js", "dist/mcp/index.cjs"]) {
  if (!existsSync(artifact)) {
    console.error(`build failed: ${artifact} missing`);
    process.exit(1);
  }
}
console.log("PDF Studio extension bundled (incl. dist/mcp/index.cjs).");
