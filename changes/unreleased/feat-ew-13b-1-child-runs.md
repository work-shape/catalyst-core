---
section: Database
---

- **Workflows:** Workflow steps can start a published child Workflow, wait without a step slot, and return its output. Child runs retain lineage and the root starter, inherit test mode, stop with their parent, and nest at most three levels. Save and publish check child contracts, parent triggers, use rights, and cycles. Migrations 0087–0088 add workflow run lineage and the unique parent step key. Datasets and child run keys remain unsupported.
- **Refusals:** A fourth level fails with `depth_limit`: "A child run cannot start below three levels". Publishing a cycle fails with `workflow_cycle`: "Publishing this Workflow would make it reach itself". Missing child use rights fail with `child_use_forbidden`: "The parent's principal does not hold workflow.use on the child". Dataset inputs fail with `not_supported_yet`: "Child datasets are not supported yet".
- **Rollback:** The migrations are additive; keep the new columns and indexes when rolling application code back. Drain child runs and unpublish Workflows using child steps or parent triggers before rollback because the previous engine cannot execute those definitions.

- **Deploy order:** after EW-2a (0085–0086), run `0087_workflow_child_runs` and
  `0088_workflow_child_run_indexes` before starting this release. Without them startup refuses
  with `The database is behind this release. Run the migration step before starting. Missing migrations: 0087_workflow_child_runs, 0088_workflow_child_run_indexes`.
  Generated Drizzle snapshots stay in the source checkout; runtime packages ship migration SQL
  and the journal within the existing package size budget.
