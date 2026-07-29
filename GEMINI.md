# PDF Studio — Monorepo Guide (for coding agents)

This repository is the **source** of the PDF Studio VS Code extension and the
**OpenPDF Workflow (OPW)** engine. (This is the dev monorepo — not an end-user
PDF project. When the extension runs in a user's workspace it generates a
different, user-facing CLAUDE.md there describing how to edit their `.opw.yaml`.)

## What this project is

PDF Studio treats PDFs as **programmable build artifacts**. Users edit an
**OpenPDF Workflow (OPW)** file — human-readable YAML — and a deterministic engine
renders the PDF. OPW is a *workflow layer* (a document-transformation DSL), not a
PDF format:

```
Content layer   PDF (later: PPTX/DOCX/SVG/…)
Workflow layer  OPW                              ← the source of truth
Execution layer pdf-lib (bundled) · PyMuPDF/pikepdf/qpdf/Ghostscript (optional)
```

Compiler pipeline: `parse → Validator → Optimizer → Execution Plan → Renderer Adapter → PDF`.

## Monorepo layout

```
core/       @pdf-studio/core — pure Node, ZERO vscode imports. The OPW engine.
  src/opw/       model.ts · io.ts · operations.ts · validate.ts · optimize.ts · compile.ts · diff.ts
  src/adapters/  adapter.ts (interface + registry) · pdflib/ (bundled JS backend)
  src/deps/      check.ts (dependency probing for the color-coded sidebar)
  src/execute.ts the pipeline orchestrator (pluggable HostFs)
  src/index.ts   public surface
mcp/        @pdf-studio/mcp — stdio MCP server. Deterministic OPW helpers only. NEVER renders.
extension/  pdf-studio — the VS Code extension (esbuild-bundled).
  src/extension.ts · commands.ts · workflow-runner.ts · preview-panel.ts · project-init.ts
  src/sidebar/explorer-provider.ts (color-coded Dependencies) · agents/agent-map.ts
  src/webview/preview.ts (pdf.js viewer)
examples/   runnable sample OPW projects.
docs/       design-spec.md · opw-spec.md · operations.md
```

## Build & test

```bash
npm install
npm run build          # tsc -b across core, mcp, extension (+ esbuild bundles the extension)
```

- Build the extension bundle: `cd extension && node build.mjs` (after `tsc -b`).
- Smoke-test the MCP server: pipe a JSON-RPC `initialize` + `tools/list` into `node mcp/dist/index.js`.

## Checking your work

This repository ships the engine and the extension, not the test suite — the unit
tests and the VS Code integration harness live with the maintainers. So verify a
change the way the product is actually used:

```bash
npm run build                                    # must be clean; strict TS is the first gate
node mcp/dist/index.js                           # JSON-RPC: pipe initialize + tools/list in
```

Then render something. `examples/` holds 17 runnable projects: open one in VS Code
with the extension installed and run **PDF Studio: Render Workflow**, or drive the
same pipeline from the CLI (see [docs/cli.md](docs/cli.md)). A change to an
operation should show up in the rendered PDF; a change to validation should show up
as a diagnostic in the editor.

## Architectural rules (hold these invariant)

1. **`core` never imports `vscode`.** It is pure Node. All engine logic lives here.
2. **The MCP server never renders or touches the filesystem.** It exposes only
   deterministic OPW helpers (validate/optimize/compile/diff/operations/scaffold).
   Heavy execution runs locally in the extension via `runWorkflow`.
3. **The renderer-adapter seam is sacred.** Add capabilities by (a) adding an entry
   to `opw/operations.ts` and (b) implementing it in an adapter. The compiler binds
   ops to adapters by capability; nothing references op names by string literal
   except the registry.
4. **Pages are 1-based in OPW**, converted to 0-based only inside adapters.
5. **Preserve unknown fields** on parse→serialize (forward compatibility).
6. **Determinism.** validate/optimize/compile are pure functions; the plan is
   previewable, diffable, and content-hashable.

## Adding an operation (worked example)

1. Add an `OperationSpec` to `OPERATIONS` in `core/src/opw/operations.ts` (name,
   capability, kinds, params).
2. If a bundled backend can do it, add a case in
   `core/src/adapters/pdflib/index.ts` and list the capability in its
   `CAPABILITIES`. Otherwise leave it for the (future) Python adapter — `compile`
   will report it as `unsatisfied` until a backend provides it.
3. Render an example that uses it — a new operation that never ran is not done.
4. `opw_operations` and the agent map pick it up automatically.

## Conventions

- TypeScript, ESM, NodeNext resolution. Strict mode, `noUncheckedIndexedAccess`.
- Do **not** add a `Co-Authored-By` trailer. Commits here are authored by the committer alone.
- Docs of record: [docs/design-spec.md](docs/design-spec.md) (architecture),
  [docs/opw-spec.md](docs/opw-spec.md) (the format).
