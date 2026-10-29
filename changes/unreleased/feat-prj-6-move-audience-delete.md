---
section: Added
---

- **Projects:** A project's creator shares it with the workspace or makes it private again (`projects.set_audience`), with every chat in it. Going shared is refused while a chat in it carries a personal-data mark or reads a Data Store; going private, the chats of others leave the project and stay shared in the workspace. `projects.impact` gives the counts the dialogs show (PRJ-6).
- **Projects:** A member of both workspaces moves a project with its chats and files to another workspace (`projects.move`). Grants on the project end with the move. Into a Personal Workspace only a project that holds no one else's chat; out of one, the project is private unless the person shares it.
- **Projects:** A project is deleted with its files, their versions and stored bytes (`projects.delete`); its chats stay in the workspace or are deleted too, as the person chooses. The project is claimed first, and a cleanup that fails is finished by the retention job.
- **Projects:** A chat others read enters a private project only when the person confirms that the others no longer see it (`hideFromOthers`); a chat of someone else never enters a private project.
- **Retention:** `retention.projectIdleDays` (release config, empty by default) deletes projects nothing happened in for that many days. Seven days before, the creator and, for a shared project, the workspace's Owners get a notice; any change in the project keeps it. The project's chats stay and expire by their own retention.
