---
section: Fixed
---

- **Knowledge Bases:** a source at `knowledge.maxDocuments` keeps withdrawing what was deleted or moved out at the source and keeps applying changes; only new documents wait. A full pass lists to the end instead of stopping at the first new item, a change feed page applies its deletions and moves on instead of failing again on every poll, and a pass that reached the limit counts as the source's import, so its schedule goes on. It still ends with `knowledge_source_limit_reached`.
- **Knowledge Bases:** a folder that a source's `exclude` leaves out is no longer listed. `list` of the `document_source` contract takes an optional `excludesFolder(path)`, and a connector that walks folders skips those it names.
- **Knowledge Bases:** `include` and `exclude` follow one written rule: `**`, `*` and `?` are the only wildcards, and every other character matches itself. `Projekt [alt]/**` now leaves out that folder, where brackets used to be a character class, and a folder left out takes its dot folders and dot files with it. Braces, extglobs and backslashes are plain characters too. Patterns, paths and names are compared in Unicode NFC, so an excluded folder whose name a source composes differently stays out, and `include: ["**"]` keeps every file instead of none.
- **Knowledge Bases:** a listing position over 16 KiB is written at most every 30 seconds and when a call fails, not with every page.
