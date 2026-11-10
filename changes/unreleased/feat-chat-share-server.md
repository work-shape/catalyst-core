---
section: Added
---

- **Chats:** The creator of a private chat in a Shared Workspace, outside any project, can name up
  to 20 members of that workspace on it (`POST /api/v1/conversations/:id/people`). Each named
  member reads and writes in the chat while a member; nobody else gains anything, and a Workspace
  Owner or Admin still does not see it. Every read of a conversation carries its `people`.
- **Chats:** The creator takes a person off (`DELETE …/people/:userId`) and a named person leaves
  the same way. The names go when the membership ends, when the person is deleted and when the
  chat moves to another workspace; a chat that names people does not enter a project. Only the
  creator moves or deletes it.
- **Chats:** `GET …/share-candidates` offers the workspace's members, the ones the creator named
  before first. A share is refused, with a stable `details.reason`, where the chat must stay its
  creator's: personal data read in it, a Data Store or an asset the person may not read, a
  project, a Personal Workspace. A chat that names people no longer takes personal data.
- **Chats:** Naming, removing and changing who reads a chat is the person's own step in their own
  session: never an agent tool, a key or an embedding host. The named person gets an Inbox notice
  linking the chat, and `conversation.person_added` and `conversation.person_removed` are audited
  with ids only.
