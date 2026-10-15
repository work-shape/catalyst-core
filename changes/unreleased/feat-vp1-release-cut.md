---
section: Added
---

- **Releases:** `pnpm release:cut <version> [--root ../capabilities]` cuts one lockstep version, folds change files, refreshes OpenAPI and checks tarballs before creating a local release commit in each repository. Workspace dependencies stay linked; tags and publishing remain separate.
