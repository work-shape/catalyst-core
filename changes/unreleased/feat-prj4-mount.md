---
section: Added
---

- **Project files:** Chat commands in a project now get a writable `/workspace/project` snapshot, filled from a verified host cache. Local and Docker runners store changed, new and deleted files as project versions attributed to the run, preserve concurrent writes as conflict copies, and keep project files out of the conversation scan. Mounts require the run's person's current project access; subagents use their root chat's folder and Workflow step threads get none. Audit metadata carries project IDs and versions without file paths.
