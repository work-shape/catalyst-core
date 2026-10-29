---
section: Database
---

- Widen the table `feedback` to comments on Apps and Workflow runs (0180 to 0182, additive): the columns `asset_name`, `asset_id`, `asset_revision`, `asset_workspace_id` and `workflow_run_id`, `agent_name` nullable, and one comment per person per run. 0181 validates the new keys and checks, 0182 builds the indexes without blocking writes. Apply the migrations before startup. Before a rollback to the previous release, delete the rows whose `subject_kind` is not `message`; that release reads only comments on messages.
