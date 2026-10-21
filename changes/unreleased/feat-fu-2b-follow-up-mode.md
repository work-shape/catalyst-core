---
section: Added
---

- **Chat:** What Enter does during the person's own run is a setting on You > Language and appearance, under chat display: Queue (the default) sends the message after the answer, Steer gives it to the running turn after its current step (FU-2). It is kept with the account (`followUpMode` on `me.get` and `me.update`, audited as a field of `user.profile_updated`), so it is the same on every device. While a run goes, Enter sends in the person's mode and Cmd+Enter (Ctrl+Enter) in the other; with no run both send. The send button's tooltip names the mode, a pending steer in the queue says it is read after the current step, and in someone else's run the composer says the message waits for the answer.
