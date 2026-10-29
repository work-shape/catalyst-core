---
section: Fixed
---

- **Scheduled prompts of a deactivated person:** An instance admin who lists another person's scheduled prompts (`scheduled_starts.list` with `ownerUserId`) or hands one over no longer receives the prompt's text. Each item names its agent, workspace and its kind (`workspaceKind`), schedule and state. Settings > Users labels the rows and the delete button by agent and schedule. A prompt in the person's Personal Workspace can only be deleted: `scheduled_starts.handover` refuses it with 409.
