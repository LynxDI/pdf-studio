// Install the freshly-built .vsix into the user's VS Code.
//
// Why a script (vs `code --install-extension ...` inline):
//   - On Windows, `code` resolves to `Code.exe`, which doesn't accept the CLI
//     flag — we need the `code.cmd` wrapper in `bin/`. Per-platform locations.
//   - We pick the most recently built lynxdi-pdf-studio-*.vsix rather than hard-coding
//     a version (which the version bump changes every build).
//
// After it completes, reload VS Code (Ctrl+Shift+P → "Developer: Reload Window").

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, "..");

function findVsix() {
  const candidates = fs
    .readdirSync(EXT_DIR)
    .filter((f) => f.startsWith("lynxdi-pdf-studio-") && f.endsWith(".vsix"))
    .map((f) => path.join(EXT_DIR, f));
  if (candidates.length === 0) {
    throw new Error("No lynxdi-pdf-studio-*.vsix found in " + EXT_DIR);
  }
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0];
}

function findCodeCli() {
  if (process.platform === "win32") {
    const localAppData = process.env["LOCALAPPDATA"];
    const programFiles = process.env["ProgramFiles"];
    const candidates = [
      localAppData && path.join(localAppData, "Programs", "Microsoft VS Code", "bin", "code.cmd"),
      programFiles && path.join(programFiles, "Microsoft VS Code", "bin", "code.cmd"),
    ].filter(Boolean);
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  }
  return "code";
}

const vsix = findVsix();
const codeCli = findCodeCli();
console.log(`[install-vsix] using ${codeCli}`);
console.log(`[install-vsix] installing ${path.basename(vsix)}`);

// shell:true is required on Windows for the .cmd wrapper; quote the paths
// because "Microsoft VS Code" contains a space.
const quoted = process.platform === "win32" ? `"${codeCli}"` : codeCli;
const res = spawnSync(quoted, ["--install-extension", `"${vsix}"`, "--force"], {
  stdio: "inherit",
  shell: true,
});

if (res.error || res.status !== 0) {
  console.error("[install-vsix] failed");
  process.exit(res.status ?? 1);
}

console.log("[install-vsix] done. Reload VS Code: Ctrl+Shift+P → Developer: Reload Window");
