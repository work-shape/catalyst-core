---
section: Changed
---

- **Tooling:** Each platform module is declared in a file of its own under `client-assembly/src/platform-modules/`, so a change to one module's operations no longer edits the same file as another's.
- **Tooling:** The store's `schema` is built from one namespace import per table file, so a new table needs no hand-kept list. The hand list had missed 13 tables; adding them changes nothing, because nothing reads tables through Drizzle's relational query builder.
