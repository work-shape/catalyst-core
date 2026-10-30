---
section: Database
---

- Add the nullable columns `guardrail_hits.field` and `guardrail_hits.match_count` (0189, additive). They hold the field a chat input hit was found in and how many matches it had, never text. Apply the migration before startup. A rollback to the previous release needs no step: it reads neither.
