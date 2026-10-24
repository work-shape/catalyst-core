---
section: Fixed
---

- Cancelling a document fetch while database admission is pending no longer produces an unhandled rejection or dispatches the adapter after cancellation. Acquired admission is still released.
