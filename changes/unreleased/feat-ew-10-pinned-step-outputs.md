---
section: Added
---

- **Workflows:** Pinned step outputs for test runs (EW-10). On a run's page, the panel of a step outside every block (`operation`, `agent`, `code` or `workflow`) that ended `done` offers "Use this output in test runs". The builder's next test runs of the draft end that step with the pinned output and make no call, model run or script for it; the run records the steps it took from a pin (`pinnedSteps`) and its page links each to the run the output came from. The Workflow's page shows a pinned step in its panel with Unpin. A pin is the builder's own, holds no value, and stays the source run's data with that run's retention and readers. It is cleared once the step changes or the source run's data is gone, and runs of the published revision never use one. New operations `workflows.list_pins`, `workflows.pin_step` and `workflows.unpin_step` ask `workflow.write`; pinning also asks what reading the source step's output asks.
