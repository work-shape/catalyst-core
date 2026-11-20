---
section: Changed
---

- The folder chooser of a synced Knowledge Base source shows how each folder stands: read whole, read in part, or not read. It counts the folders chosen and says in one line what the source reads, such as "Projekte und alles darunter, ohne Archiv".
- A folder below a chosen one can be unticked. The source keeps the chosen folder as its boundary, so a folder added there later is read, and leaves the unticked one out by an `exclude` pattern that names it (`Archiv/**`). The source's card lists the folders left out after its folders, each with a button to read it again. A pattern is read on the path below every chosen folder, so a folder left out is left out below each of them.
