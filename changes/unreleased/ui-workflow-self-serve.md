---
section: Changed
---

- **Workflow page:** under the name stands what the workflow does and, in words, when it runs:
  "Runs every Monday at 08:00", "Runs every Monday and Wednesday at 08:00", "Runs Monday to
  Friday at 07:30", "Runs every hour, on the hour", "Starts when a Knowledge Base finishes
  syncing", or that it is started by hand only. The line is the published revision's: a draft
  that differs does not change it, and a workflow never published says "Once published: …". The
  account its runs act as is no longer in the head; it is a line of the Settings. Where the last
  run failed, stopped at a limit or ended with failed items, the page says so above the canvas,
  with the way to that run.
- **Workflow, Settings:** the ways to start are rows, each with one line about it and its switch
  beside it. The schedule is one button that reads as the schedule does, "Every Monday at 08:00",
  and opens repeat, days, time and time zone. The start by another workflow, by outside clients
  and by a webhook with its secret, and the result, the failure notice, the limits, the account,
  the owner and who may start it are folded under **Advanced**. Advanced opens by itself for a
  webhook that has no secret yet, for a draft that changes something in it, and for a workflow
  that starts only in a way listed there.
- **Knowledge Base, source:** a full sync on one day of the week names the day in full, "Every
  Monday at 03:00".
