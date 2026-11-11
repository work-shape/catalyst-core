---
section: Added
---

- **Chat:** Chats shared with you from a team you are not in stand under "Shared with you"
  below Recent, in every workspace, each with its team's name, and the search palette finds
  them by title. A click opens the chat in place, without switching workspace. The group
  shows only while it holds a chat.
- **Chat:** The panel "Who can see this chat" marks a deactivated person as deactivated, and
  the creator can still remove them.
- **API:** `conversations.shared_from_outside.list` lists the chats that name the caller from
  workspaces they are no member of, each with its workspace's name and nothing else of it.
  A named person in a chat's `people` carries `deactivated: true` while deactivated or while
  their deletion is pending.
