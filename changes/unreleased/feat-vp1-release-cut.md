---
section: Added
---

- **Releases:** `pnpm release:cut <version> --root ../capabilities` cuts one lockstep version, folds change files, refreshes OpenAPI and checks tarballs before creating a local release commit in each repository. Requires matching current versions in both repositories and reports repository state and undo commands when preparation fails, plus finish commands when a release commit fails. All manifests, including private tooling and repository roots, share the current version. Workspace dependencies stay linked; tags and publishing remain separate.
