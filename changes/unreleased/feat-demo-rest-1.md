---
section: Added
---

- The demo sample accounting server also serves authenticated REST arrays in Enterprise and Gateway shapes, from the same deterministic ledger as MCP. It includes page/offset paging, fixed profile scopes, health, optional fault injection and a shared volume divisor that keeps one large client at 100,000 bookings per month. The demo release config declares `sample-accounting-rest`; the seed grants its use to active demo users and `workflow-demo`. Automatic paging remains with EW-13p; array query declarations follow CS-5e. No migration or deployment change.
