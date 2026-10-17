---
section: Added
---

- **Workflows:** Run keys (EW-13k). `workflows.start`, `workflows.test` and `workflow.<id>.start` take a `key` beside the inputs (1 to 200 characters). Among a Workflow's open and `done` runs of one mode a key exists once: a start with it starts nothing and answers that run, also when two starts race. A run that ended `failed`, `cancelled` or `limit_reached` gives its key up, so a start with it is a new run on the published revision. A `workflow` step sets its child's key with `key`, literals and references joined with `/`; a step a key answered links to that run (`linkedRunId`), waits for it and does not own it, so cancelling the parent leaves it going. Runs carry `runKey`, the runs list filters by `key` or `keyPrefix`, and the run page and runs list show the key. No Workflow declares an input named `key`. Keys stay out of audit events.
