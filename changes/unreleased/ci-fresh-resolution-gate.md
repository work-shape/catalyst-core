---
section: Fixed
---

- **Release:** Publication now waits for a hosted scratch consumer to install the release tarballs without core's lockfile or third-party overrides and build the server and UI, catching incompatible third-party range drift before publishing. The same gate can be dispatched on a branch without publishing.
