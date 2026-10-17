---
section: Added
---

- Configure Workflow step concurrency with `workflows.stepSlots` (default 4, integer 1–64). Workers and loop run views use the setting. Code sandbox concurrency is capped by both this setting and `workflows.codeSteps.slots`; the startup memory check counts that effective concurrency. Invalid values stop startup.
