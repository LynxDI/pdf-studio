# Security & trust model

Lynx PDF Studio treats a workflow (`*.opw.yaml`) as **potentially untrusted** —
it may be cloned from a repo, shared by a colleague, or authored by a coding
agent. The engine is built so that a crafted workflow cannot quietly reach
outside its own project. This document states exactly what is protected and what
is not, so you can make an informed decision before rendering a workflow you did
not write.

## What is protected

- **Path traversal.** Every input, `output.file`, asset, and extract/convert
  `to` path is confined to the workflow directory. `..`, absolute paths, Windows
  drive-relative (`C:x`) / drive-absolute (`C:\x`), and UNC (`\\host`) paths are
  rejected — both as a fail-fast `path_escape` validation error and at read/write
  time (`confinePath`). A workflow cannot read `~/.ssh/id_rsa` or write into a
  Startup folder or `.git/hooks`.
- **Environment secrets.** `${ENV_VAR}` substitution only applies to the password
  params (`password` / `user_password` / `owner_password`). A `${VAR}` in any
  other param — `text`, `title`, `url`, a path — is left literal, so a workflow
  cannot read arbitrary host environment variables into the output PDF or a URL.
- **Interpreter/binary pinning.** The Python backend is pinned to its absolute
  `sys.executable`, and `pdfStudio.pythonPath` is machine-scoped, so a workspace
  cannot point the interpreter at a planted binary. A system browser is resolved
  from its known install location before any name-based PATH lookup.
- **Webviews.** The preview, MCP, and Operations panels use a strict nonce CSP
  and load no remote resources.
- **Creator-op guards.** Markdown/HTML/…→PDF ops must run first with a matching
  input, so a working PDF can't be misinterpreted as source.
- **Page bounds.** Page numbers are validated as 1-based (≥ 1) for every op, so a
  `0`/negative index can't silently edit the wrong page.

## Residual risks (know these before rendering an untrusted workflow)

These follow from what the features intrinsically do; they are documented rather
than blocked.

- **`url_to_pdf` / `html_to_pdf` fetch network + local resources by design.**
  A workflow can name any `url`, and rendered HTML can reference remote images,
  stylesheets, or (via WeasyPrint) `file://` resources. This is an SSRF vector:
  rendering an untrusted workflow can cause outbound requests from your machine.
  Don't render untrusted URL/HTML workflows on a host with sensitive internal
  network access.
- **The headless browser runs with `--no-sandbox`.** High-fidelity Markdown/HTML
  rendering drives your system Chrome/Edge with `--no-sandbox` (needed to run
  headless in many environments) against workflow-controlled content. Treat
  rendering untrusted HTML like opening it in a browser.
- **Confinement is lexical, not physical.** Path checks operate on the path
  string; a **symlink** inside the workflow directory that points outside it can
  still redirect a read/write. Don't render untrusted workflows in a directory
  that contains symlinks to sensitive locations.
- **Sidecar cwd is the workflow directory (Windows).** The Python sidecar runs
  with its working directory set to the workflow folder so relative asset paths
  resolve. Tools resolved by bare name could, in principle, prefer a same-named
  executable in that folder; the browser is resolved by absolute path first to
  reduce this.

## Recommendation

The `.opw.yaml` is code. Review a workflow you didn't author before rendering it —
the same way you'd review a script — and be especially cautious with
`url_to_pdf` / `html_to_pdf` and with directories that contain symlinks.

To report a vulnerability, contact **info@lynxdi.com**.
