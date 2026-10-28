---
section: Added
---

- **Projects:** A project names a default agent and skills (PRJ-7). The project page's "Skills & agent" tile opens a panel that sets both; a new chat in the project starts with the default agent, which the composer's agent chooser preselects, and every run in the project is offered the project's skills beside its agent's, readable with `read_skill`. Only what the project's audience may use can be chosen: in a project others read, a person's own agent or skill is greyed with the reason and a share into the workspace. In a private project its creator may use their own, and a chat that does is marked personal. A default or skill that stops applying is kept, shown as not applying, and never offered; new chats then fall back to the workspace's agent. New operations `projects.setup.get` and `projects.setup.set` (`/api/v1/project-settings/:projectId/setup`), audited as `project.setup_changed` with counts only.
