---
section: Changed
---

- **Core:** Consolidated equivalent record guards in core, model providers and server assets into one shared `isRecord` helper. The existing JSON-object guard reuses the same check; array-accepting transport-error handling stays unchanged.
