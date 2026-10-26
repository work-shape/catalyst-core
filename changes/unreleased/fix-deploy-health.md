---
section: Fixed
---

- **Deployment:** Deployment checks now observe every Compose project container after a 60–90 second settle period and after the upload check. Restarting or exited services, new restarts and healthchecks that are not healthy fail with the service name and 30 masked log lines. Successful one-shot services are recognized from Compose completion dependencies. The upload check waits for document-worker readiness, streams processing progress and allows 10 minutes each for readiness and processing, configurable with `UPLOAD_CHECK_TIMEOUT_SECONDS` in the host app env file.
