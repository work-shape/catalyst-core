---
section: Database
---

- Migration 0196 adds the nullable column `conversations.title_given_at`: when a person or their agent gave the conversation its title. It needs no backfill and rolls back without a step: the previous release ignores the column.
