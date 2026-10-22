---
section: Changed
---

- **CI:** a `v*` tag push no longer starts the hosted Check, since the release branch's Check already proved that commit; a manual Check dispatch is accepted only on `release/**`.
- **CI:** the Postgres image workflow runs only on a push to `main` that touches `docker/postgres/**` or the workflow, or on dispatch; tag pushes and pull requests no longer start it.
