---
section: Changed
---

- **Deployment kit:** Source-ref deployment lockfile refreshes resolve exact Catalyst version pins against matching local packages. This keeps existing image builds working while deployments move to published packages; root development uses the workspace repository's generated local overrides.
