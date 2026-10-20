---
section: Changed
---

- **Tooling:** `packages/core/src/index.ts` holds one re-export per statement, sorted by module and then by name, and the lint rule `catalyst/sorted-barrel` keeps it so. A new export goes to its place in the file instead of after the last line, so two feature PRs no longer collide there. The barrel exports exactly the same names as before.
