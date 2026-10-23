---
section: Added
---

- **Skills:** Every `workspace.exec` command of an agent run finds the whole folder of each skill the run may read, read-only at `/skills/<name>/`, at the revision that was live when the command was queued, so an agent can run a skill's scripts on its assets and write the results into the workspace. Other skills are never mounted, a Workflow's code step mounts none, and the sandbox keeps `--network none`. The worker keeps verified, read-only copies below its temp root and removes idle ones with the idle-workspace cleanup. A folder that cannot be read fails the command with `WORKSPACE_SKILL_MOUNT_FAILED`. `read_skill` names the folder for an agent with `workspace.exec`.
