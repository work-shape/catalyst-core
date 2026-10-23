---
section: Fixed
---

- The first letter typed into the composer no longer fails with "Maximum update depth exceeded. The result of getSnapshot should be cached" when a deployment's install resolves @assistant-ui/tap 0.9.13 or later beside @assistant-ui/core 0.2. chat-ui keeps the thread list state of its chat runtime the same object until a field changes, which is what core 0.3 does upstream, so the composer no longer depends on the deployment's lockfile resolving the pinned assistant-ui versions.
