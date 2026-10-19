---
section: Changed
---

- Hosted Check no longer runs on a push to main: pr-land merges only a head that contains main and passed Check. A nightly run at 02:00 UTC covers main, and a newer dispatch on a branch cancels the older one. A release of a main commit needs a successful Check on main from a push, a dispatch or the nightly run.
