---
section: Fixed
---

- Keep normal multi-person agent use below the shipped runaway-loop safeguards, isolate personal usage from other people's safeguards, and retain instance-wide money budgets. Operators must review existing explicit safeguard overrides when upgrading; the release-config and capacity documentation describe the new defaults and scope. Older releases interpret explicit safeguard values as instance-wide and impose no safeguards when the block is omitted; restore the previous release config when rolling back.
