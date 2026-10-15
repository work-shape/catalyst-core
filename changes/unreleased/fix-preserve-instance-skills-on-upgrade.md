---
section: Fixed
---

- **Skills:** Keep existing instance skills when an upgrade ships skills with the same names, and warn the operator instead of refusing API startup. Instance content, revisions and agent references remain intact. A later config push can remove the copies so the next start seeds the shipped skills; upgrades do not require that push beforehand.
