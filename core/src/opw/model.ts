// OpenPDF Workflow (OPW) — the data model.
//
// OPW is NOT a PDF format. It is an open, deterministic *workflow* layer that
// sits above content documents (PDF today; PPTX / DOCX / SVG / images / video
// tomorrow) and below the execution engines that render them:
//
//     Content layer   →  PDF, (later) PPTX, DOCX, SVG, images, video
//     Workflow layer   →  OPW              ← this file
//     Execution layer  →  pdf-lib / PyMuPDF / pikepdf / qpdf / Ghostscript
//
// A Workflow describes *how to transform* one or more input documents into an
// output document. The renderer applies it deterministically. The document is
// a build artifact; the OPW file is the source of truth.

/** OPW schema version understood by this build. */
export const OPW_VERSION = 1 as const;

/**
 * The content domain a workflow targets. `"pdf"` is the only kind wired today,
 * but the DSL is deliberately not PDF-specific — a future `"pptx"` / `"svg"` /
 * `"video"` kind dispatches to a different backend without changing the schema.
 * Typed as an open string union so unknown kinds parse (and validate to a
 * diagnostic) rather than failing to load.
 */
export type DocumentKind = "pdf" | (string & {});

/**
 * A single authored operation. In the OPW file this is a single-key object,
 * e.g. `- delete_pages: { pages: [10, 11] }`. We normalize it to `{ name,
 * params }` internally so the compiler and validator can treat every op
 * uniformly, and re-emit the single-key form on serialize.
 */
export interface OpNode {
  /** The operation keyword, e.g. `merge`, `rotate_pages`, `watermark`. */
  name: string;
  /** Operation parameters. `{}` when the op takes none (e.g. `merge`). */
  params: Record<string, unknown>;
  /** Optional guard: a predicate over document facts + vars (e.g.
   *  `"pages > 20 && encrypted == false"`). The op runs only when it evaluates
   *  true; facts are a per-input snapshot taken at run start. See `when.ts`. */
  when?: string;
}

/** Where the rendered artifact is written. */
export interface OutputSpec {
  /** Single output file, relative to the workflow file (for workflows that render
   *  ONE document). Mutually alternative with {@link folder}. */
  file?: string;
  /** Output DIRECTORY, relative to the workflow file. For workflows whose
   *  operations emit multiple files (e.g. split_invoices → one PDF per invoice):
   *  every emitted file is written here. When set, no single-PDF passthrough is
   *  produced. */
  folder?: string;
  /** Unknown fields preserved on round-trip. */
  [key: string]: unknown;
}

/**
 * A parsed OPW workflow. Unknown top-level keys are preserved — byte fidelity
 * for anything we don't recognise — so forward-compatible extensions survive an
 * edit-save cycle by a client that doesn't understand them.
 */
export interface Workflow {
  /** Schema version. Must equal {@link OPW_VERSION} today. */
  version: number;
  /** Target content domain. Defaults to `"pdf"` when omitted in the file. */
  kind: DocumentKind;
  /** Ordered input documents, relative paths to the workflow file. */
  inputs: string[];
  /** Named assets (images, fonts, stamps) referenced by operations. */
  assets?: Record<string, string>;
  /** Declared workflow variables — scalar values referenced with `${name}` in
   *  operation params and output paths, so one workflow is a reusable template.
   *  File-local (never read from the environment) and overridable at run time.
   *  See {@link resolveVars}. */
  vars?: Record<string, string | number | boolean>;
  /** The transformation program, applied in order. */
  operations: OpNode[];
  /** Output target. Optional: a workflow whose operations emit their own files
   *  (e.g. split_invoices → a directory) needs no single `output.file`. */
  output?: OutputSpec;
  /** Preserved unknown top-level fields. */
  extra?: Record<string, unknown>;
}
