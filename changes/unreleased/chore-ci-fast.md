---
section: Changed
---

- Run hosted checks on main pushes and release tags, or explicitly by dispatching a branch or adding the `ci` PR label. Ordinary PR events allocate no runners; the local combined batch check gates landing. Keep `check` as the stable result aggregate, share one build across parallel checks, and select labeled PR jobs from changed paths.
- Fail the aggregate on cancelled browser shards, select browser and image checks from the demo/server workspace dependency closure, and run the format check for docs-only changes too.
