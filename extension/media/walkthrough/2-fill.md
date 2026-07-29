## Fill a real government form

Twelve real forms ship with the extension — **W-9, W-4, I-9, IRS 1040, Schedule C, Schedule SE,
W-8BEN, W-7, 1099-NEC, DS-11, DS-82, I-765** — already mapped to their actual field names. You
don't need to know that the W-9's name box is called `topmostSubform[0].Page1[0].f1_01[0]`.

**Create People (records) File** writes a `people.yaml` — your details, once, gitignored:

```yaml
people:
  me:
    first_name: Jordan
    last_name: Sample
    ssn: "123-45-6789"
    address: { street: 1234 Meridian St, city: Bellingham, state: WA, zip: "98225" }
```

Then point a workflow at a blank form and say who's filling it:

```yaml
inputs:
  - input/fw9.pdf            # the blank from irs.gov
operations:
  - fill_form:
      form: w9               # see the PDF Fill sidebar for all 12
      records: people.yaml
      person: me
output:
  file: output/w9-filled.pdf
```

Enter once, fill many: the same record fills a W-9, a 1040, or a passport application. Related
people link via `relations`, so a form that needs a spouse or a parent pulls them in.

**Your data is a spreadsheet, not YAML?** Point `records:` straight at a `.csv` — one row per
record, column headers as the keys. `person:` picks the row.

**Run it with `preview: true` first** — it reports exactly what would be filled, and writes no
PDF. Add `flatten: true` for a locked, print-ready copy.
