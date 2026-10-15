---
section: Added
---

- **Releases:** `pnpm release:cut <version> --root ../capabilities` cuts one lockstep version, folds change files, refreshes OpenAPI and checks tarballs before creating a local release commit in each repository. Requires matching current versions in both repositories and reports finish/undo commands if a release commit fails. Workspace dependencies stay linked; tags and publishing remain separate.
