---
section: Added
---

- **Knowledge Bases:** `knowledge.<id>.pending({ type?, since?, limit })` runs as a step of a
  Workflow Run and hands it the indexed documents of a type whose pages changed after `since`,
  oldest change first, as a dataset of the step run (PROC-W, the reading half). Each row carries
  `id`, `type`, `contentHash`, `source` (null for a file added by hand), `path`, `name`,
  `changedAt` and `pages`, a dataset of `{ page, text }` rows from the stored extraction: an XLSX
  sheet per page with its tables as Markdown, a PDF page per page. No model is called. The step's
  account needs `knowledge_base.read` on the Knowledge Base; `limit` is at most 1,000. A page
  longer than one dataset row (`workflows.datasets.rowBytes`) goes on in the next row of the same
  number.
