---
section: Fixed
---

- A workspace command whose sandbox could not start (`docker run` exiting 125 with the Docker client's own error, such as an image that cannot be pulled) is now a start failure of the sandbox, not the command's own exit. `workspace.exec` tells the agent with `details.reason` `sandbox_unavailable`, the command's id and time, and without the worker's cause, that the failure is the platform's and not the person's to fix. A lost worker or a runner error comes back the same way with `platform_error`, and no worker with `no_worker`.
- The platform rules tell every agent to put a platform failure on the platform's operator with its time and id, never on the person in the conversation or a named contact. `platform.context`'s `helpContact` is for questions about the instance's content and access, never for a platform or infrastructure failure.
- The platform orientation says that `platform.assets.operations` shows what the agent can call, not what an outside client (CLI, MCP, a personal key) can reach. Asked about an outside client, the agent opens its answer by saying that it depends on the Connection's "Outside clients" exposure and the key's scopes and that it has not checked them.
