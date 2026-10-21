---
section: Fixed
---

- **Tests:** The writers that the code step tests start to prove the sandbox ends what a script leaves running now stop by themselves after 120 seconds or 64 MB, and the cleanup also kills them by the pid they record. A test run killed before its cleanup no longer leaves a writer that fills the disk.
