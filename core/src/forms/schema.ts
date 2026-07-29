// Runtime validator for form packs — enforced by the coverage test so every pack
// (hand-authored or harvested) is structurally sound and its targets are real.

import type { FormField, FormSchema } from "./types.js";
import { isVocabKey } from "./vocab.js";

/** Every real AcroForm field name a field writes to. */
export function fieldTargets(f: FormField): string[] {
  const out: string[] = [];
  if (f.field) out.push(f.field);
  for (const o of Object.values(f.options ?? {})) if (o.field) out.push(o.field);
  for (const p of f.parts ?? []) out.push(p.field);
  for (const sub of f.fields_repeat ?? []) out.push(...sub.fields);
  return out;
}

/** The record-key (post-role) portion of a `from` binding, or null. */
function recordKey(from?: string): string | null {
  if (!from) return null;
  const dot = from.indexOf(".");
  return dot < 0 ? from : from.slice(dot + 1);
}

export function validatePack(pack: FormSchema): string[] {
  const problems: string[] = [];
  for (const req of ["id", "title", "category", "source", "fields"] as const) {
    if (!(pack as unknown as Record<string, unknown>)[req]) problems.push(`missing "${req}"`);
  }
  if (!pack.source?.fields?.length) return problems.concat("source.fields is empty (re-harvest the blank PDF)");
  const sourceNames = new Set(pack.source.fields.map((f) => f.name));

  for (const f of pack.fields ?? []) {
    const where = `field "${f.key || "(no key)"}"`;
    if (!f.key) problems.push(`${where}: missing key`);
    if (!f.label) problems.push(`${where}: missing label`);
    if (!f.type) problems.push(`${where}: missing type`);
    for (const t of fieldTargets(f)) {
      if (!sourceNames.has(t)) problems.push(`${where}: target "${t}" not in source.fields (typo or wrong revision?)`);
    }
    const rk = recordKey(f.from);
    if (rk && !isVocabKey(rk)) problems.push(`${where}: from-key "${rk}" is not a canonical vocab key`);
    for (const sub of f.fields_repeat ?? []) {
      if (!isVocabKey(sub.key)) problems.push(`${where}: repeat sub-key "${sub.key}" is not a canonical vocab key`);
    }
    if (f.type === "choice" && !f.options) problems.push(`${where}: choice needs options`);
  }
  return problems;
}
