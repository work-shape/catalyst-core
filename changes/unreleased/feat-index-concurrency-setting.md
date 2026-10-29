---
section: Changed
---

- **Knowledge Bases:** how many contents are indexed at once is a release config setting, `knowledge.indexConcurrency` with `perWorker` (default 8) and `total` across workers (default 16). The import speed-up of the last release ran 32 and 64 by default, which is more than an embedding quota shared with chat allows; a deployment with a quota of its own raises the numbers. Described under Embedding models in the release config reference.
