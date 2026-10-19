---
section: Fixed
---

- **Chat runtime pins:** chat-ui now pins `@assistant-ui/react` 0.14.26, `@assistant-ui/core` 0.2.20, `@assistant-ui/store` 0.2.19, `@assistant-ui/tap` 0.9.3, `ai` 6.0.224 and `@ai-sdk/react` 3.0.226 exactly (server pins `ai` too). A lock-free deployment install had resolved react 0.14.29 with tap 0.9.23, which loops with "Maximum update depth exceeded" on the workspace start page and on every keystroke in the composer. The fresh consumer gate now fails when a consumer resolves any of these to a version other than core's.
