// Workflow variables — the `vars:` block and `${name}` interpolation.
//
// A workflow may declare scalar `vars` and reference them as `${name}` in
// operation params and output paths, so one file is a reusable TEMPLATE that a
// caller parameterizes at run time (runWorkflow's `vars` overrides win over the
// file's defaults). This is a resolve-time transform: parse → resolveVars →
// validate → optimize → compile → execute.
//
// SECURITY: vars are FILE-LOCAL scalars — resolveVars never reads the
// environment. That is deliberate: an untrusted/shared/agent-authored workflow
// must not be able to pull host env into a `text`/`url`/`title`/path param and
// exfiltrate it. The ONLY env-reading path is `substituteEnv` (execute.ts),
// scoped to the password sinks in {@link SECRET_PARAMS}. Precedence for a
// `${name}`: a declared var wins everywhere; otherwise, in a password param
// only, the environment; otherwise it stays literal.

import type { OpNode, Workflow } from "./model.js";

/** Params whose value may reference a secret via `${ENV_VAR}` at run time (see
 *  execute.ts `substituteEnv`). A `${name}` in one of these is left to the
 *  environment when it is not a declared var — so resolveVars must NOT flag such
 *  a reference as an undeclared variable. */
export const SECRET_PARAMS = new Set(["password", "user_password", "owner_password"]);

export type VarValue = string | number | boolean;

export interface ResolveResult {
  /** A new workflow with `${name}` resolved in op params + output paths. */
  workflow: Workflow;
  /** Names referenced via `${…}` in a NON-secret param that are not declared
   *  (left literal). The validator turns these into warnings when a `vars:`
   *  block is present. */
  undeclared: string[];
}

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const WHOLE_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

function isScalar(v: unknown): v is VarValue {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/**
 * Resolve `${name}` references from the workflow's `vars` (with optional runtime
 * `overrides`, which win) across operation params and `output.file`/`output.folder`.
 * Pure — returns a new workflow; the `vars` block itself is preserved for round-trip.
 *
 * A whole-value reference (`dpi: "${dpi}"`) keeps the variable's native TYPE, so a
 * numeric var stays a number and still passes numeric param validation. An embedded
 * reference (`"Page ${n}"`) is string-interpolated. Only scalar-valued vars
 * participate; a non-scalar declared var is ignored here (the validator flags it),
 * so a reference to one is treated as undeclared.
 */
export function resolveVars(wf: Workflow, overrides?: Record<string, VarValue>): ResolveResult {
  const vars: Record<string, VarValue> = {};
  for (const [k, v] of Object.entries(wf.vars ?? {})) if (isScalar(v)) vars[k] = v;
  if (overrides) for (const [k, v] of Object.entries(overrides)) if (isScalar(v)) vars[k] = v;

  const undeclared = new Set<string>();

  /** Substitute one string. `secret`: don't record undeclared (env handles it). */
  const subString = (s: string, secret: boolean): VarValue => {
    const whole = WHOLE_RE.exec(s);
    if (whole) {
      const name = whole[1]!;
      if (name in vars) return vars[name]!; // keep native type
      if (!secret) undeclared.add(name);
      return s; // literal
    }
    return s.replace(VAR_RE, (_m, name: string) => {
      if (name in vars) return String(vars[name]);
      if (!secret) undeclared.add(name);
      return `\${${name}}`; // leave literal
    });
  };

  const walk = (v: unknown, secret: boolean): unknown => {
    if (typeof v === "string") return subString(v, secret);
    if (Array.isArray(v)) return v.map((e) => walk(e, secret));
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = walk(val, secret);
      return o;
    }
    return v;
  };

  const operations: OpNode[] = wf.operations.map((op) => {
    const params: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(op.params)) params[k] = walk(val, SECRET_PARAMS.has(k));
    // `when` guards are evaluated against vars-as-identifiers, not ${…}-substituted,
    // so pass the expression through untouched (but preserve it).
    return { name: op.name, params, ...(op.when ? { when: op.when } : {}) };
  });

  let output = wf.output;
  if (output) {
    const o = { ...output };
    if (typeof o.file === "string") o.file = String(subString(o.file, false));
    if (typeof o.folder === "string") o.folder = String(subString(o.folder, false));
    output = o;
  }

  return {
    workflow: { ...wf, operations, ...(output ? { output } : {}) },
    undeclared: [...undeclared],
  };
}
