---
section: Fixed
---

- The Knowledge Base test of a cleanup that waits behind a document write starts the call only once its own lock on the documents is held. Before, the call could take the lock first and the test waited in vain for it to queue.
