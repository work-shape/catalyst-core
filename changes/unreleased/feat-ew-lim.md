---
section: Added
---

- A Workflow sets the bounds of its runs with `limits` in `workflow.yaml` (`duration`, `stepRuns`, `loopItems`, `concurrency`) under the operator's ceilings in `workflows.limits` (by default 7 days, 1,000,000 step runs, 1,000,000 loop items; the concurrency ceiling is `workflows.stepSlots`). A raise is named in the publish question on the canvas; a value above its ceiling is refused with `limit_above_ceiling`, naming the ceiling. `datasetBytes` and `pagedStepMinutes` are read and refused above their defaults with `not_supported_yet`.
- A Workflow that sets `limits.concurrency` holds at most that many step slots across its runs and their child runs, held at claim so two workers do not overshoot it. Without it a Workflow may use every step slot (`workflows.stepSlots`), as before.
- Time a run spends waiting, for an operation whose work ends later or for a waiting child, counts toward no limit: the deadline moves later by the time waited. The `timeout` of an operation step is no longer capped by the run time and accepts days (`3d`).
