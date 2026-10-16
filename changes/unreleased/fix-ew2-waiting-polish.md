---
section: Fixed
---

- While an Agent Run waits for a decision, the conversation's activity row says it waits for a decision or an approval instead of a working phrase, in English and German.
- Instance > Operations shows a confirmed or approved agent call that waits for its run's worker as "Confirmed, waiting to run" or "Approved, waiting to run", not as still waiting for confirmation or approval.
- Answering a confirmation after its time ran out says the call expired and nothing ran, instead of "already decided". `operations.decide` names that case in its 409 with `details.reason: "decision_expired"`; any other 409 of a decision means the call was decided otherwise first.
