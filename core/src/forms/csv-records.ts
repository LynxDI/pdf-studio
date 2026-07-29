// A spreadsheet as a records store.
//
// `people.yaml` is right for a household — a handful of people you hand-edit. A business has
// a CSV: a vendor list, a staff export, a client table, usually straight out of a system that
// already holds the data. Asking someone to retype 400 vendors into YAML to fill a W-9 is a
// non-starter, so `records:` accepts a .csv directly.
//
// The model doesn't change: one row is one record, `person:` picks which row, and it's still
// one workflow per form. Only the door widens.

/** Parse RFC 4180 CSV — quoted fields, embedded commas/newlines, "" escapes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  // Strip a UTF-8 BOM: Excel writes one, and it would otherwise become part of the first
  // header — silently turning `id` into `﻿id` and making every lookup miss.
  const s = text.replace(/^﻿/, "");

  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

/** Header cell → a record key. Tolerates the way humans title spreadsheet columns:
 *  "First Name" / "first-name" / "FIRST_NAME" all reach `first_name`, which is what the form
 *  packs bind to.
 *
 *  A DOT is kept, because it means something: `address.city` nests (see csvToRecords), which
 *  is how a flat sheet carries the address/relations blocks the packs expect. Everything else
 *  non-alphanumeric collapses to `_`. */
export function headerToKey(h: string): string {
  return h
    .trim()
    .replace(/﻿/g, "")
    .replace(/[\s\-]+/g, "_")
    .replace(/[^A-Za-z0-9_.]/g, "")
    .replace(/_+/g, "_")
    .replace(/^[_.]+|[_.]+$/g, "")
    .toLowerCase();
}

export interface CsvRecordsOptions {
  /** Column to use as each record's id. Default: the first of id/person_id/key/ref/email,
   *  else the first column. */
  idColumn?: string;
}

/**
 * A CSV → the same RecordMap shape `people.yaml` produces.
 *
 * Dotted headers nest, so a sheet can carry the address block the packs expect:
 * `address.city` → `{ address: { city } }`.
 */
export function csvToRecords(text: string, opts: CsvRecordsOptions = {}): Record<string, Record<string, unknown>> {
  const rows = parseCsv(text);
  if (!rows.length) return {};
  const headers = rows[0]!.map(headerToKey);

  const idIdx = (() => {
    if (opts.idColumn) {
      const want = headerToKey(opts.idColumn);
      const i = headers.indexOf(want);
      if (i >= 0) return i;
    }
    for (const cand of ["id", "person_id", "record_id", "key", "ref", "email"]) {
      const i = headers.indexOf(cand);
      if (i >= 0) return i;
    }
    return 0; // no obvious id column — the first column names the row
  })();

  const out: Record<string, Record<string, unknown>> = {};
  const used = new Set<string>();
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]!;
    const rec: Record<string, unknown> = {};
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c];
      const val = (cells[c] ?? "").trim();
      if (!key || val === "") continue;
      // `address.city` → { address: { city } } — packs bind to nested address/relations.
      if (key.includes(".")) {
        const parts = key.split(".");
        let node = rec;
        for (let p = 0; p < parts.length - 1; p++) {
          const seg = parts[p]!;
          if (typeof node[seg] !== "object" || node[seg] === null) node[seg] = {};
          node = node[seg] as Record<string, unknown>;
        }
        node[parts[parts.length - 1]!] = val;
      } else rec[key] = val;
    }
    if (!Object.keys(rec).length) continue;

    // The id must be unique or rows would silently overwrite each other — the one failure
    // that loses data without a trace. Suffix a duplicate rather than drop it.
    let id = (cells[idIdx] ?? "").trim() || `row_${r}`;
    if (used.has(id)) {
      let n = 2;
      while (used.has(`${id}_${n}`)) n++;
      id = `${id}_${n}`;
    }
    used.add(id);
    out[id] = rec;
  }
  return out;
}
