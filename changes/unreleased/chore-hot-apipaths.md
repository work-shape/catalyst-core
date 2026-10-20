---
section: Changed
---

- **Tooling:** The reviewed pin of every API operation's id, method and path is one file per area, `tests/__snapshots__/api-paths/<area>.txt`, read from the new `operationAreas` export of `api-contract`, so two changes to different areas no longer edit the same pin. The number of retired paths is pinned directly instead of being worked out from a list of every operation added since.
