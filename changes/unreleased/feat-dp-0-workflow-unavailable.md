---
section: Fixed
---

- **Apps:** Publishing an App whose `workflow` action names a Workflow that is not published, or not in the App's workspace or on the instance, is refused with `workflow_unavailable`, and a mapping that leaves out a required input of the Workflow's published revision or fills one it does not declare is refused with `workflow_input_invalid`. Before, such an App went live and failed at every click. A live App whose Workflow was taken back answers its action with `workflow_unavailable` and the Workflow named, and `workflows.unpublish` and `assets.delete` of a Workflow answer a warning naming each live App that starts it (DP-0).
