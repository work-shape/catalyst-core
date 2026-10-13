# @vivd-catalyst/workflows

The Workflow engine of Workshape Catalyst: the module `workflows`, switched with `modules.workflows.enabled`. The names and shapes other packages read are in `@vivd-catalyst/core` (`src/workflows.ts`); the design is in `docs/planning/specs/events-workflows-and-guardrails.md`.

The probes that the suite does not run (a loop over 10,000 items in `tests/probes`, and `tests/workflow-worker-kill.test.ts` with its waits in real time under `WORKFLOW_PROBE_REAL_TIME=1`): `pnpm --filter @vivd-catalyst/workflows probes`, with the test Postgres in `POSTGRES_STORE_TEST_DATABASE_URL`.
