## Make your own form, and read it back

Those twelve forms are ones *someone else* authored. `create_form` makes **yours**.

Write the document in **Word** (or Markdown/HTML) and type a marker where each field belongs —
that's the entire authoring step:

```text
Full name: [[text]]

[[check]]  I accept the handbook.
[[check]]  I accept the IP agreement.

Signature: [[sign]]      Date: [[date]]
```

The tags are just **type names** — `[[text]]`, `[[check]]`, `[[date]]`, `[[money]]`, `[[sign]]`
— repeated as often as you like. You never invent a unique name; they're numbered in reading
order (`checkbox_01`, `text_03`…). Tagging a 100-checkbox intake form is copy-paste.

```yaml
inputs:
  - onboarding.docx
operations:
  - office_to_pdf: {}      # LibreOffice renders the layout
  - create_form:
      debug: true          # a copy with every field outlined, so you can see where they landed
output:
  file: output/onboarding-fillable.pdf
```

That's the whole config. Fields size themselves to their table cell and get a visible border.
`output/form-map.json` records the text printed beside each field, so you always know which
`checkbox_47` is which question.

### …then turn the answers back into a spreadsheet

Your recipients fill it and send it back. Point `extract_form` at the pile:

```yaml
inputs:
  - "intake/*.pdf"         # a whole folder folds into ONE table
operations:
  - extract_form: { to: output/extracted }
```

Out comes a JSON per form and a **CSV** for your spreadsheet or ETL. Re-runs are incremental —
drop new files in, run again, and only the new ones are read, so a 500-form backlog can be
walked across as many sittings as you like.

**Word → fillable PDF → filled → CSV**, all on your machine, nothing uploaded.
