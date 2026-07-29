// Platform-specific VSIX packaging for Lynx PDF Studio.
//
// IMPORTANT — why this is far simpler than the tax project's version:
//   This extension ships **NO native modules**. Its VSIX is pure JS bundles
//   (esbuild) + plain-text Python sidecars + resources — verified: zero
//   .node/.dll/.dylib/.so/.exe entries. Everything platform-heavy (PyMuPDF,
//   qpdf, Ghostscript, Tesseract, Chrome, LibreOffice) is a tool the extension
//   *spawns* from the user's machine, never bundles. So the SAME universal
//   bundle runs identically on macOS, Windows, and Linux.
//
//   That means: the plain `npm run package` (no --target) already produces a
//   VSIX that installs and runs on macOS. Per-platform VSIXes are NOT required
//   here — unlike tax, which must ship one per {os,arch,ABI} because its
//   compiled better_sqlite3.node only dlopen()s on the arch it was built for.
//
//   This script exists so you CAN still emit platform-tagged VSIXes when you
//   want them — e.g. to publish per-platform Marketplace listings, or as a
//   ready-made path if a native dependency is ever added. Each target's payload
//   is byte-identical except the manifest's TargetPlatform, so there is no
//   native binary to fetch or arch-verify.
//
// Usage (from extension/):
//   node scripts/package-targets.mjs                     # all desktop targets
//   node scripts/package-targets.mjs darwin-arm64        # just one (or several)
//   node scripts/package-targets.mjs --targets darwin-arm64,darwin-x64
//   npm run package:targets                              # bump once + build once + all targets
//
// Output: lynxdi-pdf-studio-<target>-<version>.vsix, each verified to carry the
// correct TargetPlatform in its manifest before it is accepted.
//
// Publishing note: publish every platform target together, at the SAME version:
//   vsce publish --packagePath lynxdi-pdf-studio-darwin-arm64-<v>.vsix  <others…>
// If you publish ANY platform-specific build, also keep a universal build (plain
// `npm run package`) published so platforms you didn't target can still install.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync, strFromU8 } from "fflate";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.resolve(__dirname, "..");
const pkg = require(path.join(extRoot, "package.json"));

// VS Code platform-specific targets. Desktop matrix by default; add web targets
// (`web`) or `alpine-*` here only if you actually publish them.
const TARGETS = ["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"];

/** Resolve a package's bin script to an absolute path (no .cmd shims, cross-OS). */
function binOf(pkgName, binKey) {
  const pkgJsonPath = require.resolve(`${pkgName}/package.json`, { paths: [extRoot] });
  const dir = path.dirname(pkgJsonPath);
  const bin = require(pkgJsonPath).bin;
  const rel = typeof bin === "string" ? bin : bin[binKey];
  return path.join(dir, rel);
}

/** Confirm the produced VSIX actually declares the target platform we asked for. */
function assertVsixTarget(file, target) {
  const zip = unzipSync(new Uint8Array(fs.readFileSync(file)));
  const manifest = zip["extension.vsixmanifest"];
  if (!manifest) throw new Error(`${path.basename(file)}: no extension.vsixmanifest inside the VSIX`);
  const xml = strFromU8(manifest);
  if (!xml.includes(`TargetPlatform="${target}"`)) {
    throw new Error(`${path.basename(file)}: manifest does not declare TargetPlatform="${target}"`);
  }
}

function packageTarget(target, vsce) {
  const out = path.join(extRoot, `lynxdi-pdf-studio-${target}-${pkg.version}.vsix`);
  console.log(`\n=== ${target} (v${pkg.version}) ===`);
  // --no-dependencies / --no-yarn mirror the universal `package` script; vsce runs
  // vscode:prepublish itself only if defined — the bundles are already built by the
  // caller (npm run package:targets), so this just zips + tags.
  execFileSync(process.execPath, [vsce, "package", "--no-yarn", "--no-dependencies", "--target", target, "--out", out], {
    cwd: extRoot,
    stdio: "inherit",
  });
  assertVsixTarget(out, target);
  console.log(`  ✓ ${path.basename(out)} (TargetPlatform=${target})`);
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const takeFlag = (name) => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    argv.splice(i, v === undefined ? 1 : 2);
    return v;
  };
  const targetsFlag = takeFlag("--targets");
  let requested = targetsFlag ? targetsFlag.split(",") : argv.filter((a) => !a.startsWith("--"));
  requested = requested.map((t) => t.trim()).filter(Boolean);
  const targets = requested.length ? requested : TARGETS;

  const unknown = targets.filter((t) => !TARGETS.includes(t));
  if (unknown.length) {
    console.error(`Unknown target(s): ${unknown.join(", ")}\nKnown: ${TARGETS.join(", ")}`);
    process.exit(1);
  }

  const vsce = binOf("@vscode/vsce", "vsce");
  console.log(`Packaging ${targets.length} platform target(s) at v${pkg.version}.`);
  console.log("(No native modules — payload is identical across targets; only the manifest TargetPlatform differs.)");

  const built = [];
  for (const t of targets) built.push(packageTarget(t, vsce));

  console.log(`\nDone. ${built.length} VSIX(es):`);
  for (const f of built) console.log("  " + path.basename(f));
  console.log("\nPublish them together at the same version, e.g.:");
  console.log("  vsce publish --packagePath " + built.map((f) => path.basename(f)).join(" "));
}

main();
