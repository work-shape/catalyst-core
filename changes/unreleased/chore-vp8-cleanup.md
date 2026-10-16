---
section: Changed
---

- Operated deployments use one exact published Catalyst version and their own frozen lockfile. The deployment kit removes source-pin updates and workspace preparation; use `catalyst-deploy bump <version>` and commit the manifest and lockfile together. Merge this cleanup only after VP-6 and VP-7 switch Musterbau and Catalyst. Earlier digest manifests remain readable for rollback; pre-switch releases use the kit and recovery procedure committed with their tag.
