---
section: Changed
---

- **Workspace checks:** Derive the package dependency graph and source aliases from package manifests. Lint now owns the workspace dependency check across package and client source, tests, scripts, tools, Astro and MDX as well as package cycles; the separate workspace-deps script and manually maintained graphs are removed. Test-only UI subpaths are development-only exports and remain absent from published packages. After editing exports, run `pnpm exec catalyst-quality aliases --write` in platform and capabilities; lint refuses stale maps with a repair command that also covers new exports in the sibling platform repository.
