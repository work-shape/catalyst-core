---
section: Fixed
---

- **Deployment kit:** The deployment image builds again: the `runner-system` stage of `deployment.Dockerfile` now stands before the `api` and `artifact-preview-worker` stages that copy from it, which BuildKit refused since 0.8.0-rc.5. A test of the kit fails when a Dockerfile names a stage defined later; `CATALYST_DOCKER_CHECK=1` adds `docker buildx build --check`.
