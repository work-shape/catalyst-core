---
section: Added
---

- Extract declared Knowledge Base fields through the approved extraction model binding with JSON-schema output, exact page/quote evidence checks and counts for unsupported fields and failed evidence. Failed evidence remains in the frozen handoff for records review and is withheld from projection. The operation and its HTTP route use `knowledge_base.read`; values and document text are never retained in Operation Runs, audit, errors or logs.
- Add the optional per-Knowledge Base monthly extraction budget and per-document token budget, with atomic admission and “Fields pending” / “Felder ausstehend” while extraction waits. Documents remain searchable. Raise and publish the budget to allow the Workflow's next call; refusals say “Field extraction could not complete” with `knowledge_field_budget_reached` or `knowledge_field_token_budget_reached`.
- Owned Knowledge Base store migration 10 adds counters and pending markers (9 is reserved by SRC-3b); no core migration. Upgrade owned stores before calling the new operation. Rollback may leave the additive tables and column in place; never remove applied migration records. Only calls with unknown billed cost keep their conservative reservation. Reported costs settle even for invalid output, and a pre-call content change releases the reservation.

- Owned-store migration audit counts use the SQL migrations actually applied, preserving accurate counts when another lane reserves a migration number.

- Monthly-budget publish refuses an unpriced extraction binding, naming the binding and missing `usage.costs.customer.models` row; startup remains available. Token refusals retain their estimate and configured limit for distinct EN/DE recovery copy.

- Field evidence uses the instance content locale consistently in extraction and records, independent of caller language. Estimate input at ceil(UTF-8 bytes / 4) with the default 8000-token budget; accept joined or retained line-end hyphens and German/English month names with four-digit years.
