---
section: Added
---

- Extract declared Knowledge Base fields through the approved extraction model binding with JSON-schema output, exact page/quote evidence checks and a dropped-field count. The operation and its HTTP route use `knowledge_base.read`; values and document text are never retained in Operation Runs, audit, errors or logs.
- Add the optional per-Knowledge Base monthly extraction budget and per-document token budget, with atomic admission and “Fields pending” / “Felder ausstehend” while extraction waits. Documents remain searchable. Raise and publish the budget to allow the Workflow's next call; refusals say “Field extraction could not complete” with `knowledge_field_budget_reached` or `knowledge_field_token_budget_reached`.
- Owned Knowledge Base store migration 10 adds counters and pending markers (9 is reserved by SRC-3b); no core migration. Upgrade owned stores before calling the new operation. Rollback may leave the additive tables and column in place; never remove applied migration records. Failed/interrupted calls keep their conservative reservation until the budget is raised or the UTC month resets.

- Owned-store migration audit counts use the SQL migrations actually applied, preserving accurate counts when another lane reserves a migration number.
