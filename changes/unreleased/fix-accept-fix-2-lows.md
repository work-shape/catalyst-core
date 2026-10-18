---
section: Fixed
---

- Batch personal App storage writes about every 250 ms, coalescing each key and preserving awaited kit saves. Flush on pagehide and hidden visibility is best effort; closing or reloading before a save completes can lose a write.
- Share the Personal Workspace owner-name rule between interface and publish narratives.
- Document shared draft/published personal state, unsupported sessionStorage, and localStorage shim limitations in the App build guide and platform-docs skill.
