---
section: Added
---

- **Usage:** Settings › Instance › Usage has the tabs Overview, Breakdown, Users and Recent calls. Overview adds a straight-line projection of the month, spend per day drawn by the library chart, and the people active and the conversations, Agent Runs, App actions and Workflow Runs of the month. Breakdown groups a period by workspace, agent, App, Workflow, model or origin, and a row opens into the next dimension, narrowed to it. Every Personal Workspace is one row, "Personal workspaces", for everyone. Recent calls name the workspace and never the person; a call in a Personal Workspace shows "Personal workspace". New operations `usage.breakdown.get` and `usage.users.list`.
- **Usage:** The right `usage.view_users` shows usage by named person: each person's own month, listed by name and never ranked. Admin and superadmin hold it by role; it is granted for the instance or for one shared workspace. Every opening of usage by person writes the audit event `governance.usage_users_viewed` with the actor, the month and, for a workspace, its id, and no figure or name.
- **Workspaces:** Settings › Workspace › Usage shows a shared workspace's Owners and Admins what it used and its Breakdown; with `usage.view_users` for the workspace, also what each member used there. New operations `workspaces.usage.get` and `workspaces.member_usage.list`.
- **Docs:** A page in German for works councils says what is recorded per person, who sees it and how long it is kept.
