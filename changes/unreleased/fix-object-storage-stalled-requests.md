---
section: Fixed
---

- **Object storage:** A read or write to an S3 store that stops answering now fails as `unreachable` once its connection has been silent for 60 seconds (10 seconds to connect), so the request that waits on it gets an answer. Before, a stalled store held an upload, a download or a deletion open without end. A large object that keeps moving is not cut off. `idleTimeoutMs` on an `s3` store entry changes the 60 seconds. The store check's 4-second bound now ends its request instead of only logging a warning.
