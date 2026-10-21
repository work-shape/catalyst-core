---
section: Fixed
---

- **Chat:** A steered message kept its `steered` metadata when the client read it through the API, so it no longer showed a second time once its run completed or after a reload, where the thread broke on the repeated message id. The message metadata schema of a user message gains the optional `steered` object (`runId`, `followUpId`, `authorUserId`, `typedAt`).
