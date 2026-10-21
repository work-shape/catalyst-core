---
section: Fixed
---

- The deployment image Dockerfile defines `runner-system` before the `api` and `artifact-preview-worker` stages that copy its package manifest, so deployment image builds no longer fail with "cannot copy from stage".
