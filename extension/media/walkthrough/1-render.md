## The workflow is the source of truth

**Initialize Project** wrote you a `workflow.opw.yaml` and two sample PDFs. That YAML file *is*
your document — the PDF is a build artifact, and git is your undo stack.

```yaml
inputs:
  - input/sample_a.pdf
  - input/sample_b.pdf
operations:
  - merge: {}
  - watermark: { text: DRAFT, opacity: 0.12 }
  - set_metadata: { title: PDF Studio Sample }
output:
  file: output/sample_final.pdf
```

Hit **▶ Render Workflow** in the sidebar (or the command palette). `output/sample_final.pdf`
appears; **Open Preview** shows it, and it re-renders every time you save.

Now change something — `text: DRAFT` → `text: INTERNAL`, or add
`- delete_pages: { pages: [1] }` — and save. That diff is reviewable in a PR, revertable with
`git checkout`, and reproducible next quarter. That's the whole idea.

**Don't know the YAML?** You never have to memorize it:

- The **Operations** panel lists all 100 operations grouped by category — click ＋ to insert one.
- **Add Operation…** fills in each parameter with real controls (dropdowns, number boxes).
- Every operation has a docs page with a copy-pasteable example.
- Or just ask your coding agent — `Set Up MCP for This Workspace` teaches it the vocabulary.
