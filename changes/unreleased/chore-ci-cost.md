---
section: Changed
---

- Hosted Check no longer runs on a push to main. The lander pushes only batches that passed the full gate locally, and a nightly run at 02:00 UTC is the hosted record. A newer dispatch on a branch cancels the older one. A release of a main commit needs a successful Check on main from a push, a dispatch or the nightly run.
