---
section: Fixed
---

- **Skills:** Keep existing instance skills when an upgrade ships skills with the same names, and warn the operator instead of refusing API startup. Instance content, revisions and agent references remain intact. A later config push can remove instance-owned copies so the next start seeds the shipped skills; upgrades do not require that push beforehand. Workspace-owned names remain with their workspace even after deletion and are skipped with the same warning, keeping API startup available.
