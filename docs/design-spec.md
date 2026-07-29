# PDF Studio — Design Specification

**Version:** 1.0 · **Status:** Phases 1 and 2 implemented; see the roadmap at the end
**Companion to:** [opw-spec.md](opw-spec.md) (the OPW format) and
[operations.md](operations.md) (the operation reference)

This document records the architecture as built and the principles behind it. It
supersedes the "Local MCP Server → Python engine" sketch in the original PRD with
the concrete, layered design the team converged on.

---

## 1. Positioning — OPW is a workflow layer, not a PDF format

PDF Studio is organized around one idea: **you edit a workflow, not a document.**

The **OpenPDF Workflow (OPW)** is an open, deterministic *workflow specification*
for document transformations. It is deliberately **not** "another PDF format." It
is a layer in a three-tier stack:

```
┌────────────────────────────────────────────────┐
│ Content layer     PDF  (→ PPTX, DOCX, SVG, …)   │  what you transform
├────────────────────────────────────────────────┤
│ Workflow layer    OPW                           │  how you describe the transform
├────────────────────────────────────────────────┤
│ Execution layer   pdf-lib · PyMuPDF · pikepdf   │  what performs it
│                   qpdf · Ghostscript · OCR       │
└────────────────────────────────────────────────┘
```

OPW does not replace PDF — it *describes how to transform a PDF*. The PDF is a
build artifact; the OPW file is the source of truth. This mirrors modern software
engineering:

| Source | Compiler/Runtime | Artifact |
|--------|------------------|----------|
| Source code | compiler | executable |
| OpenTimelineIO | ffmpeg | rendered video |
| **OpenPDF Workflow** | **renderer adapter** | **rendered PDF** |

### 1.1 A document-transformation DSL

Because operations are capability-oriented and the document domain is an explicit
`kind` field (only `pdf` is wired today), OPW is designed to grow into a general
**document-transformation DSL**. The same workflow language can later target
PowerPoint, Word, Excel, SVG, images — or even video through a different backend —
without changing the schema. The schema is built for that extensibility from day
one; the product starts focused on PDF.

---

## 2. The compiler pipeline

Authoring is separated from execution. A workflow is *compiled*, and the compiler
has distinct, inspectable stages:

```
AI / human
    │
    ▼
workflow.opw.yaml ──parse──► Workflow (AST)
    │
    ▼
Validator          → Diagnostic[]        structural + per-op param checks
    │
    ▼
Optimizer          → Workflow', Rewrite[] behavior-preserving rewrites
    │
    ▼
Compile            → ExecutionPlan         steps bound to adapters; unsatisfied set
    │
    ▼
Renderer Adapter   → bytes → bytes         one backend per step
    │
    ▼
Output PDF (+ side artifacts)
```

Each stage is a pure function (no fs, no adapters until compile), so it runs
identically in the editor, the MCP server, and CI. The plan is deterministic and
side-effect-free, which is what lets it be **previewed, diffed, and content-hashed**
for caching.

| Stage | Module (`@pdf-studio/core`) | Output |
|-------|-----------------------------|--------|
| Parse | `opw/io.ts` | `Workflow` |
| Validate | `opw/validate.ts` | `Diagnostic[]` |
| Optimize | `opw/optimize.ts` | `Workflow` + `Rewrite[]` |
| Compile | `opw/compile.ts` | `ExecutionPlan` |
| Execute | `execute.ts` + adapters | output bytes + artifacts |

### 2.1 Why a separate Optimizer stage

The optimizer is where the workflow is rewritten into an equivalent, cheaper one:
drop a no-op `merge` (single input), coalesce multiple `set_metadata` into one,
keep only the final `compress` and hoist it to the end. Every rewrite is
behavior-preserving and *reported*, so the diff view (and the human) can see
exactly what changed. This is the OPW analog of a compiler's peephole pass, and it
is the natural home for future passes (fold adjacent page ops, dedupe re-saves).

---

## 3. The renderer-adapter seam (execution layer)

The single most important abstraction is the **`RendererAdapter`**. An adapter
advertises:

- the **document kinds** it handles (`["pdf"]`),
- the **capabilities** it can execute (`merge`, `rotate_pages`, `ocr`, …),
- an `isAvailable()` probe, and
- an `apply(ctx, step)` that transforms the working document.

The `AdapterRegistry` resolves each plan step to the first *available* adapter
that provides its capability. Consequences:

- **Zero-install MVP.** The bundled `PdfLibAdapter` (pure JS/WASM) satisfies every
  structural capability, so the extension works the moment it's installed.
- **Graceful capability gaps.** An op needing a capability no available adapter
  provides (e.g. `ocr` without PyMuPDF) is surfaced by `compile` as an
  `unsatisfied` entry — a planning result ("install PyMuPDF to enable OCR"), never
  a crash.
- **Backend swap without workflow change.** Dropping in a `PythonAdapter`
  (PyMuPDF/pikepdf/qpdf) upgrades `compress` from basic re-save to real image
  downsampling and unlocks `extract_text`/`redact`/`ocr` — the `.opw.yaml` is
  untouched.

```
resolve(kind, capability) → first available adapter advertising it
capabilitiesFor(kind)     → union of capabilities across available adapters
```

---

## 4. Dependency model + the color-coded sidebar

The Python execution layer is **optional**. `core/deps/check.ts` probes, in one
Python invocation plus two CLI checks, the state of every backend:

| Backend | Kind | Unlocks |
|---------|------|---------|
| pdf-lib | bundled | structural ops (always available) |
| Python | interpreter | gate for the libs below |
| PyMuPDF | python | extract_text, extract_images, redact |
| pikepdf | python | replace_image, compress |
| pypdf | python | merge, split |
| ReportLab | python | watermark, generate |
| OCRmyPDF | python | ocr |
| qpdf | cli | compress, linearize |
| Ghostscript | cli | deep compress |

The extension renders these as a **Dependencies** tree section, color-coded with
tinted `ThemeIcon`s (the File Content Index pattern):

```
Dependencies                    6/9 ready
  ● pdf-lib (bundled)   available (bundled 1.17.1)     testing.iconPassed  (green)
  ● Python engine       available (3.13.7)             testing.iconPassed  (green)
  ● PyMuPDF             available (1.24.0)             testing.iconPassed  (green)
  ⚠ qpdf                not installed — click to set up list.warningForeground (yellow)
  ✗ …                   errored probe                  problemsErrorIcon   (red)
```

Missing entries are clickable → **Set Up Dependency** offers "Run in Terminal"
(runs the `pip install …` / package hint) or "Copy Command." Availability is
cached and re-probed on demand and when `pdfStudio.pythonPath` changes.

---

## 5. Monorepo architecture (as built)

```
core/       @pdf-studio/core  — pure Node, zero vscode. The whole OPW engine:
  opw/        model, io (YAML/JSON), operations registry, validate, optimize,
              compile, diff
  adapters/   adapter interface + registry; pdflib/ backend
  deps/       dependency probing
  execute.ts  the pipeline orchestrator (pluggable HostFs)
  hashing.ts  content keys for caching

mcp/        @pdf-studio/mcp   — stdio MCP server; deterministic OPW helpers only.
extension/  pdf-studio        — VS Code UI: sidebar, runner, pdf.js preview,
                                scaffolder, agent-map generator. esbuild-bundled.
```

The boundaries are the point: **core is pure and testable** (the full pipeline
runs on in-memory PDFs, no filesystem required), the **extension is thin glue**,
and the **MCP never renders** — heavy compute runs locally in-process.

### 5.1 Filesystem injection

`runWorkflow` takes a `HostFs { readFile, writeFile }`. Tests supply an in-memory
map; the extension supplies node fs rooted at the workflow's directory; a future
cloud runner supplies a remote fs. Core never imports `vscode`, and only optionally
touches `node:fs` (via the default `nodeFs` helper).

---

## 6. MCP surface

The local `pdf-studio` MCP server (stdio, wired via `.mcp.json`) is the agent's
*reasoning* surface. Every tool is deterministic and side-effect-free:

`opw_operations` · `opw_validate` · `opw_optimize` · `opw_compile` · `opw_diff` ·
`opw_scaffold`.

The intended agent loop: read the `.opw.yaml` → edit it → `opw_validate` (fix every
error) → optionally `opw_compile` to preview the plan → let the extension render.
This is the PRD's "primitive tools + workflow tools" split, with the workflow tools
front-and-center: agents preferentially modify the workflow, not the PDF.

---

## 7. Extension UX

- **Activity-bar view "PDF Studio":** Workflows (each expands to inputs / operations
  / output) and the color-coded Dependencies section.
- **Commands:** Initialize Project, New Workflow, Render Workflow, Validate, Optimize,
  Show Execution Plan, Open Preview, Check Dependencies, Set Up Dependency, Generate
  Agent Map, Reveal Output.
- **Save-watcher:** on saving a `.opw.yaml`, validate (→ Problems panel) and, if
  clean, auto-render — the tight edit→render loop.
- **Preview:** an in-editor pdf.js webview renders the output to canvas.
- **Agent map:** writes `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` (byte-identical) so a
  coding agent knows OPW is the source of truth and how to edit it.

---

## 8. Security

- **Local execution by default.** The bundled backend runs in-process; the MCP
  server does no fs or rendering.
- **Explicit setup for optional backends.** Nothing installs Python packages or
  runs a terminal command without a click.
- **Workspace-scoped.** Inputs/outputs/assets resolve relative to the workflow
  file; the executor writes only where the workflow's `output` and split artifacts
  point.
- **Git as the audit log.** Because the OPW file is text and the source of truth,
  every transformation is a reviewable diff and revertible commit.

---

## 9. Roadmap (mapped to the PRD)

**Phase 1 — done.** OPW engine + compile pipeline; bundled pdf-lib backend
(merge/split/rotate/reorder/delete/extract/watermark/metadata/insert-blank/compress);
MCP server; extension (sidebar + color-coded deps, runner, preview, scaffold, agent
map).

**Phase 2 — done.** `PythonAdapter` (PyMuPDF/pikepdf/qpdf/Ghostscript/OCR)
unlocking extract_text, extract/replace images, true redaction, deep compression
and OCR; batch workflows (glob inputs, fan-out); visual diff; table extraction;
Markdown export; incremental render caching via `workflowContentKey`. Also
landed here, beyond the original plan: the forms system (12 government form
packs, fill/create/extract), the CLI, and vision-model OCR engines.

**Phase 3.** AI semantic editing; additional `kind`s (PPTX/DOCX/SVG) proving OPW as
a cross-format DSL; remote MCP + cloud execution; workflow marketplace.

---

## 10. Design principles

1. **Editing = editing a plain-text file.** The workflow is code; git is the undo stack.
2. **Deterministic, inspectable pipeline.** Validate → optimize → plan are pure and previewable.
3. **Pluggable execution.** The adapter seam keeps OPW engine-agnostic and future-proof.
4. **Zero-install baseline, opt-in power.** Works immediately; scales up when backends are present.
5. **Honest capability reporting.** Unsatisfied operations are surfaced, never silently ignored.
