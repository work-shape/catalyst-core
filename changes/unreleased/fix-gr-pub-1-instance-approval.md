---
section: Fixed
---

- Publish self-approval requires an instance-level approve right and a click in the app.
  Workspace approvers and CLI publishers wait in the Inbox; the CLI names the request and
  tells instance approvers where to approve it. Keys never carry approve rights.
- Workflow publish reviews include `workflow.yaml`, comparing its manifest with the live
  revision alongside the step files.
- Regression tests cover workspace self-approval, CLI-origin self-approval, an admin's real
  personal key with an interactive answer and forged origin headers, and MCP publish refusal.
