---
section: Added
---

A Workflow has a Settings tab beside its canvas and its runs. Its builder changes the name and the description, turns the ways it starts on and off (on a schedule, by hand, from another Workflow), sets the schedule with the schedule field instead of cron, and edits the fields it asks for at the start; each Save is one revision of the draft. A schedule the field cannot show is said in words and left as it is. The result, what happens on failure, the limits, the account it runs as, its owner and who may start it are shown read-only. The trigger step's own Settings point to this tab.

A schedule's time zone is said as the schedule field says it ("Berlin time"), never by its id, on the canvas trigger and in the Settings tab; `scheduleZoneWords` is exported from the UI library.
