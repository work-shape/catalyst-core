---
section: Added
---

- **Apps:** Adds the dark SRV-1 preview capture service: isolated, sandboxed Chromium, a stub App bridge, bounded request jobs and short-lived content addresses. The `preview.capture` tool keeps using the browser; the deployment-kit image and Compose overlay are opt-in and no deployment is enabled. Migration 0168 adds nullable server request and diagnostic fields; apply committed migrations before enabling. Startup refuses with "preview-capture refused startup: check its isolated environment and renderer sandbox" without the required Linux sandbox. Captures refuse with `capture_busy` when the queue is full and `capture_failed` on failure. Roll back by disabling `PREVIEW_CAPTURE_ENABLED` and the Compose profile; keep the added columns while workers drain.
