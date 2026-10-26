---
section: Fixed
---

- A workspace command whose sandbox could not start (`docker run` exiting 125 with the Docker client's own error, such as an image that cannot be pulled) is now a start failure of the sandbox, not the command's own exit. `workspace.exec` tells the agent with `details.reason` `sandbox_unavailable`, the command's id and time, and without the worker's cause, that the failure is the platform's and not the person's to fix. A lost worker or a runner error comes back the same way with `platform_error`, and no worker with `no_worker`.
- The platform rules tell every agent to put a platform failure on the platform's operator with its time and id, never on the person in the conversation or a named contact. The help contact is read for a missing right only.
