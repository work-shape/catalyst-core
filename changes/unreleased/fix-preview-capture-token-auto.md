---
section: Changed
---

- **Deployment kit:** Nobody manages `PREVIEW_CAPTURE_SERVICE_TOKEN` by hand any more. With `PREVIEW_CAPTURE_ENABLED=true` and the token missing or empty in the host env file, `catalyst-deploy deploy` appends a random token (64 hex characters) to that file, keeping its mode and owner, and never prints it. A token already there is kept; one shorter than 32 characters still stops the deploy before it pulls.
