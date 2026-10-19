---
section: Fixed
---

- Row updates and deletions accept computed primary-key columns as selectors while keeping computed columns read-only. Operation input validation uses the caller's English or German language, including schema limit refusals.
- Row-write event contract coverage requires the writing Operation Run, matching the existing audit writer.
- Workflow failures carry the called Connection name alongside the missing right, so run summaries can name it without reading a later definition. This is an optional API field; no migration is required, and older runs retain the plain-language fallback.
- Workflow run summaries name their recorded account and Connection in plain English and German; administrator advice explains how to allow Connection use.
- A newer draft of HTTP Connection tools replaces an earlier approval list, so the first draft cannot silently keep its old operations.
- Platform agents receive English and German wording guidance for App titles, saved drafts and the columns that identify rows.
