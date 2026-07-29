// Form-pack types. A pack maps friendly, canonical field keys to a specific
// fillable PDF's real AcroForm field names + checkbox on-states + transforms, so
// the same person/record can fill many different forms. Packs are JSON data in
// packs/*.json (drop-in, code-generated into an index); the engine is here.

export type FormFieldType = "text" | "checkbox" | "choice" | "dropdown" | "date" | "split" | "repeat";

/** A choice option: which real field to turn on and to what export/on-state value. */
export interface FormOption {
  field?: string; // real AcroForm field name (omit → use the group `field`)
  on: string; // the on-state / export value that selects this option
}

/** One sub-field inside a `repeat` group; `fields[i]` is the real field for row i. */
export interface RepeatSubField {
  key: string; // canonical key read from each record in the role list
  type?: FormFieldType; // default "text"
  fields: string[]; // real field name per row/index (index 0 = first record)
  digits?: boolean; // strip non-digits (SSNs in comb cells)
}

export interface FormField {
  key: string; // friendly, canonical key (see vocab.ts)
  label: string; // human label
  type: FormFieldType;
  required?: boolean;
  page?: number;
  help?: string;
  field?: string; // real AcroForm field name (text/checkbox/dropdown/shared choice)
  on?: string; // checkbox on-state (single checkbox)
  options?: Record<string, FormOption>; // choice: option label → target
  choices?: string[]; // dropdown/listbox allowed export values
  parts?: Array<{ field: string; take?: number; part?: "month" | "day" | "year" }>; // split/date
  format?: string; // single-field date mask, e.g. "MMDDYYYY" / "MM/DD/YYYY"
  maxlen?: number;
  digits?: boolean; // strip non-digits before filling (comb SSN/ZIP)
  from?: string; // role-scoped binding into a record, e.g. "applicant.last_name"
  template?: string; // compose from record paths, e.g. "{applicant.address.city}, {applicant.address.state}"
  default?: string; // value to fill when nothing else resolves (e.g. "none" for empty travel plans)
  // repeat only:
  role?: string; // the record-list role to iterate (e.g. "dependents")
  max?: number;
  fields_repeat?: RepeatSubField[]; // sub-fields expanded per row
}

/** The authoritative snapshot of a blank form's fields (for the drift guard + tests). */
export interface FormSource {
  /** Where the blank PDF came from — the issuer's canonical URL. Lets a maintainer
   *  re-download the exact source to check for a new revision. */
  source_url?: string;
  captured?: string; // ISO date the snapshot was taken (pairs with source_url)
  fields: Array<{ name: string; type?: string; page?: number; on_states?: string[] }>;
}

/** A fully-worked, copy-paste mock-up for a form's doc/catalog example. When present,
 *  the generated example workflow is self-contained (all data inline under `values:`,
 *  mock person) instead of the generic `people.yaml` + placeholder version. */
export interface FormExample {
  intro?: string; // one-line header comment above the workflow
  values?: Record<string, string>; // mock field values (rendered inline, in schema order)
  flatten?: boolean; // append `flatten: true`
  keepPages?: number[]; // append a trailing `extract_pages` step keeping these 1-based pages
  keepPagesNote?: string; // comment explaining the page-drop (e.g. "pages 1-4 are instructions")
}

export interface FormSchema {
  id: string;
  revision?: string;
  title: string;
  issuer: string;
  category: string;
  country?: string;
  tags?: string[];
  roles?: string[]; // roles this form binds (applicant, spouse, parent1, dependents, …)
  partial?: boolean; // true when only a subset of the form's fields are mapped
  source: FormSource;
  fields: FormField[];
  example?: FormExample; // a fully-worked mock-up for the doc/catalog (see FormExample)
  // Multi-copy forms (1099-NEC: Copy A/1/B/2) repeat one layout; the fields are mapped once
  // (for the primary copy) and each entry here is an ADDITIONAL copy, given as a list of
  // [find, replace] substitutions applied to each instruction's field name (e.g. container
  // "CopyA[0]"→"CopyB[0]" plus leaf ".f1_"→".f2_"). The resolver fans every instruction out
  // across the copies so one value fills them all.
  copies?: Array<Array<[string, string]>>;
}

/** A resolved instruction handed to the Python sidecar (raw field → value). */
export interface FillInstruction {
  name: string;
  value: string;
  kind: "text" | "check";
  maxlen?: number;
}

export interface ResolvedEntry {
  key: string;
  value: string;
  source: string; // "values" | role name | "default"
}

export interface FillResolution {
  instructions: FillInstruction[];
  resolved: ResolvedEntry[];
  warnings: string[];
  unfilledRequired: string[];
}
