---
section: Fixed
---

- **Apps:** An App following a Workflow Run it started through `apps.sessions.get_workflow_run` (kit `useWorkflowRun`, `workflowRuns.get`) now gets the run's whole output up to 256 KiB as JSON (`APP_WORKFLOW_RUN_OUTPUT_MAX_BYTES`, the size of an action result), instead of the interface's 2,000-character preview. Before, an output longer than 2,000 characters came back as `{ status: "done", outputTruncated: true }` with no output. `outputTruncated` is now set only above 256 KiB (DP-0b).
