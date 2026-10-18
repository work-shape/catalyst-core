---
section: Added
---

- **Workflows:** Workflows can continue a long loop into a new history with `continueAsNew: { position: offset }`. A successor starts on the then-published revision with the next position as input; histories keep their key, labels and failure policy and appear as one expandable run with numbered parts. Input incompatible with a republished revision records a failed successor naming the field. Dataset views and waits transfer without copying rows or double-counting work.

- **Deployment:** Deploy migrations 0116–0118 before starting app or workers. 0116 adds nullable continuation/checkpoint/label columns and expands the run status check; 0117 validates the status check in a separate transaction; 0118 builds the replacement key and parent-step indexes concurrently before dropping the old guards. A cancelled index build is rebuilt on the next migration run. Stable v0.6.3 predates Workflows; earlier release candidates cannot read `continued`. Rollback after a continuation requires a release that understands this status and the successor relationship; do not restart an older Workflow engine against active chains.

- **Continuation safety:** Reserve nested iterations before admitting concurrent items and drain to a quiet frontier. Cancel by any part stops the live Lauf, including a cancel queued during handoff. Repeated cursors fail with `continuation_no_progress`; draft test runs keep their original revision and labels.

- **Continuation budget edges:** Item admission reserves the non-loop tail at every enclosing level so completed loop work keeps its output and does not end at `step_limit`. Publishing and draft tests refuse budgets smaller than the prefix, loop containers, one item and tail: `The loop '<id>' needs at least <count> step runs for steps before the loop, one item and the tail, above limits.stepRuns of <budget>`.

- **Continuation publish guards:** Until EW-CAN-RESUME carries a resume position and finished outputs, publishing and draft tests refuse an earlier changing step (`Step '<id>' cannot precede continueAsNew loop '<loop>'`) or a later loop at the same or an enclosing level (`Loop '<id>' cannot follow continueAsNew loop '<loop>'`). Refusals include English and German rules. Existing saved drafts stay editable; they must meet these rules before publishing or testing. No migration change; an older release lacks these guards.

- **Continuation runtime:** A child successor inherits dataset access from its predecessor, restricted to its own chain and datasets handed down by its parent. An opening refusal records `continuation_invalid` without retrying a completed write. Loop output counts (`total`, `done`, `failed`) cover the whole Lauf, including child and cursor-page chains. Checkpoint counts use the existing JSON column; migrations are unchanged.
