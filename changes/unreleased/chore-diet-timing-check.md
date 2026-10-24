---
section: Changed
---

- **Tests:** The per-test and per-file time budgets and their reporters are gone. The nightly
  instead fails when the unit suite's or the browser suite's total time is over 15 minutes on
  16 cores (scaled by 16 / cores), and runs the scale tests as a separate, untimed step.
