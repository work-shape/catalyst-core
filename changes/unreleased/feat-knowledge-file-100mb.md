---
section: Changed
---

- **Knowledge Bases:** A Knowledge Base takes files up to 100 MiB unless release config sets
  `knowledge.maxFileBytes` (was 25 MiB). The text of one document stays bounded at 25 MiB
  (`KNOWLEDGE_DOCUMENT_TEXT_MAX_BYTES`, split from `KNOWLEDGE_FILE_MAX_BYTES`), so a TXT or
  Markdown file above 25 MiB is still refused, and the Add and Upload dialogs now refuse it before
  sending and name 25 MiB. The Upload dialog holds to the instance's `maxFileBytes` instead of the
  default. `knowledge.pageCacheBytes` must hold one file at `knowledge.maxFileBytes`, no longer
  25 MiB as well: a config that sets `pageCacheBytes` below 100 MiB without `maxFileBytes` is
  refused at load. A publish's conservative embedding estimate counts at most 25 MiB of text per
  unestimated document. Items of a synced source that failed with `knowledge_file_over_limit`
  under the old limit stay failed until they are retried; Retry with that failure code fetches
  them again.
