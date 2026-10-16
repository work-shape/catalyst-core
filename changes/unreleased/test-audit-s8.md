---
section: Changed
---

- Route chat UI tests through one private test seam so folder moves do not rewrite their imports. Reject private chat UI imports outside that seam with lint; all existing assertions remain in place.
