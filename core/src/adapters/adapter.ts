// The renderer-adapter seam — OPW's execution layer.
//
//     Workflow → Validator → Optimizer → Execution Plan → [Adapter] → backend
//
// An adapter advertises which document *kinds* and *capabilities* it can
// execute, and knows how to apply one plan step to a working document. The
// compiler binds each step to the best available adapter; the executor runs
// them in order. Swapping backends (pdf-lib ↔ PyMuPDF) is entirely an adapter
// concern — the workflow file never changes.

import type { DocumentKind } from "../opw/model.js";
import type { Capability } from "../opw/operations.js";
import type { PlanStep } from "../opw/compile.js";

/** A document artifact emitted alongside (or instead of) the main output. */
export interface EmittedArtifact {
  /** Path relative to the workflow file. */
  path: string;
  bytes: Uint8Array;
  kind: "pdf" | "text" | "image" | "json" | "csv";
}

/**
 * Mutable state threaded through a workflow run. Adapters read `inputs` /
 * `assets`, transform `current`, and push side outputs to `artifacts`.
 */
export interface ExecContext {
  kind: DocumentKind;
  /** Raw bytes of each input document, in workflow order. */
  inputs: Uint8Array[];
  /** Workflow-relative path of each input, parallel to {@link inputs}. Ops that report
   *  per-input results (extract_form → a row per form) need to name the file they read. */
  inputPaths: string[];
  /** Named assets resolved to bytes (images, fonts, stamps). */
  assets: Record<string, Uint8Array>;
  /** The working document. Null until the first op (usually merge/load) sets it. */
  current: Uint8Array | null;
  /** Side artifacts (split files, extracted text/images). */
  artifacts: EmittedArtifact[];
}

export interface AdapterResult {
  /** New working-document bytes, or null to leave `current` unchanged. */
  current?: Uint8Array | null;
  /** Artifacts produced by this step. */
  artifacts?: EmittedArtifact[];
  /** Human-readable note for logs / history (e.g. "merged 3 inputs → 42 pages"). */
  note?: string;
  /** A remote/chunked op returned a resumable partial (soft-deadline) — nothing was
   *  published; re-running the workflow continues from the persistent cache. */
  incomplete?: boolean;
}

/**
 * A backend that can execute some capabilities for some document kinds.
 * Implementations: {@link ../adapters/pdflib/index PdfLibAdapter} (bundled,
 * zero-install) and a future PythonAdapter (PyMuPDF/pikepdf/qpdf, opt-in).
 */
export interface RendererAdapter {
  /** Stable id, e.g. "pdf-lib", "python". */
  readonly id: string;
  /** Document kinds this adapter handles. */
  readonly kinds: readonly DocumentKind[];
  /** Capabilities this adapter can execute. */
  readonly capabilities: readonly Capability[];
  /**
   * Whether the adapter can run right now (bundled adapters return true;
   * sidecar adapters probe for their runtime/libraries). Cached by the registry.
   */
  isAvailable(): Promise<boolean>;
  /** Apply one plan step to the working document. */
  apply(ctx: ExecContext, step: PlanStep): Promise<AdapterResult>;
  /** Optionally read content-level document facts (e.g. `has_text`, `has_images`)
   *  used by `when:` guards. Only backends that can inspect content implement this
   *  (the Python sidecar); the bundled adapter computes its cheap facts in-engine. */
  inspect?(bytes: Uint8Array): Promise<Record<string, string | number | boolean>>;
}

/**
 * Registry of adapters, ordered by preference. `resolve` returns the first
 * available adapter that handles a (kind, capability) pair — so the bundled
 * pdf-lib adapter wins for structural ops, and an opt-in Python adapter picks
 * up OCR/redaction when installed.
 */
/** Capabilities whose sidecar (Python) implementation is richer than the bundled
 *  pdf-lib one and should win when the sidecar is available. */
const SIDECAR_PREFERRED = new Set<Capability>(["images_to_pdf"]);

export class AdapterRegistry {
  private readonly adapters: RendererAdapter[] = [];
  private readonly availability = new Map<string, boolean>();

  constructor(adapters: RendererAdapter[] = []) {
    this.adapters = [...adapters];
  }

  register(adapter: RendererAdapter): void {
    this.adapters.push(adapter);
    this.availability.delete(adapter.id);
  }

  all(): readonly RendererAdapter[] {
    return this.adapters;
  }

  /** Probe (and cache) availability of every registered adapter. */
  async refreshAvailability(): Promise<void> {
    await Promise.all(
      this.adapters.map(async (a) => {
        try {
          this.availability.set(a.id, await a.isAvailable());
        } catch {
          this.availability.set(a.id, false);
        }
      }),
    );
  }

  private isCachedAvailable(a: RendererAdapter): boolean {
    // Default to true when unprobed so pure/bundled adapters work without an
    // explicit refresh; call refreshAvailability() to gate sidecar adapters.
    return this.availability.get(a.id) ?? true;
  }

  /** The first available adapter that can run `capability` for `kind`. Normally the
   *  bundled pdf-lib adapter (registered first) wins, but a few capabilities have a
   *  richer sidecar implementation that supersedes it when the Python backend is
   *  available (images_to_pdf handles HEIC/WEBP/TIFF/SVG, not just PNG/JPEG) — for
   *  those, prefer the sidecar, and fall back to the bundled adapter when it's absent. */
  resolve(kind: DocumentKind, capability: Capability): RendererAdapter | undefined {
    const matches = this.adapters.filter(
      (a) => a.kinds.includes(kind) && a.capabilities.includes(capability) && this.isCachedAvailable(a),
    );
    if (SIDECAR_PREFERRED.has(capability)) {
      const py = matches.find((a) => a.id === "python");
      if (py) return py;
    }
    return matches[0];
  }

  /** Every capability satisfiable for `kind` by some available adapter. */
  capabilitiesFor(kind: DocumentKind): Set<Capability> {
    const caps = new Set<Capability>();
    for (const a of this.adapters) {
      if (!a.kinds.includes(kind) || !this.isCachedAvailable(a)) continue;
      for (const c of a.capabilities) caps.add(c);
    }
    return caps;
  }
}
