---
section: Added
---

- Workflows separate business processes from data flows. Knowledge Base and Data Store pages derive “Filled by” and “Processed by” links from published data flows; completed data runs that handled no items can be expanded from a folded row.
- Publishing a process Workflow with a Knowledge Base write or a records proposal refuses with `process_workflow_write_operation`: “Operation '<operation>' writes data. Set kind: data in workflow.yaml before publishing this Workflow.” Drafts remain editable.
- Apply migration `0113_workflow_empty_runs` before app and worker startup. It adds the empty-run marker with a false default; old releases remain compatible. Rollback leaves this additive column in place. Existing runs are left visible.
