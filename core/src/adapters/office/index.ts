// CliOfficeAdapter — optional Office ⇆ PDF conversion via LibreOffice (soffice).
//
// Shells out to `soffice --headless --convert-to …` (the same mechanism
// Stirling-PDF uses). Lights up only when LibreOffice is installed; otherwise
// its capabilities stay unsatisfied, exactly like the Python/CLI backends.
//
// Windows quirks handled: `soffice.exe` can return BEFORE the conversion file is
// written, so we also poll for the expected output; a per-run UserInstallation
// profile avoids the single-instance lock when the user has LibreOffice open.

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import type { Capability } from "../../opw/operations.js";
import type { DocumentKind } from "../../opw/model.js";
import type { PlanStep } from "../../opw/compile.js";
import type { AdapterResult, EmittedArtifact, ExecContext, RendererAdapter } from "../adapter.js";
import { OFFICE_CAPABILITIES } from "../capabilities.js";
import { envWithToolPath, sofficeInstallPaths } from "../../deps/check.js";

/** op → { LibreOffice convert-to filter, output extension }. */
const TO_OFFICE: Record<string, { fmt: string; ext: string }> = {
  pdf_to_docx: { fmt: "docx:MS Word 2007 XML", ext: "docx" },
  pdf_to_pptx: { fmt: "pptx:Impress MS PowerPoint 2007 XML", ext: "pptx" },
  pdf_to_xlsx: { fmt: "xlsx:Calc MS Excel 2007 XML", ext: "xlsx" },
  pdf_to_html: { fmt: "html:HTML (StarWriter)", ext: "html" },
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Candidate soffice invocations: bare names (PATH) + standard install paths. */
function candidates(): string[] {
  return ["soffice", "libreoffice", ...sofficeInstallPaths()];
}

function run(exe: string, args: string[], timeoutMs: number): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = "";
    let done = false;
    const finish = (code: number) => {
      if (!done) {
        done = true;
        resolve({ code, stderr });
      }
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(exe, args, { windowsHide: true, env: envWithToolPath() });
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

export class CliOfficeAdapter implements RendererAdapter {
  readonly id = "cli-office";
  readonly kinds: readonly DocumentKind[] = ["pdf"];
  readonly capabilities: readonly Capability[] = OFFICE_CAPABILITIES;
  private exe: string | null = null;
  private resolved = false;

  async isAvailable(): Promise<boolean> {
    if (!this.resolved) {
      this.exe = await this.resolveExe();
      this.resolved = true;
    }
    return this.exe !== null;
  }

  private async resolveExe(): Promise<string | null> {
    for (const cand of candidates()) {
      if (nodePath.isAbsolute(cand)) {
        if (existsSync(cand)) return cand;
        continue;
      }
      const res = await run(cand, ["--version"], 20_000);
      if (res.code === 0) return cand;
    }
    return null;
  }

  async apply(ctx: ExecContext, step: PlanStep): Promise<AdapterResult> {
    if (!(await this.isAvailable()) || !this.exe) {
      throw new Error("cli-office: LibreOffice (soffice) not found");
    }
    if (step.op !== "office_to_pdf" && !ctx.current) {
      throw new Error(`cli-office: no working document for "${step.op}"`);
    }
    const tmpDir = await mkdtemp(nodePath.join(os.tmpdir(), "opw-office-"));
    const profile = nodePath.join(tmpDir, "profile");
    const profileArg = `-env:UserInstallation=file:///${profile.replace(/\\/g, "/")}`;
    try {
      if (step.op === "office_to_pdf") {
        const from = String(step.params["from"] ?? "docx").replace(/[^a-z0-9]/gi, "") || "docx";
        const inFile = nodePath.join(tmpDir, `input.${from}`);
        await writeFile(inFile, ctx.current ?? new Uint8Array());
        const outPdf = nodePath.join(tmpDir, "input.pdf");
        await this.convert([profileArg, "--headless", "--convert-to", "pdf", "--outdir", tmpDir, inFile], outPdf);
        return { current: await readFile(outPdf), note: `converted ${from} → PDF (LibreOffice)` };
      }

      const target = TO_OFFICE[step.op]!;
      const inFile = nodePath.join(tmpDir, "input.pdf");
      await writeFile(inFile, ctx.current!);
      const outFile = nodePath.join(tmpDir, `input.${target.ext}`);
      await this.convert([profileArg, "--headless", "--infilter=writer_pdf_import", "--convert-to", target.fmt, "--outdir", tmpDir, inFile], outFile);
      const to = String(step.params["to"] ?? `output/converted.${target.ext}`);
      const artifact: EmittedArtifact = { path: to, bytes: await readFile(outFile), kind: "pdf" };
      return { artifacts: [artifact], note: `converted PDF → ${target.ext} (LibreOffice)` };
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Run soffice, then poll for the expected output (soffice.exe can return
   *  before the file is flushed on Windows). */
  private async convert(args: string[], expectedOut: string): Promise<void> {
    const res = await run(this.exe!, args, 120_000);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (existsSync(expectedOut)) return;
      await sleep(300);
    }
    throw new Error(`LibreOffice conversion produced no output${res.stderr ? `: ${res.stderr.trim().slice(-200)}` : " (timed out)"}`);
  }
}
