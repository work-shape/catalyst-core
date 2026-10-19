---
section: Added
---

- **Workflows:** Workflows may omit `runAs`. Publishing creates a hidden, Workflow-owned technical account with only the named assets' use rights derived from its steps. Every right must be transferable by the publisher. Each publish reconciles those grants, and draft tests use the derived rights as their ceiling. Explicit shared accounts keep their existing checks. Unpublishing removes the owned account and its rights while preserving the draft.

- **Withdrawal:** `workflows.unpublish` preserves the draft and run datasets, removes its owned account and grants, stops schedules, and records `workflow.unpublished`. An explicit `runAs` cannot borrow another asset's owned account (`run_as_owned`).
- **Rollback:** Before reverting to a release that requires `runAs`, replace omitted `runAs` definitions with explicitly administered shared accounts and republish them. Older releases reject the new definitions; their owned accounts and grants otherwise remain.

- **Connection cleanup:** A CLI sync deletion now runs the existing transactional cleanup, revoking person contexts and ending its sign-in just as an interactive deletion does.
