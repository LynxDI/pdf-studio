// OPW diff — structural comparison of two workflows.
//
// Powers the `opw.diff` MCP tool and the extension's history/diff view. Because
// OPW is the source of truth, a semantic diff of two workflow revisions is far
// more meaningful than a byte diff of the rendered PDFs — it says *what changed*
// ("added watermark", "reordered pages") rather than "12KB of binary differ".

import type { OpNode, Workflow } from "./model.js";

export type ChangeKind = "added" | "removed" | "changed";

export interface WorkflowChange {
  kind: ChangeKind;
  /** Dotted path, e.g. "operations[2]", "output.file", "inputs". */
  path: string;
  before?: unknown;
  after?: unknown;
  message: string;
}

/** Compute a semantic diff from `a` (before) to `b` (after). */
export function diffWorkflows(a: Workflow, b: Workflow): WorkflowChange[] {
  const changes: WorkflowChange[] = [];

  if (a.kind !== b.kind) {
    changes.push({ kind: "changed", path: "kind", before: a.kind, after: b.kind, message: `kind: ${a.kind} → ${b.kind}` });
  }
  if (JSON.stringify(a.inputs) !== JSON.stringify(b.inputs)) {
    changes.push({ kind: "changed", path: "inputs", before: a.inputs, after: b.inputs, message: "inputs changed" });
  }
  const aOut = a.output?.file ?? a.output?.folder ?? "";
  const bOut = b.output?.file ?? b.output?.folder ?? "";
  if (aOut !== bOut) {
    changes.push({
      kind: "changed",
      path: a.output?.folder || b.output?.folder ? "output.folder" : "output.file",
      before: aOut,
      after: bOut,
      message: `output: ${aOut || "(none)"} → ${bOut || "(none)"}`,
    });
  }

  diffOps(a.operations, b.operations, changes);
  return changes;
}

/**
 * Diff two operation lists using a simple longest-common-subsequence-free
 * heuristic: match by (name + JSON params) identity, then report the rest as
 * add/remove/change positionally. Good enough for typical single-op edits and
 * deterministic for tests.
 */
function diffOps(a: OpNode[], b: OpNode[], changes: WorkflowChange[]): void {
  const key = (o: OpNode) => `${o.name}:${stableStringify(o.params)}`;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const oa = a[i];
    const ob = b[i];
    if (oa && ob) {
      if (key(oa) !== key(ob)) {
        changes.push({
          kind: "changed",
          path: `operations[${i}]`,
          before: { [oa.name]: oa.params },
          after: { [ob.name]: ob.params },
          message: `op #${i + 1}: ${oa.name} → ${ob.name}`,
        });
      }
    } else if (ob) {
      changes.push({
        kind: "added",
        path: `operations[${i}]`,
        after: { [ob.name]: ob.params },
        message: `added op #${i + 1}: ${ob.name}`,
      });
    } else if (oa) {
      changes.push({
        kind: "removed",
        path: `operations[${i}]`,
        before: { [oa.name]: oa.params },
        message: `removed op #${i + 1}: ${oa.name}`,
      });
    }
  }
}

/** Deterministic JSON (sorted keys) so params compare structurally. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}
