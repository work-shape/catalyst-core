---
section: Fixed
---

- **Model calls:** Premature model stream endings are reported as retryable provider timeouts. Calls retry up to three attempts while no answer, reasoning or provider tool activity has reached the reader; visible output is never silently replayed. When a run times out, the chat explains in German or English that it was interrupted, completed steps are kept, and “continue” resumes the work.
