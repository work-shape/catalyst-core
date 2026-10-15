---
section: Database
---

- **Shipped guardrail switches (GR-PUB-1):** migration `0083_shipped_guardrail_switches`
  creates the table `shipped_guardrail_switches`, one row per shipped guardrail an instance
  admin switched, with who switched it and when. A shipped guardrail without a row is on, so
  "Publishing needs an instance admin's approval" is on on every existing instance from this
  release; no row is written by the migration or by a release. **Deploy order:** run the
  migration before the new release starts, as always; the previous release ignores the table.
  **Rollback:** the previous release does not read the table and runs no shipped guardrail, so
  every publish goes live on its publisher's click again; the table can stay.
