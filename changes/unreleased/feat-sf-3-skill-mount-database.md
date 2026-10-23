---
section: Database
---

- **Workspace commands:** Migration `0143_workspace_command_skill_mounts` adds the nullable jsonb column `workspace_commands.skill_mounts`, which holds the name, revision and source version of each skill a command mounts, never content. Existing commands keep nothing and mount no skill. It moves no data and waits at most 5 seconds for its lock. Apply it before starting the new API and worker. The previous release does not read the column; remove it only through a later committed migration.
