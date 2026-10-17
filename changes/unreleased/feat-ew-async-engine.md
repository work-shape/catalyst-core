---
section: Database
---

- **Workflows:** An `operation` step can wait on an operation whose work ends after the call (EW-ASYNC, engine half), with migration `0100_workflow_step_operation_wait`. An operation declares `completion: { mode: "async", stillRunning, example }`. Its call answers `running` with the run's id, and the Operation Run stays `running` until its owner ends it with `finish`. The step goes `waiting` on that run and holds no step slot. The transaction that ends the run (`finish`, or an interrupted run) queues the job of every step that waits for it, so the end of the run is never lost to a restart. The step then ends with the operation's result when it fits the output schema (`output_invalid` otherwise), or failed with the run's code.

- **Timeout:** An operation step takes `timeout` in minutes or hours (`30m`, `6h`). The default is `6h`, and the most is `12h`, the time a run may take. At the timeout the step fails with `operation_still_running` and the operation's `stillRunning` sentence, and the work goes on. The run page shows that sentence. Cancelling a run ends a waiting step `cancelled` and leaves the work running. A step job that is retried after its worker died finds the first call by the step run's idempotency key and starts no second call. A test run simulates such a changing operation and gives its `example` as the step's output.

- **Compatibility:** An operation with `completion` must be `changing`. A call through an agent tool answers `{ status: "running", operationRunId }`, and the HTTP face answers `202` with the run's `Location`. An App action that calls such an operation is refused. No operation of this release declares `completion`; the Knowledge Base sync that uses it comes with SRC-1b.

- **Deployment:** Apply migration `0100_workflow_step_operation_wait` before starting API and worker processes. It adds one partial index on `workflow_step_runs (operation_run_id)` for waiting steps. The previous release stays compatible, and rolling back leaves the index unused.
