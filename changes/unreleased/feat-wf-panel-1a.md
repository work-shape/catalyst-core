---
section: Fixed
---

- **Workflows:** Workflow asset reads now include per-step facts resolved under the reader's rights, including source names and service icons, operation schemas and availability, child Workflow titles, a model the AI step declares, and the published schedule's time zone and next due time. Operation nodes use these facts for their chips and effects. Step runs expose a bounded preview of their resolved input beside the output preview, only to holders of `workflow.read_run_data`; a step run stores only that cut preview, keeps none of an input holding a dataset row, and pruning removes it. Definition problems retain their step paths. No migration or new right is required.
