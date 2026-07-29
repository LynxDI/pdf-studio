// Guided, native-UI parameter entry for an OPW operation. Instead of making the
// user hand-type a raw YAML params object, we walk the operation's ParamSpec and
// prompt per field with the right control — a dropdown for enums, a validated
// number box (min/max), array/scalar boxes — then assemble a typed JS object and
// let core serialize it to a flow-style YAML params string. Required params are
// collected first; optional ones are chosen via a multi-select so long optional
// lists aren't a wall of prompts.
//
// Serialization (quoting) is delegated to core's serializeFlowParams (the YAML
// library), so a value that would otherwise resolve to a non-string — 0x10,
// .inf, true, null, ${ENV}, … — is quoted correctly and can't silently become a
// number/bool. The OPW file stays the source of truth: this is a discovery aid,
// not a replacement for editing the YAML directly.

import * as vscode from "vscode";
import { OPERATIONS, checkPageListSyntax, serializeFlowParams, parseFlowValue, type ParamSpec } from "@pdf-studio/core";

type Answer = { kind: "value"; value: unknown } | { kind: "skip" } | { kind: "cancel" };

/** Collect an operation's params via guided prompts → a flow-YAML string, or
 *  undefined if the user cancelled at any step. */
export async function collectParams(op: string): Promise<string | undefined> {
  const spec = OPERATIONS[op];
  if (!spec || spec.params.length === 0) return "{}";

  const required = spec.params.filter((p) => p.required);
  const optional = spec.params.filter((p) => !p.required);
  const params: Record<string, unknown> = {};

  for (const p of required) {
    const a = await promptParam(op, p, true);
    if (a.kind === "cancel") return undefined;
    if (a.kind === "value") params[p.name] = a.value;
  }

  if (optional.length > 0) {
    const picks = await vscode.window.showQuickPick(
      optional.map((p) => ({ label: p.name, description: typeHint(p), detail: p.description, p })),
      {
        title: `${op}: optional parameters`,
        placeHolder: "Select optional parameters to set — or press Enter to set none",
        canPickMany: true,
        ignoreFocusOut: true,
      },
    );
    if (picks === undefined) return undefined; // cancelled
    for (const item of picks) {
      const a = await promptParam(op, item.p, false);
      if (a.kind === "cancel") return undefined;
      if (a.kind === "value") params[item.p.name] = a.value;
    }
  }

  return serializeFlowParams(params);
}

/** A short "(type)" / "(a | b | c)" hint for the picker rows. */
function typeHint(p: ParamSpec): string {
  return `(${p.enum ? p.enum.join(" | ") : p.type})`;
}

/** Prompt for one parameter with a type-appropriate control. */
async function promptParam(op: string, p: ParamSpec, requiredParam: boolean): Promise<Answer> {
  const title = `${op} · ${p.name}${requiredParam ? " (required)" : ""}`;

  if (p.enum) {
    const skip = requiredParam ? [] : [{ label: "$(circle-slash) leave unset", value: undefined, skip: true }];
    const pick = await vscode.window.showQuickPick(
      [...p.enum.map((e) => ({ label: e, value: e, skip: false })), ...skip],
      { title, placeHolder: p.description, ignoreFocusOut: true },
    );
    if (pick === undefined) return { kind: "cancel" };
    return pick.skip ? { kind: "skip" } : { kind: "value", value: pick.value };
  }

  if (p.type === "boolean") {
    const skip = requiredParam ? [] : [{ label: "$(circle-slash) leave unset", value: undefined as boolean | undefined, skip: true }];
    const pick = await vscode.window.showQuickPick(
      [{ label: "true", value: true, skip: false }, { label: "false", value: false, skip: false }, ...skip],
      { title, placeHolder: p.description, ignoreFocusOut: true },
    );
    if (pick === undefined) return { kind: "cancel" };
    return pick.skip ? { kind: "skip" } : { kind: "value", value: pick.value };
  }

  // Text-entry types: number, number[], string[], string, object.
  const raw = await vscode.window.showInputBox({
    title,
    prompt: p.description,
    placeHolder: placeholderFor(p),
    ignoreFocusOut: true,
    validateInput: (v) => validateValue(v, p, requiredParam),
  });
  if (raw === undefined) return { kind: "cancel" };
  const s = raw.trim();
  if (s === "") return requiredParam ? { kind: "cancel" } : { kind: "skip" };
  return { kind: "value", value: toValue(s, p) };
}

/** A helpful placeholder for the input box, by parameter type. */
function placeholderFor(p: ParamSpec): string {
  switch (p.type) {
    case "number":
      return p.min != null || p.max != null ? `number${p.min != null ? ` ≥ ${p.min}` : ""}${p.max != null ? ` ≤ ${p.max}` : ""}` : "a number, e.g. 90";
    case "number[]":
      return "comma-separated, e.g. 1, 3, 5";
    case "pages":
      return "comma-separated pages or ranges, e.g. 1, 5-8, last";
    case "string[]":
      return "comma-separated, e.g. Alice, Bob";
    case "object":
      return "a { … } object or [ … ] array, e.g. { page: 1, object_name: Im0 }";
    default:
      return "a value";
  }
}

/** Per-field validation mirroring core's checkType, so bad input is caught in
 *  the box (not only after insertion). Returns an error string or undefined. */
function validateValue(raw: string, p: ParamSpec, requiredParam: boolean): string | undefined {
  const s = raw.trim();
  if (s === "") return requiredParam ? `"${p.name}" is required` : undefined;
  switch (p.type) {
    case "number": {
      const n = Number(s);
      if (!Number.isFinite(n)) return "must be a number";
      if (p.min !== undefined && n < p.min) return `must be ≥ ${p.min}`;
      if (p.max !== undefined && n > p.max) return `must be ≤ ${p.max}`;
      return undefined;
    }
    case "number[]": {
      const items = parseList(s);
      if (items.length === 0) return "enter one or more numbers, e.g. 1, 3, 5";
      if (!items.every((v) => Number.isFinite(Number(v)))) return "all values must be numbers";
      return undefined;
    }
    case "pages": {
      const items = toPageList(s);
      if (items.length === 0) return "enter one or more pages, e.g. 1, 5-8, last";
      // Same parser the validator uses, so the box rejects exactly what a render would.
      return checkPageListSyntax(items) ?? undefined;
    }
    case "string[]":
      return parseList(s).length === 0 ? "enter one or more values" : undefined;
    case "object": {
      if (!/^[{[]/.test(s)) return "enter a { … } object or [ … ] array";
      let parsed: unknown;
      try {
        parsed = parseFlowValue(s);
      } catch (e) {
        return `invalid: ${(e as Error).message.split("\n")[0]}`;
      }
      if (parsed === null || typeof parsed !== "object") return "must be an object or array";
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Convert validated user text into a typed JS value (core serializes it). */
function toValue(s: string, p: ParamSpec): unknown {
  switch (p.type) {
    case "number":
      return Number(s);
    case "number[]":
      return parseList(s).map(Number);
    case "pages":
      return toPageList(s);
    case "string[]":
      return parseList(s);
    case "object":
      return parseFlowValue(s);
    default:
      return s;
  }
}

/** "1, 5-8, last" → [1, "5-8", "last"]. Plain page numbers stay numbers so the
 *  common case serializes as `pages: [1, 3]`, not `pages: ["1", "3"]`; range
 *  tokens stay strings, which is what the page-list parser expects. */
function toPageList(s: string): (number | string)[] {
  return parseList(s).map((v) => (/^\d+$/.test(v) ? Number(v) : v));
}

/** Split "1, 3, 5" or "[1, 3, 5]" into trimmed, non-empty items. */
function parseList(s: string): string[] {
  return s
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}
