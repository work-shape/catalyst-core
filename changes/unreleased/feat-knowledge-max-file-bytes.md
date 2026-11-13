---
section: Added
---

- **Knowledge Bases:** `knowledge.maxFileBytes` of release config sets the largest file a
  Knowledge Base takes, from 1 MiB to 256 MiB, 25 MiB unless set. An add or upload of a larger
  file is refused with `knowledge_file_too_large` naming the limit, and a synced item listed or
  fetched larger fails with `knowledge_file_over_limit` without being stored. The Knowledge Base's
  state answers `maxFileBytes`, and the Add dialog says and holds to it. `knowledge.pageCacheBytes`
  must hold at least one file at the limit. The text of one document stays bounded at 25 MiB, and
  document extraction checks files against the 256 MiB ceiling.
