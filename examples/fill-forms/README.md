# Fill PDF forms from one records file

These example workflows fill real fillable PDFs with the **`fill_form`** operation. All of
them draw personal data from a single, shared **`people.yaml`** (the "records" file) — enter
your details once, fill every form. Each fill picks a `person`; forms that need relatives
(passport parents, tax spouse/dependents) pull them via `relations`.

## Setup

1. **Add the blank forms.** These government PDFs aren't shipped here — download each and
   save it into `input/` with the filename below.

   | Form | Category | Save as | Download (official) |
   |------|----------|---------|---------------------|
   | Passport application (DS-11) | Passport | `input/ds11.pdf` | eforms.state.gov → DS-11 |
   | Passport renewal (DS-82) | Passport | `input/ds82.pdf` | eforms.state.gov → DS-82 |
   | IRS Form 1040 | Tax | `input/f1040.pdf` | irs.gov/pub/irs-pdf/f1040.pdf |
   | IRS Form W-9 | Tax | `input/w9.pdf` | irs.gov/pub/irs-pdf/fw9.pdf |
   | IRS Form W-4 | Employment | `input/w4.pdf` | irs.gov/pub/irs-pdf/fw4.pdf |
   | IRS Form W-7 (ITIN) | Tax | `input/w7.pdf` | irs.gov/pub/irs-pdf/fw7.pdf |
   | IRS Form 1099-NEC | Tax | `input/nec1099.pdf` | irs.gov/pub/irs-pdf/f1099nec.pdf |
   | USCIS Form I-9 | Employment | `input/i9.pdf` | uscis.gov → Form I-9 |
   | USCIS Form I-765 (EAD) | Immigration | `input/i765.pdf` | uscis.gov → Form I-765 |

   > Discover any form's fields and get a ready-to-paste workflow from the **PDF Fill** node
   > in the Documentation sidebar (or the `form_fields` MCP tool). **1099-NEC:** the
   > downloadable Copy A is informational — file by e-file or the red-ink form; print Copy B/C.

2. **Edit `people.yaml`** with your real details (it's mock data here). Keep it **local** —
   it holds PII; in a real project the extension auto-gitignores `people.yaml`.

3. **Render** a workflow: open it and hit ▶ (PDF Studio: Render Workflow), or run it via the
   engine. The filled PDF lands in `output/`, left **editable** so you can review it before
   printing/signing. Add `flatten: true` to lock a print-ready final; add `preview: true` for a
   dry-run report of exactly what will be filled.

## Two ways to provide the data

- **Shared records (`people:` + `person:`)** — best when the same person fills *many* forms
  (W-9, W-4, I-9…). Personal data lives once in `people.yaml`; each workflow picks a `person`.
- **All inline (`values:` only)** — best for a *one-off* form whose data is mostly
  form-specific. **`ds11.opw.yaml` is a complete, self-contained example** — every field
  (applicant, parents, spouse, emergency contact, passport history, travel) is filled inline,
  so you can copy that one file, swap in your details, and render. Explicit `values` always
  win over a person record, so you can mix both.

Either way, **`fill_form`** maps friendly keys to the form's real fields — checkboxes, radio
groups, split SSN/date boxes, dropdowns — for you. Discover any form's fields with the
`form_fields` MCP tool or the **PDF Fill** node in the Documentation sidebar.

> **Tip:** these are XFA government forms — add **`flatten: true`** for a print-ready copy
> that renders identically in every viewer (leaving them editable can make some viewers show
> spaces as `&` in the live fields; the data is correct, flattening bakes it in).
>
> f1040, W-4, and I-9 are **partial** mappings (the personal/identity sections). Income lines,
> withholding math, and employer sections are left for you to complete.
