// esbuild bundler for the `opw` CLI.
//
// Produces a single self-contained dist/index.cjs (core + pdf-lib inlined) with a
// node shebang, plus dist/python/pdf_exec.py copied from the extension (the one
// source of the Python sidecar). The CLI resolves the sidecar relative to the
// bundle, so `opw` runs anywhere node + the dist/ folder go — no workspace needed.
//
// tsc -b runs first (typecheck + project refs); this script does the bundling.

import { build } from "esbuild";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import * as path from "node:path";

// Ship the Python sidecar with the CLI. Single source of truth: the extension's copy.
const SRC_PY = path.resolve("..", "extension", "resources", "python", "pdf_exec.py");
if (!existsSync(SRC_PY)) {
  console.error(`cli build: pdf_exec.py not found at ${SRC_PY}`);
  process.exit(1);
}
mkdirSync("dist/python", { recursive: true });
copyFileSync(SRC_PY, path.join("dist", "python", "pdf_exec.py"));

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.cjs",
  bundle: true,
  minify: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info",
});

if (!existsSync("dist/index.cjs")) {
  console.error("cli build failed: dist/index.cjs missing");
  process.exit(1);
}
console.log("opw CLI bundled → dist/index.cjs (+ dist/python/pdf_exec.py)");
