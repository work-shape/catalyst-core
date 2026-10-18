---
section: Added
---

- **Workflows:** Workflows can continue a long loop into a new history with `continueAsNew: { position: offset }`. A successor starts on the then-published revision with the next position as input; histories keep their key, labels and failure policy and appear as one expandable run with numbered parts. Input incompatible with a republished revision records a failed successor naming the field. Dataset views and waits transfer without copying rows or double-counting work.

- **Deployment:** Deploy migrations 0116–0118 before starting app or workers. 0116 adds nullable continuation/checkpoint/label columns and expands the run status check; 0117 validates the status check in a separate transaction; 0118 builds the replacement key and parent-step indexes concurrently before dropping the old guards. A cancelled index build is rebuilt on the next migration run. Stable v0.6.3 predates Workflows; earlier release candidates cannot read `continued`. Rollback after a continuation requires a release that understands this status and the successor relationship; do not restart an older Workflow engine against active chains.

- **Continuation safety:** Reserve nested iterations before admitting concurrent items and drain to a quiet frontier. Cancel by any part stops the live Lauf, including a cancel queued during handoff. Repeated cursors fail with `continuation_no_progress`; draft test runs keep their original revision and labels.

- **Continuation budget edges:** Item admission reserves the non-loop tail at every enclosing level so completed loop work keeps its output and does not end at `step_limit`. A tail larger than the run budget is refused at publish: `The loop '<id>' needs <count> tail steps, above limits.stepRuns of <budget>`.
