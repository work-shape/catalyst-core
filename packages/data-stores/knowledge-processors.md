# Document types and processors

A built-in Knowledge Base accepts `documentTypes`, in first-match order. Named match fields
(path, name, MIME) must all match; each field's globs are alternatives. Unmatched documents
are `default`. A shared content is classified by its first active document, consistently in
review and indexing, even when another duplicate supplies its bytes.

`processor` is `text` (default) or `tables`; customer processing belongs to a data Workflow.
`chunking` is `page`, `heading`, `sheet_rows`, `sections` or `whole`, always with the existing
token cap. The processor returns the frozen documents/pages/sections/fields contract, never
chunks. `schema` holds JSON Schema in stored/API revisions. In a CLI YAML file it may name a
JSON file below the definition's folder; the CLI resolves it before sending the write.
Fields are checked when supplied; required field extraction arrives with PROC-2.

A publish that changes effective processing refuses until `confirmProcessing` matches the
count and cost statement returned in the refusal and the draft's `publishQuestion`. The CLI
accepts the token with `--confirm`. A change in the affected inventory invalidates the token.
Local processors have no model charge; re-embedding states a range from the existing passage
tokens and the configured customer rate. The range is an estimate, not a spending ceiling.
