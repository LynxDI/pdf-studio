// OPW optimization — the Optimizer stage of the compile pipeline.
//
//     Workflow → Validator → [Optimizer] → Execution Plan → Adapter → Output
//
// The optimizer rewrites a workflow into an equivalent one that renders faster
// or cleaner, without changing the output. It is intentionally conservative:
// every rewrite is behavior-preserving and reported, so a human (or the diff
// view) can see exactly what changed. This is the seam where, later, we fold
// adjacent page ops, drop redundant re-saves, or hoist a single compress to the
// end — the OPW analog of a compiler's peephole pass.

import type { OpNode, Workflow } from "./model.js";
import { lookupOperation } from "./operations.js";

/** Order-sensitive ops that "seal" the PDF (or must run at a fixed position):
 *  re-saving a compressed pass across them strips encryption, invalidates a
 *  signature/timestamp, or breaks fast-web-view / PDF-A conformance. The
 *  optimizer must not move `compress` past any of these. */
const SEAL_OPS = new Set(["encrypt", "decrypt", "sign", "timestamp", "linearize", "set_permissions", "pdf_to_pdfa"]);

export interface Rewrite {
  code: string;
  message: string;
}

export interface OptimizeResult {
  workflow: Workflow;
  rewrites: Rewrite[];
}

/**
 * Return an optimized copy of `wf` plus the list of rewrites applied. When no
 * rewrite fires, the returned workflow is structurally identical.
 *
 * Current passes (all behavior-preserving):
 *  - drop_no_op_merge: `merge` with a single input does nothing.
 *  - coalesce_metadata: multiple `set_metadata` ops merge into the last one
 *    (later keys win), since metadata is last-write-wins anyway.
 *  - single_compress_last: keep only the final `compress` (earlier ones are
 *    overwritten by re-encoding) and move it to the end of the program.
 */
export function optimizeWorkflow(wf: Workflow): OptimizeResult {
  const rewrites: Rewrite[] = [];
  let ops: OpNode[] = wf.operations.map((o) => ({
    name: o.name,
    params: { ...o.params },
    ...(o.when ? { when: o.when } : {}),
  }));

  // Every pass below matches ops by identity, never by the authored spelling — an
  // alias (`interleave` = merge, `metadata` = set_metadata) must optimize exactly
  // like its canonical name, or the same workflow behaves differently depending on
  // which word the author typed.
  const canon = (o: OpNode): string => lookupOperation(o.name)?.name ?? o.name;

  // Pass 1: drop no-op merge (0 or 1 input). A glob input (docs/*.pdf) is a SINGLE literal
  // entry that expands to many files at run time, so it is NOT a no-op merge — skip the drop.
  const hasGlobInput = wf.inputs.some((i) => /[*?]/.test(i));
  if (wf.inputs.length <= 1 && !hasGlobInput) {
    const before = ops.length;
    // Registry lookup, not a name compare: `interleave` IS merge, and with one
    // input there is nothing to alternate either.
    ops = ops.filter((o) => canon(o) !== "merge");
    if (ops.length !== before) {
      rewrites.push({
        code: "drop_no_op_merge",
        message: `removed ${before - ops.length} no-op merge (only ${wf.inputs.length} input)`,
      });
    }
  }

  // Pass 2: coalesce consecutive-or-not set_metadata into one (last wins). A
  // conditional (`when:`) set_metadata runs only sometimes, so it can't be merged
  // with unconditional ones — leave every set_metadata in place if any is guarded.
  const anyGuardedMeta = ops.some((o) => canon(o) === "set_metadata" && o.when);
  const metaIdx = ops.map((o, i) => (canon(o) === "set_metadata" ? i : -1)).filter((i) => i >= 0);
  if (metaIdx.length > 1 && !anyGuardedMeta) {
    const merged: Record<string, unknown> = {};
    for (const i of metaIdx) Object.assign(merged, ops[i]!.params);
    const lastMeta = metaIdx[metaIdx.length - 1]!;
    const drop = new Set(metaIdx.slice(0, -1));
    ops = ops
      // Keep the surviving node's authored spelling (`metadata:` stays `metadata:`).
      .map((o, i) => (i === lastMeta ? { name: o.name, params: merged } : o))
      .filter((_, i) => !drop.has(i));
    rewrites.push({
      code: "coalesce_metadata",
      message: `merged ${metaIdx.length} set_metadata ops into one`,
    });
  }

  // Pass 3: keep only the last compress, moved to the end — BUT only when no
  // order-sensitive "seal/terminal" op is present. Re-saving after encrypt /
  // sign / linearize / set_permissions / pdf_to_pdfa (or before decrypt) would
  // strip encryption, invalidate a signature, or break PDF/A — so moving compress
  // across any of these is NOT behavior-preserving. When one is present we leave
  // every compress exactly where the author put it (conservative = correct).
  const compressIdx = ops.map((o, i) => (canon(o) === "compress" ? i : -1)).filter((i) => i >= 0);
  const hasSealOp = ops.some((o) => SEAL_OPS.has(canon(o)));
  // A conditional compress can't be moved/collapsed (it might not run) — leave all in place.
  const anyGuardedCompress = ops.some((o) => canon(o) === "compress" && o.when);
  // An op that EMITS ITS OWN FILES (split, split_invoices, …) is a barrier too. Those files
  // are the real output; the working document afterwards is discarded. Hoisting compress
  // past one would silently turn "compress, then split into 5 MB parts" into "split into
  // parts, then compress a document nobody keeps" — the parts come out uncompressed. That
  // is a behaviour change, which this pass is not allowed to make.
  const hasEmitter = ops.some((o) => {
    const s = lookupOperation(canon(o));
    return s?.emitsFiles === true || s?.artifactsAreTheOutput === true;
  });
  if (compressIdx.length >= 1 && !hasSealOp && !anyGuardedCompress && !hasEmitter) {
    const last = compressIdx[compressIdx.length - 1]!;
    const compressOp = ops[last]!;
    const withoutCompress = ops.filter((o) => canon(o) !== "compress");
    const isAlreadyLastAndSingle =
      compressIdx.length === 1 && last === ops.length - 1;
    if (!isAlreadyLastAndSingle) {
      ops = [...withoutCompress, compressOp];
      rewrites.push({
        code: "single_compress_last",
        message:
          compressIdx.length > 1
            ? `collapsed ${compressIdx.length} compress ops into one at the end`
            : "moved compress to the end of the program",
      });
    }
  }

  const workflow: Workflow = { ...wf, operations: ops };
  return { workflow, rewrites };
}
