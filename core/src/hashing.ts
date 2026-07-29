// Content-addressable hashing for caching and cache keys.
//
// A workflow's output is a pure function of (schema version, kind, inputs
// bytes, the operation program). Hashing those yields a stable key we can use
// to skip re-rendering unchanged workflows. Deterministic across machines:
// same inputs → same key.

import { createHash } from "node:crypto";
import type { Workflow } from "./opw/model.js";
import { stableStringify } from "./opw/diff.js";

/** Hash arbitrary bytes to a hex sha256. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Compute a stable cache key for a workflow given the sha256 of each input
 * document (host computes those from disk). Independent of asset *paths* — only
 * the operation program and input content matter to the output bytes.
 */
export function workflowContentKey(wf: Workflow, inputHashes: string[]): string {
  const material = stableStringify({
    v: wf.version,
    kind: wf.kind,
    inputs: inputHashes,
    ops: wf.operations.map((o) => ({ [o.name]: o.params })),
  });
  return createHash("sha256").update(material).digest("hex");
}
