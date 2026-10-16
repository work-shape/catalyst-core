---
section: Changed
---

- **Workspace checks:** Derive the package dependency graph and source aliases from package manifests. Lint now owns the runtime workspace dependency check as well as package cycles; the separate workspace-deps script and manually maintained graphs are removed. Test-only UI subpaths are development-only exports and remain absent from published packages. After editing exports, run `pnpm exec catalyst-quality aliases --write` in platform and capabilities; lint refuses stale maps with `Source aliases differ from package exports; run catalyst-quality aliases --write`.
