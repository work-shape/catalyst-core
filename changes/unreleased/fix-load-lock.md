---
section: Fixed
---

- Serialize replacement loads on each Data Store table before taking group locks, so concurrent streamed loads with reversed groups across chunks both complete without a deadlock. Streaming and load capacity remain unchanged.
