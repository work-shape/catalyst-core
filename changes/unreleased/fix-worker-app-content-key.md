---
section: Fixed
---

- An Agent Run worker (`agentRunWorker: "separate"`) starts with `modules.apps` on without `CHAT_SESSION_TOKEN_SECRET` or `BETTER_AUTH_SECRET`. Only the API signs and checks the content tokens of Pages and Apps, so only the API derives their key; a worker still gets the `files` store and the same startup checks for it.
