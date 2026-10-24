---
section: Changed
---

- **Tooling:** Every pull request runs a check on the Mac mini runner: format, lint, types, migrations, unit and database tests, and the upgrade test. A nightly run on the same runner adds the scale, compatibility, docs, release, image and full browser checks. The database script also counts cores on macOS.
