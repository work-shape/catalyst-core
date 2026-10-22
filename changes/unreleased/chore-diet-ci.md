---
section: Changed
---

- **Checks:** Run browser coverage on six duration-balanced shards with a minimum group count and a matching Playwright container, avoiding browser dependency installation per shard. Transfer the shared build as a run-scoped artifact so both host and container jobs can restore it. Leave scale tests out of the release Check for the Mac mini nightly run.
