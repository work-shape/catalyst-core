---
section: Added
---

- **Chat:** A message sent while a run goes waits in the conversation's queue instead of being refused. Send stays beside Stop while there is text, and the queued messages stand above the composer, oldest first. Their author may edit one, which puts its text back into the field, or remove it. Other members see the queue, with their messages marked "From another member". After a failed or stopped run the queue reads "Queue paused" and says it continues after the next message is answered; the author of the oldest message may send it now or discard their messages, and for anyone else the oldest row says only its author can send it now. While the queue is paused, every open page reads it again every ten seconds, so another member's change shows without a reload. The queue lives on the server, so a reload or a second tab shows it. "Wait for the current response to finish" is gone.
- **Chat:** A run that ended with an internal, aborted or unknown failure reads "The reply was interrupted. Please send your message again." in the person's language, no longer the worker's "Agent run failed". Only a cancelled run reads "The reply was stopped."
- **UI library:** `Button` has the variant `solid`, the one full fill in the text colour, and `ComposerFrame` frames a message composer and the tray above it.
