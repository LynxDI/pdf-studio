// resolveFormFill — turn friendly, record-scoped values into raw AcroForm field
// instructions for the sidecar. Pure and unit-tested; no filesystem (the adapter
// loads the records file/dir and passes the id→record map in).

import type { FormField, FormSchema, FillInstruction, FillResolution, ResolvedEntry } from "./types.js";

export type RecordMap = Record<string, Record<string, unknown>>;

export interface ResolveInput {
  values?: Record<string, unknown>;
  people?: RecordMap; // id → record
  person?: string; // primary record id (fills the form's first/primary role)
  roles?: Record<string, string>; // explicit role → record id (business, e.g. {patient:p1})
}

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function interpolate(template: string, roles: Record<string, unknown>): string {
  const out = template.replace(/\{([^}]+)\}/g, (_m, p) => {
    const v = getPath(roles, String(p).trim());
    return v == null ? "" : String(v);
  });
  return out.replace(/\s{2,}/g, " ").replace(/\s+,/g, ",").trim().replace(/[,\s]+$/, "");
}

function digitsOnly(v: string): string {
  return v.replace(/\D+/g, "");
}

function parseDate(v: string): { y: string; m: string; d: string } | null {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
  if (iso) return { y: iso[1]!, m: String(+iso[2]!).padStart(2, "0"), d: String(+iso[3]!).padStart(2, "0") };
  const us = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/.exec(v);
  if (us) return { y: us[3]!.padStart(4, "20"), m: String(+us[1]!).padStart(2, "0"), d: String(+us[2]!).padStart(2, "0") };
  return null;
}

/** Build the role → record map from the primary record's relations + explicit overrides. */
export function buildRoles(schema: FormSchema, people: RecordMap, person?: string, override?: Record<string, string>): Record<string, unknown> {
  const roles: Record<string, unknown> = {};
  const dependents: Array<Record<string, unknown>> = [];
  const primaryRole = schema.roles?.[0] ?? "applicant";
  const primary = person ? people[person] : undefined;
  if (primary) roles[primaryRole] = primary;
  const rel = (primary?.["relations"] as Record<string, unknown>) ?? {};
  const asId = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

  const spouseId = override?.["spouse"] ?? asId(rel["spouse"]);
  if (spouseId && people[spouseId]) roles["spouse"] = people[spouseId]!;

  const parents = (Array.isArray(rel["parents"]) ? (rel["parents"] as unknown[]) : []).map(asId);
  const p1 = override?.["parent1"] ?? parents[0];
  const p2 = override?.["parent2"] ?? parents[1];
  if (p1 && people[p1]) roles["parent1"] = people[p1]!;
  if (p2 && people[p2]) roles["parent2"] = people[p2]!;

  const depIds = (Array.isArray(rel["dependents"]) ? (rel["dependents"] as unknown[]) : []).map(asId);
  for (const id of depIds) if (id && people[id]) dependents.push(people[id]!);

  // Explicit role→id overrides win (business roles: patient, policy_holder, …).
  for (const [role, id] of Object.entries(override ?? {})) {
    if (typeof id === "string" && people[id]) roles[role] = people[id]!;
  }
  roles["dependents"] = dependents;
  return roles;
}

function scalarValue(field: FormField, roles: Record<string, unknown>, values: Record<string, unknown>): { value?: string; source: string } {
  if (values && Object.prototype.hasOwnProperty.call(values, field.key) && values[field.key] != null) {
    return { value: String(values[field.key]), source: "values" };
  }
  if (field.template) {
    const v = interpolate(field.template, roles);
    if (v) return { value: v, source: "template" };
  }
  if (field.from) {
    const v = getPath(roles, field.from);
    if (v != null && v !== "") return { value: String(v), source: field.from.split(".")[0]! };
  }
  if (field.default != null) return { value: field.default, source: "default" };
  return { source: "default" };
}

function matchOption(field: FormField, raw: string): { field: string; on: string } | null {
  const opts = field.options ?? {};
  const norm = String(raw).trim().toLowerCase();
  const bool = norm === "true" ? "yes" : norm === "false" ? "no" : norm;
  for (const [label, opt] of Object.entries(opts)) {
    if (label.toLowerCase() === norm || label.toLowerCase() === bool || opt.on.toLowerCase() === norm) {
      return { field: opt.field ?? field.field ?? "", on: opt.on };
    }
  }
  return null;
}

export function resolveFormFill(schema: FormSchema, input: ResolveInput): FillResolution {
  const values = (input.values ?? {}) as Record<string, unknown>;
  const people = input.people ?? {};
  const roles = buildRoles(schema, people, input.person, input.roles);
  const instructions: FillInstruction[] = [];
  const resolved: ResolvedEntry[] = [];
  const warnings: string[] = [];
  const unfilledRequired: string[] = [];

  const need = (field: FormField, has: boolean) => {
    if (!has && field.required) unfilledRequired.push(field.key);
  };

  for (const field of schema.fields) {
    if (field.type === "repeat") {
      const list = (roles[field.role ?? "dependents"] as Array<Record<string, unknown>>) ?? [];
      const max = field.max ?? list.length;
      for (const sub of field.fields_repeat ?? []) {
        for (let i = 0; i < Math.min(list.length, max); i++) {
          const target = sub.fields[i];
          if (!target) continue;
          const raw = getPath(list[i], sub.key);
          if (raw == null || raw === "") continue;
          const v = sub.digits ? digitsOnly(String(raw)) : String(raw);
          instructions.push({ name: target, value: v, kind: "text" });
          resolved.push({ key: `${field.key}[${i}].${sub.key}`, value: v, source: field.role ?? "dependents" });
        }
      }
      continue;
    }

    const { value, source } = scalarValue(field, roles, values);
    if (value == null) {
      need(field, false);
      continue;
    }

    if (field.type === "choice") {
      const m = matchOption(field, value);
      if (m && m.field) {
        instructions.push({ name: m.field, value: m.on, kind: "check" });
        resolved.push({ key: field.key, value, source });
      } else {
        warnings.push(`${field.key}: "${value}" is not a known option (${Object.keys(field.options ?? {}).join("/")})`);
        need(field, false);
      }
    } else if (field.type === "checkbox") {
      const on = field.on ?? "On";
      const truthy = !["", "no", "false", "off", "0"].includes(String(value).toLowerCase());
      instructions.push({ name: field.field ?? "", value: truthy ? on : "Off", kind: "check" });
      resolved.push({ key: field.key, value: truthy ? on : "Off", source });
    } else if (field.type === "dropdown") {
      if (field.choices && !field.choices.includes(value)) {
        warnings.push(`${field.key}: "${value}" is not an allowed value (${field.choices.join("/")})`);
      }
      instructions.push({ name: field.field ?? "", value, kind: "text", maxlen: field.maxlen });
      resolved.push({ key: field.key, value, source });
    } else if (field.type === "date") {
      const d = parseDate(value);
      if (!d) {
        warnings.push(`${field.key}: "${value}" is not a recognizable date (use YYYY-MM-DD)`);
        need(field, false);
        continue;
      }
      if (field.parts?.length) {
        // Split across separate month/day/year boxes.
        for (const part of field.parts) {
          const pv = part.part === "year" ? d.y : part.part === "day" ? d.d : d.m;
          instructions.push({ name: part.field, value: pv, kind: "text" });
        }
      } else if (field.field) {
        // A single field with a format mask, e.g. MMDDYYYY / MM/DD/YYYY.
        const fmt = field.format || "MM/DD/YYYY";
        const s = fmt.replace("YYYY", d.y).replace("YY", d.y.slice(2)).replace("MM", d.m).replace("DD", d.d);
        instructions.push({ name: field.field, value: s, kind: "text", maxlen: field.maxlen });
      }
      resolved.push({ key: field.key, value, source });
    } else if (field.type === "split") {
      const digits = digitsOnly(value);
      let pos = 0;
      for (const part of field.parts ?? []) {
        const take = part.take ?? digits.length - pos;
        instructions.push({ name: part.field, value: digits.slice(pos, pos + take), kind: "text" });
        pos += take;
      }
      resolved.push({ key: field.key, value, source });
    } else {
      // text
      const v = field.digits ? digitsOnly(value) : value;
      instructions.push({ name: field.field ?? "", value: v, kind: "text", maxlen: field.maxlen });
      resolved.push({ key: field.key, value: v, source });
    }
    need(field, true);
  }

  // Unknown explicit value keys (typos) → warn.
  const known = new Set(schema.fields.map((f) => f.key));
  for (const k of Object.keys(values)) {
    if (!known.has(k)) warnings.push(`unknown field key "${k}" for form ${schema.id} (ignored)`);
  }

  // Multi-copy forms (e.g. 1099-NEC: Copy A / 1 / B / 2) repeat the same layout; the fields
  // are mapped once (primary copy) and each `copies` entry is another copy expressed as
  // [find, replace] name substitutions. Fan every instruction out across the copies so one
  // value fills them all. Operates on the final instruction list, covering all field types.
  const copies = schema.copies;
  if (copies && copies.length) {
    const fanned = [...instructions];
    for (const ins of instructions) {
      for (const rules of copies) {
        let name = ins.name;
        let changed = false;
        for (const [find, repl] of rules) {
          if (name.includes(find)) { name = name.split(find).join(repl); changed = true; }
        }
        if (changed) fanned.push({ ...ins, name });
      }
    }
    return { instructions: fanned, resolved, warnings, unfilledRequired };
  }

  return { instructions, resolved, warnings, unfilledRequired };
}
