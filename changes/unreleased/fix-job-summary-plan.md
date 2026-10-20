---
section: Fixed
---

- The test for the job summary on a large queue passes on a test server that commits asynchronously (`synchronous_commit = off`), such as the Mac mini's. It commits its 500,000 jobs synchronously, so the vacuum marks every page all-visible, and it checks that before it asserts the index-only plan and the pages read.
