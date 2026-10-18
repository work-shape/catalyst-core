---
section: Fixed
---

- Localize Workflow publishing, publisher failure notices and counts-only digest mail for English and German recipients, and show recipient display names.
- Show completed Workflow runs with failed descendants as needing attention in run lists, Workflow cards and run headers, and keep loop panels and canvas states consistent. Persist failed loop-item counts once at finalization; item-only and nested failures remain visible on every read surface. Aggregate descendants only for API reads through the partial tree index, never on engine `readRun`. Migration 0115 adds nullable locale/item-count columns without a backfill and builds the failure index concurrently; interrupted builds can replay the nullable additions safely. Run the migration step before startup; rollback can leave these additive columns and index in place.
- Correct Workflow authoring guidance for failure notifications and keeping a rules revision in one place for keyed child runs.
- Send `catalyst data-store publish --yes` unattended like other publishes: it waits in the caller’s Inbox for confirmation and exits 3 when held, instead of claiming to have published.
- Allow `load` to name `replace.values` alongside `replace.by`, so empty reruns clear only their explicit group. Values must name exactly the group columns with non-null scalars; rows outside it are refused with `replace_scope_mismatch`. Existing dataset-derived groups keep their semantics. Roll back by removing `replace.values` from definitions before using an older runtime; it rejects that new field.
- Include pinned pandas and numpy in the demo runner and verify their installed package manifest in the sandbox.
