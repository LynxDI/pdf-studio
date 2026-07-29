// OPW compilation — the Execution Plan stage.
//
//     Workflow → Validator → Optimizer → [Compile] → Execution Plan → Adapter
//
// Compilation turns a (validated, optimized) workflow into an ordered list of
// PlanSteps, each bound to the adapter that will execute it. Capabilities no
// available adapter can satisfy are surfaced as `unsatisfied` entries — a
// planning result ("install PyMuPDF to enable OCR"), never a runtime surprise.
//
// The plan is deterministic and side-effect-free: the same workflow + registry
// yields the same plan, which is why it can be previewed, diffed, and hashed.

import type { DocumentKind, Workflow } from "./model.js";
import { lookupOperation, effectiveParams, creatorForExtension, type Capability } from "./operations.js";
import { resolveVars } from "./vars.js";
import type { AdapterRegistry } from "../adapters/adapter.js";

export interface PlanStep {
  /** 0-based position in the plan. */
  index: number;
  /** Canonical operation name. */
  op: string;
  /** Capability this step exercises. */
  capability: Capability;
  /** Operation parameters (already validated). */
  params: Record<string, unknown>;
  /** Id of the adapter bound to run this step, or null if unsatisfied. */
  adapter: string | null;
  /** Optional guard expression — the executor runs this step only when it is
   *  truthy against the per-input fact/var snapshot (see when.ts). */
  when?: string;
}

export interface UnsatisfiedStep {
  index: number;
  op: string;
  capability: Capability;
  reason: string;
}

export interface ExecutionPlan {
  kind: DocumentKind;
  inputs: string[];
  output: string;
  steps: PlanStep[];
  /** Steps whose capability no available adapter provides. */
  unsatisfied: UnsatisfiedStep[];
}

export interface CompileOptions {
  registry: AdapterRegistry;
}

/**
 * Compile a workflow into an {@link ExecutionPlan}. Assumes the workflow has
 * already passed {@link ../opw/validate.validateWorkflow} (unknown ops are
 * skipped defensively but should have been caught upstream).
 */
export function compileWorkflow(wf: Workflow, opts: CompileOptions): ExecutionPlan {
  const { registry } = opts;
  // Resolve `${var}` so plan steps carry concrete params (idempotent when the
  // caller — e.g. runWorkflow — already resolved with runtime overrides).
  wf = resolveVars(wf).workflow;
  const steps: PlanStep[] = [];
  const unsatisfied: UnsatisfiedStep[] = [];

  wf.operations.forEach((op, i) => {
    const spec = lookupOperation(op.name);
    if (!spec) return; // validation already flagged unknown ops
    const adapter = registry.resolve(wf.kind, spec.capability);
    const step: PlanStep = {
      index: steps.length,
      op: spec.name,
      capability: spec.capability,
      // An alias keyword may imply params (`interleave` → merge's interleave flag).
      // Fold them in here: `op` is canonical from this point on, so this is the last
      // place the authored spelling is still known.
      params: effectiveParams(spec, op.name, op.params),
      adapter: adapter ? adapter.id : null,
      ...(op.when ? { when: op.when } : {}),
    };
    steps.push(step);
    if (!adapter) {
      unsatisfied.push({
        index: step.index,
        op: spec.name,
        capability: spec.capability,
        reason: `no available adapter provides capability "${spec.capability}" for kind "${wf.kind}"`,
      });
    }
  });

  // `merge` converts non-PDF inputs on the fly (Word, images, …). That conversion is
  // implied by the INPUTS rather than written as a step, so it would otherwise be invisible
  // here and fail mid-render on a machine without LibreOffice. Surface it now, while the
  // answer is still "install a backend" rather than "your render died half way".
  // Globs aren't expanded at compile time, so a glob input can't be inspected.
  const mergeStep = steps.find((s) => s.op === "merge");
  if (mergeStep && mergeStep.params["convert"] !== false) {
    const seen = new Set<Capability>();
    for (const input of wf.inputs) {
      if (typeof input !== "string" || /[*?]/.test(input)) continue;
      const ext = input.slice(input.lastIndexOf(".")).toLowerCase();
      if (!ext || ext === ".pdf") continue;
      const creator = creatorForExtension(ext);
      if (!creator || seen.has(creator.capability)) continue;
      if (registry.resolve(wf.kind, creator.capability)) continue;
      seen.add(creator.capability);
      unsatisfied.push({
        index: mergeStep.index,
        op: creator.name,
        capability: creator.capability,
        reason:
          `merge must convert "${input}" to PDF first, but no available adapter provides ` +
          `capability "${creator.capability}" for kind "${wf.kind}"`,
      });
    }
  }

  return {
    kind: wf.kind,
    inputs: [...wf.inputs],
    output: wf.output?.file ?? wf.output?.folder ?? "",
    steps,
    unsatisfied,
  };
}

/** Render a plan as a compact, human-readable preview (for MCP / logs). */
export function describePlan(plan: ExecutionPlan): string {
  const lines: string[] = [];
  lines.push(`# Execution plan (${plan.kind})`);
  lines.push(`inputs: ${plan.inputs.join(", ") || "(none)"}`);
  lines.push(`output: ${plan.output || "(none)"}`);
  lines.push("");
  if (plan.steps.length === 0) {
    lines.push("(no operations — output equals input)");
  }
  for (const s of plan.steps) {
    const badge = s.adapter ? `[${s.adapter}]` : "[UNSATISFIED]";
    const params = Object.keys(s.params).length ? ` ${JSON.stringify(s.params)}` : "";
    lines.push(`${String(s.index + 1).padStart(2)}. ${badge} ${s.op}${params}`);
  }
  if (plan.unsatisfied.length) {
    lines.push("");
    lines.push("## Unsatisfied capabilities");
    for (const u of plan.unsatisfied) lines.push(`- ${u.op}: ${u.reason}`);
  }
  return lines.join("\n");
}
