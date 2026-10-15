---
section: Changed
---

- Run hosted checks in parallel with one shared build, four unit/database test shards and six isolated browser shards. Keep `check` as the required aggregate, skip draft PRs, and select PR jobs from changed paths while checking main and release tags in full.
