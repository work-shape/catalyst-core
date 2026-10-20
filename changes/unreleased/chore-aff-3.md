---
section: Changed
---

- **Tooling:** `check:affected` follows a named import through a barrel to the files that define the imported names, and a type-only import adds no edge, so a change to one core file no longer selects every test that imports `@work-shape/catalyst-core`. The graph lives in `scripts/affected-graph.mjs`. A module that a barrel re-exports and a test does not import by name still runs when the barrel loads; a side effect at its top level is not followed.
