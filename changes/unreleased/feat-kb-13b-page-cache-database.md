---
section: Database
---

- Each Knowledge Base's own store gains the table `catalyst_kb.page_cache` through owned-store migration 19, which is additive. The store's own upgrade applies it, and there is no platform migration. Rolling back to the previous release needs no step, because that release reads nothing from the table.
