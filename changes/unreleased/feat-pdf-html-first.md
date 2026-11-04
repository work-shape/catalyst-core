---
section: Changed
---

- **Agent PDFs are HTML first (PDF-1):** `workspace.html_to_pdf` writes the PDF into the workspace without a download card and takes no `filename`; the agent checks the pages with `workspace.preview_images` and hands the final PDF over once with `workspace.promote_artifact`. Its description and the docs (Where data belongs) tell the agent to make every new PDF as HTML and CSS, to keep the PDF helpers for forms, merging, editing and checking, and to use `reportlab` only to draw on an existing PDF, for more than 50 pages, or where no renderer runs.
