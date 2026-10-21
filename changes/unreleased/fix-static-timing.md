---
section: Changed
---

- **Tooling:** `catalyst-quality types:packages` and `types:tests` check each file in the program built for it: a package's source in its package's check, a test in its part of the tests. A program still reports what it imports when no check owns that file. Before, every part of the tests checked the source of most packages again and every package the packages it imports, so the hosted `static` job took 9 to 14 minutes. The parts of the tests run three at a time, like the lint. The tests baseline loses the unused declarations it counted twice, in package sources the packages baseline already counts.
