// Workspace/project model helpers shared by the sidebar, runner, and commands.
//
// A "PDF Studio project" is just a folder containing one or more OpenPDF
// Workflow files (`*.opw.yaml`). There is no lock-in database — the .opw.yaml
// files are the source of truth, discoverable by glob.

import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { parseWorkflow, type Workflow } from "@pdf-studio/core";

export interface WorkflowFile {
  uri: vscode.Uri;
  /** Path relative to the workspace root, POSIX slashes. */
  relPath: string;
  /** Directory the workflow lives in (absolute). */
  baseDir: string;
  /** Parsed workflow, or null if it failed to parse. */
  workflow: Workflow | null;
  /** Parse error message, when workflow is null. */
  parseError?: string;
}

/** The first workspace folder, or undefined when no folder is open. */
export function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Find every `*.opw.yaml` (or `.opw.yml`) file in the workspace. */
export async function findWorkflowFiles(): Promise<WorkflowFile[]> {
  const root = workspaceRoot();
  if (!root) return [];
  const uris = await vscode.workspace.findFiles("**/*.opw.{yaml,yml}", "**/node_modules/**");
  uris.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
  const out: WorkflowFile[] = [];
  for (const uri of uris) {
    let workflow: Workflow | null = null;
    let parseError: string | undefined;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      workflow = parseWorkflow(Buffer.from(bytes).toString("utf8"));
    } catch (err) {
      parseError = (err as Error).message;
    }
    out.push({
      uri,
      relPath: path.relative(root, uri.fsPath).split(path.sep).join("/"),
      baseDir: path.dirname(uri.fsPath),
      workflow,
      parseError,
    });
  }
  return out;
}

/** Load and parse a single workflow file. */
export async function readWorkflowFile(uri: vscode.Uri): Promise<WorkflowFile> {
  const root = workspaceRoot() ?? path.dirname(uri.fsPath);
  let workflow: Workflow | null = null;
  let parseError: string | undefined;
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    workflow = parseWorkflow(Buffer.from(bytes).toString("utf8"));
  } catch (err) {
    parseError = (err as Error).message;
  }
  return {
    uri,
    relPath: path.relative(root, uri.fsPath).split(path.sep).join("/"),
    baseDir: path.dirname(uri.fsPath),
    workflow,
    parseError,
  };
}

/** Absolute output path for a workflow, or undefined if it has none. */
export function outputPath(wf: WorkflowFile): string | undefined {
  const file = wf.workflow?.output?.file;
  return file ? path.resolve(wf.baseDir, file) : undefined;
}

/** Configured python path (empty string means "auto-detect"). */
export function configuredPythonPath(): string | undefined {
  const p = vscode.workspace.getConfiguration("pdfStudio").get<string>("pythonPath");
  return p && p.trim() ? p.trim() : undefined;
}

/** Whether ops may offload to a remote GPU box over SSH (the `remote` param).
 *  Off by default: remote render runs commands on another machine over SSH. */
export function allowRemoteRender(): boolean {
  return vscode.workspace.getConfiguration("pdfStudio").get<boolean>("allowRemoteRender") === true;
}

/** Whether AI ops (summarize/translate) may send document text to a language model.
 *  Off by default; uses a local Ollama unless ANTHROPIC_API_KEY is set. */
export function allowAiRequests(): boolean {
  return vscode.workspace.getConfiguration("pdfStudio").get<boolean>("allowAiRequests") === true;
}

// --- PaddleOCR-VL interpreter (engine: paddleocr-vl runs in its OWN venv) ---------------

/** The python inside a paddle venv directory, per platform. */
export function paddleVenvPython(venvDir: string): string {
  return process.platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

// The extension-managed venv's interpreter (under globalStorage), set once on activate so
// the runner/sidebar can resolve it without threading the ExtensionContext everywhere.
let _paddleManagedPython: string | undefined;
export function setPaddleManagedPython(p: string): void {
  _paddleManagedPython = p;
}
export function paddleManagedPython(): string | undefined {
  return _paddleManagedPython;
}

/** The pdfStudio.paddlePythonPath setting, if set (a user-provided paddle interpreter). */
export function configuredPaddlePythonPath(): string | undefined {
  const p = vscode.workspace.getConfiguration("pdfStudio").get<string>("paddlePythonPath");
  return p && p.trim() ? p.trim() : undefined;
}

/** Resolve the interpreter for engine: paddleocr-vl — the explicit setting wins, else the
 *  extension-managed venv if it has been created. Undefined when neither exists. */
export function resolvePaddlePython(): string | undefined {
  const configured = configuredPaddlePythonPath();
  if (configured) return configured;
  const managed = _paddleManagedPython;
  return managed && fs.existsSync(managed) ? managed : undefined;
}

// --- extract_receipt vision-language endpoint (Qwen3-VL over an OpenAI-compatible API) ---

/** The VLM server URL for extract_receipt — the setting, else $PDFSTUDIO_VLM_ENDPOINT. */
export function configuredVlmEndpoint(): string | undefined {
  const s = vscode.workspace.getConfiguration("pdfStudio").get<string>("vlmEndpoint");
  return (s && s.trim()) || process.env["PDFSTUDIO_VLM_ENDPOINT"] || undefined;
}

/** The VLM model name for extract_receipt — the setting, else $PDFSTUDIO_VLM_MODEL. */
export function configuredVlmModel(): string | undefined {
  const s = vscode.workspace.getConfiguration("pdfStudio").get<string>("vlmModel");
  return (s && s.trim()) || process.env["PDFSTUDIO_VLM_MODEL"] || undefined;
}
