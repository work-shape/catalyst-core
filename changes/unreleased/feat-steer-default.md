---
section: Changed
---

- **Chat:** Steer is the default of "Enter while an answer runs" on You > Language and appearance, and the setting lists it first. `me.get` answers `followUpMode: "steer"` for a person who has not chosen; without a user record it still answers `queue`, and a message in someone else's run is still queued. The queue says plainly when a message goes out: a queued one is sent once the agent has finished the whole answer, a steer is read after the agent's current step, and where every message steers the queue is headed "Steering". A queued message of your own gets **Steer now** while your own run goes: the new `conversations.follow_ups.steer` hands it to that run as if it had been sent as a steer, keeping its place, under the same rules (your own run, the same credential, no attachments); otherwise it answers CONFLICT and the message stays queued.
