---
section: Changed
---

- **Workflow page:** under the name stands what the workflow does and, in words, when it runs:
  "Runs every Monday at 08:00", "Runs Monday to Friday at 07:30", "Starts when a Knowledge Base
  finishes syncing", or that it is started by hand only. The account its runs act as is no longer
  in the head; it is a line of the Settings. Where the last run failed, the page says so above
  the canvas, with the way to that run.
- **Workflow, Settings:** the tab shows what a person sets: name, what it does, the schedule, the
  start by hand and on a Knowledge Base sync, and what it asks for when started. The start by
  another workflow, by outside clients and by a webhook with its secret, and the result, the
  failure notice, the limits, the account, the owner and who may start it are folded under
  **Advanced**. Advanced opens by itself for a webhook that has no secret yet, for a draft that
  changes something in it, and for a workflow that starts only in a way listed there.
