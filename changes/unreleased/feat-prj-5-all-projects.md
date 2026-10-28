---
section: Added
---

- **Projects:** The Projects page has a scope filter, "This workspace" and "All my workspaces". Across workspaces the projects stand in one group per workspace, each card with its workspace's chip, and opening a project of another workspace switches to it. `projects.list_mine` (`GET /api/v1/projects`) lists them from the person's memberships under the audience of each project: a private project only for its creator, and no grant, bundle or instance role adds one. A project in a list now carries how many chats it holds and when it was last used (PRJ-5).
- **Projects:** The rail shows the five projects of the open workspace used last in a group above "Recent", with a plus that makes a project and a row to all of them.
