---
section: Added
---

- **Workflows:** Workflows may declare `packages: [pypdf]` in `workflow.yaml`. Publishing checks the runner image's build-generated installed-package manifest and refuses an unknown name with `Workflow package '<name>' is not available in the runner image`. The shipped authoring skill lists names and versions. No package-count cap or import enforcement is added; publishing and running install nothing and the sandbox stays without network.

- **Workflows:** A missing or invalid manifest keeps startup running with an empty allow-list and an Infrastructure notice; every declared package is then refused at publish. Release API images carry the manifest from their runner stage at `/usr/local/share/catalyst/runner-packages.json`. Deploy API and runner images together. An older image without the manifest cannot publish declarations; existing workflows without declarations keep working. Rolling back to an engine predating `packages` refuses manifests that declare it until the field is removed. No database migration.
