// Searching and filtering the Workflows tree.
//
// A project accumulates dozens of *.opw.yaml files, and what a user remembers is
// rarely the file name — it's "the one that watermarks", "the one that reads
// invoices/*.pdf", "the one that writes bundle.pdf". So a workflow is searchable
// by every one of those facets (path, operation, param value, input, output, var,
// and preserved unknown top-level keys like a hand-written `name:`), not just by
// its path. Queries are space-separated AND terms, case-insensitive substrings —
// `watermark invoice` finds the invoice workflow that watermarks.
//
// Pure module: NO vscode import, so it unit-tests under vitest.

import type { Workflow } from "@pdf-studio/core";

/** The subset of a `WorkflowFile` that searching needs (it satisfies this structurally). */
export interface SearchableWorkflow {
  /** Path relative to the workspace root, POSIX slashes. */
  relPath: string;
  /** Parsed workflow, or null when it failed to parse. */
  workflow: Workflow | null;
  /** Parse error message, when `workflow` is null. */
  parseError?: string;
}

/** The facets a query is matched against, in the order a match is reported. */
export interface WorkflowFacets {
  path: string;
  ops: string[];
  inputs: string[];
  outputs: string[];
  vars: string[];
  params: string[];
  /** Preserved unknown top-level keys (e.g. a hand-written `name:`) + parse errors. */
  notes: string[];
}

const FACET_LABEL: Record<Exclude<keyof WorkflowFacets, "path">, string> = {
  ops: "op",
  inputs: "input",
  outputs: "output",
  vars: "var",
  params: "param",
  notes: "note",
};

/** Cap on any single searchable value, so a huge param (embedded text/base64)
 *  can't blow up the haystack we build for every workflow on every keystroke. */
const MAX_VALUE = 160;

function clamp(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > MAX_VALUE ? `${one.slice(0, MAX_VALUE)}…` : one;
}

function valueText(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(valueText).filter(Boolean).join(",");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function uniq(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.length > 0))];
}

/** Everything a workflow can be found by. */
export function workflowFacets(wf: SearchableWorkflow): WorkflowFacets {
  const w = wf.workflow;
  const ops = w?.operations ?? [];
  return {
    path: wf.relPath,
    ops: uniq(ops.map((o) => o.name)),
    inputs: uniq(w?.inputs ?? []),
    outputs: uniq([w?.output?.file ?? "", w?.output?.folder ?? ""]),
    vars: uniq(Object.keys(w?.vars ?? {})),
    params: uniq(
      ops.flatMap((o) => [
        ...Object.entries(o.params).map(([k, v]) => clamp(`${k}: ${valueText(v)}`)),
        ...(o.when ? [clamp(`when: ${o.when}`)] : []),
      ]),
    ),
    notes: uniq([
      ...Object.entries(w?.extra ?? {}).map(([k, v]) => clamp(`${k}: ${valueText(v)}`)),
      ...(wf.parseError ? [clamp(wf.parseError)] : []),
    ]),
  };
}

/** Split a query into AND terms (empty array = match everything). */
export function queryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** One lower-cased blob of every facet — what terms are tested against. */
export function workflowSearchText(wf: SearchableWorkflow): string {
  const f = workflowFacets(wf);
  return [f.path, ...f.ops, ...f.inputs, ...f.outputs, ...f.vars, ...f.params, ...f.notes].join(" ").toLowerCase();
}

/** Does the workflow match every term in `query`? An empty query matches all. */
export function matchesWorkflow(wf: SearchableWorkflow, query: string): boolean {
  const terms = queryTerms(query);
  if (terms.length === 0) return true;
  const text = workflowSearchText(wf);
  return terms.every((t) => text.includes(t));
}

/** Why it matched — e.g. `op: watermark · input: invoices/*.pdf`. Undefined when
 *  the query only hit the path (the tree row already shows that). */
export function workflowMatchHint(wf: SearchableWorkflow, query: string): string | undefined {
  const terms = queryTerms(query);
  if (terms.length === 0) return undefined;
  const f = workflowFacets(wf);
  const hints: string[] = [];
  for (const term of terms) {
    if (f.path.toLowerCase().includes(term)) continue;
    for (const key of ["ops", "inputs", "outputs", "vars", "params", "notes"] as const) {
      const hit = f[key].find((v) => v.toLowerCase().includes(term));
      if (hit) {
        hints.push(`${FACET_LABEL[key]}: ${hit}`);
        break;
      }
    }
  }
  return hints.length ? uniq(hints).join(" · ") : undefined;
}

/** One-line summary used as the search picker's `detail` row — and, because the
 *  picker matches on it, the text that makes ops/inputs/outputs typeable. */
export function workflowSummary(wf: SearchableWorkflow): string {
  if (!wf.workflow) return wf.parseError ? `parse error — ${clamp(wf.parseError)}` : "unreadable";
  const f = workflowFacets(wf);
  const parts: string[] = [];
  const opCount = wf.workflow.operations.length;
  parts.push(opCount === 0 ? "no operations" : `${opCount} op${opCount === 1 ? "" : "s"}: ${f.ops.join(", ")}`);
  if (f.inputs.length) parts.push(`in: ${f.inputs.join(", ")}`);
  if (f.outputs.length) parts.push(`out: ${f.outputs.join(", ")}`);
  if (f.vars.length) parts.push(`vars: ${f.vars.join(", ")}`);
  return parts.join("  ·  ");
}
