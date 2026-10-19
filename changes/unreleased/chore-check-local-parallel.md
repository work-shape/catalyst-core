---
section: Changed
---

- `pnpm check:local` runs the steps of `pnpm check` after the build side by side instead of one after another: format, lint, the three type checks, the API checks, the test suite and the upgrade test. Each line carries its step's name, every step runs to its end even when another fails, and the output of each failed step is repeated at the end. The suite runs on the machine's cores less four (at least half of them); `CATALYST_TEST_WORKERS` sets the number for any Vitest run, and `CHECK_LOCAL_SERIAL=1` runs the steps one after another.
