---
section: Changed
---

- **Tooling:** `check:affected` selects the tests that reach a changed file through their imports, and no longer every test that reaches any file of the changed package or of a package depending on it. A changed file no test imports (SQL, a template, a worker started by its path) still selects the tests of its whole package, and a test that reads a package with fs or runs its CLI still runs for that package and the packages it depends on. Lint and type checks keep their package scopes.
