---
section: Fixed
---

- **Deployment kit:** The PDF renderer (PDF-1) can be turned on in a deployment that deploys with `catalyst-deploy deploy`. A release manifest may have a `preview-capture` image, built from a `preview-capture` target of the deployment's bake file; manifests without it stay valid. A deploy of such a release sends the renderer's Compose overlay and seccomp profile to the host. With `PREVIEW_CAPTURE_ENABLED=true` and `PREVIEW_CAPTURE_SERVICE_TOKEN` (32+ characters) in the host env file, the deploy pulls and starts the `preview-capture` service from the release's digest and gives the API and the agent run worker its address; `PREVIEW_CAPTURE_INTERFACE_ORIGIN` defaults to `CHAT_UI_ORIGIN`. The flag on without the image or with a shorter token stops the deploy before it pulls. With the flag off a deploy runs as before, and removes a renderer an earlier deploy started.
