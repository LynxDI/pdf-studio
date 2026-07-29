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
  Startup folder.
- **Protected directories inside the project.** Confinement is a boundary, and
  says nothing about what lives inside it — a workflow is often rendered at the
  root of a repository, which puts `.git/` on the *near* side of that boundary.
  `.git/hooks/pre-commit` needs no traversal to reach; it is an ordinary relative
  path, and it is executed by the next commit. So writes into `.git`, `.hg`,
  `.svn`, `.vscode`, `.github` and `.lynx-pdf-studio` are refused separately,
  reported as `path_protected_dir` and enforced again on the resolved path at
  write time (so `output/../.git/hooks/x` is caught too).
- **Environment secrets.** `${ENV_VAR}` substitution only applies to the password
  params (`password` / `user_password` / `owner_password`). A `${VAR}` in any
  other param — `text`, `title`, `url`, a path — is left literal, so a workflow
  cannot read arbitrary host environment variables into the output PDF or a URL.
  One exception is worth naming: with `pdfStudio.allowRemoteRender` enabled,
  `extract_receipt`/`extract_markdown` accept a workflow-supplied `endpoint`, and
  your configured `$PDFSTUDIO_VLM_API_KEY` / `$NVIDIA_API_KEY` is sent to it as a
  bearer token. With the setting off (the default) the op does not run at all.
- **Request forgery (`url_to_pdf`).** The target is resolved before any engine
  fetches it, and an address on this machine or a private network — loopback,
  link-local (including `169.254.169.254`, the cloud metadata endpoint), RFC1918,
  reserved — is refused, redirects included. Rendering *public* pages is the op's
  purpose and is unaffected; intranet rendering requires
  `pdfStudio.allowRemoteRender`.
- **Interpreter/binary pinning.** The Python backend is pinned to its absolute
  `sys.executable`, and `pdfStudio.pythonPath` is machine-scoped, so a workspace
  cannot point the interpreter at a planted binary. A system browser is resolved
  from its known install location before any name-based PATH lookup.
- **Machine-scoped policy.** The settings that grant capability —
  `pdfStudio.pythonPath`, `paddlePythonPath`, `vlmEndpoint`, `allowRemoteRender`,
  `allowAiRequests`, `examplesUrl` — are all machine-scoped, so a repository's
  `.vscode/settings.json` cannot turn them on for you. For the same reason, HTML
  sanitizing cannot be disabled by a workflow param alone: `sanitize: false` is
  honoured only when remote render is enabled, because otherwise the author of
  the untrusted HTML would also be the one waiving the defence.
- **Untrusted workspaces.** The extension declares no untrusted-workspace
  support, so VS Code disables it entirely in Restricted Mode. Merely *opening* a
  folder cannot render anything; you have to trust the folder first.
- **Webviews.** All three webviews — the PDF preview, the Operations panel and
  the operation-doc view — set `default-src 'none'` with a per-load 128-bit
  script nonce, and load no remote resources. (Inline *styles* are allowed, and
  the preview additionally permits `wasm-unsafe-eval` plus `blob:`/`data:` images
  and workers, which pdf.js requires.)
- **Creator-op guards.** Markdown/HTML/…→PDF ops must run first — enforced as an
  error — so a working PDF can't be misinterpreted as source. A *mismatched*
  input is reported as a warning and does not block the render.
- **Page bounds.** Page numbers are validated as 1-based (≥ 1) for every op, so a
  `0`/negative index can't silently edit the wrong page.

## Residual risks (know these before rendering an untrusted workflow)

These follow from what the features intrinsically do; they are documented rather
than blocked.

- **`url_to_pdf` / `html_to_pdf` still reach the public network by design.**
  Internal addresses are blocked (above), but a workflow can name any *public*
  `url`, and rendered HTML can reference remote images, stylesheets, or (via
  WeasyPrint) `file://` resources. Rendering an untrusted workflow can therefore
  cause outbound requests from your machine — including ones that merely signal
  that you rendered it.
- **DNS rebinding is not defeated.** The `url_to_pdf` guard resolves the name,
  then the engine resolves it again to fetch. A hostile DNS entry that answers
  differently between those two moments can still reach an internal address.
  Pinning the resolved address is not possible across Chrome, WeasyPrint and
  urllib alike.
- **The headless browser keeps its sandbox, but can fall back.** Markdown/HTML
  rendering drives your system Chrome/Edge with the sandbox **on**; `--no-sandbox`
  is used only on a retry, and only when Chrome itself reported that the sandbox
  could not start (common as root, in containers and in CI). Treat rendering
  untrusted HTML roughly like opening it in a browser.
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
