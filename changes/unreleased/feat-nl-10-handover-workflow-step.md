---
section: Added
---

- **Scheduled prompts of a deactivated person:** Settings > Users shows a deactivated person's scheduled prompts on their page. An instance admin hands each to another person, who gets it paused, or deletes it.
- **Scheduled prompt handover:** `scheduled_starts.handover` now also refuses a new owner who may not use the prompt's agent in its workspace (not offered there, or `agent.use` denied or not granted on a limited agent). Before, an active member was enough, and the prompt was skipped at its first run.
- **Inbox:** An item of kind `workflow_step` reads as its Workflow, its step, the step's instruction, the inputs it received and a link to the run, and is approved or declined. Nothing files such an item yet: the Workflow `approval` step that does comes with EW-4.
