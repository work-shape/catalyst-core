---
section: Added
---

- **Project files:** A project has a folder of files with versions. Its page shows the file tree, takes files, folders and `.zip` archives (unpacked into a folder), and shows each file's versions with who made them and a restore. Uploads in a chat of a project land in its folder; a chat's contents have a "Project" section, an attachment can be saved to the project, and a file of another project the person reads can be added to a message. The agent of a chat in a project lists, reads, writes and edits the folder at `project/` with the file tools and is told its files in the system message; a write over a file that changed since the agent read it is kept beside it as a conflict copy, and the turn shows each change with an Undo. Only the project's audience reads or writes its files. `projects.files` sets the caps on files, bytes and kept versions. A deleted project, workspace or user takes the project files along; a deleted user's private projects go too.
