---
section: Fixed
---

- **Release safety:** Bound published auth, ORM, database, validation, React and server dependency ranges (including UI peers) to core-tested versions or minor lines. Fresh consumer release validation now migrates test Postgres, starts the installed assembly and requires a real sign-in plus an authenticated API request. Manual gate runs also prove the better-auth 1.7.10 / zod 4.4.3 regression is rejected at sign-in.
