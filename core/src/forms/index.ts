// @pdf-studio/core forms surface — the form-pack registry + resolver + record store.
// Registry is code-generated from packs/*.json; packs/index.generated.ts is committed.

import type { FormSchema } from "./types.js";
import { FORM_SCHEMAS } from "./packs/index.generated.js";

export * from "./types.js";
export { resolveFormFill, buildRoles } from "./resolve.js";
export type { ResolveInput, RecordMap } from "./resolve.js";
export { blankPeople, VOCAB, isVocabKey, RELATIONS } from "./vocab.js";
export { validatePack, fieldTargets } from "./schema.js";
export { extractFormValues, detectForm, toTable, toCsv, groupByForm } from "./extract.js";
export { csvToRecords, parseCsv, headerToKey } from "./csv-records.js";
export type { CsvRecordsOptions } from "./csv-records.js";
export type { RawField, ExtractedForm, FormMatch } from "./extract.js";
export { renderFormDoc, formFillExampleYaml } from "./form-render.js";
export { FORM_SCHEMAS };

/** Resolve a form by id ("ds11") or pinned revision ("f1040@2024"). */
export function getFormSchema(id: string): FormSchema | undefined {
  return FORM_SCHEMAS[id] ?? FORM_SCHEMAS[id.split("@")[0] ?? id];
}

/** All forms, deduped by id, sorted by category then title. */
export function listForms(): FormSchema[] {
  const seen = new Map<string, FormSchema>();
  for (const s of Object.values(FORM_SCHEMAS)) if (!seen.has(s.id)) seen.set(s.id, s);
  return [...seen.values()].sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
}

export interface FormCategory {
  title: string;
  forms: FormSchema[];
}

/** Forms grouped by category (for the PDF Fill catalog + form_list). */
export function formCategories(): FormCategory[] {
  const by = new Map<string, FormSchema[]>();
  for (const s of listForms()) {
    if (!by.has(s.category)) by.set(s.category, []);
    by.get(s.category)!.push(s);
  }
  return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([title, forms]) => ({ title, forms }));
}
