---
section: Changed
---

- **Tests:** The scale tests, files `tests/**/*.scale.test.ts`, leave `pnpm test`, `pnpm check`, `pnpm check:local` and the lander's gate, and run in the nightly hosted check, a dispatched one and a release push, which set `CATALYST_SCALE_TESTS=1`. They are the loop over 1,000 items, the 600 child runs four at a time, the child-run budgets of 600 children and the continue-as-new budget scans. `tests/durations.json` is measured again, from the hosted main run 39233221556.
