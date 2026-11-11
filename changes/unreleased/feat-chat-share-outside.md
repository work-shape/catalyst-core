---
section: Added
---

- **Chat:** Sharing a private chat finds anyone active on the instance, not only members of
  the team. From two letters the @ menu and "Add person" search the instance by name, members
  first; an email address finds a person only when typed in full. People outside the team are
  marked "not in" the team, and the confirm line says they see only this chat and their turns
  run with their own rights. Searches of two letters or more are limited to 30 a minute.
- **Chat:** A person outside the team who is named on a chat reads and continues that one chat
  and nothing else of the workspace: every route of the workspace and every other chat of it
  answers them as missing. Their turns use an instance agent open to them in place of the
  team's own, with their own rights only; with none open they read along. The chat opens in
  place from the Inbox and its link, with the workspace's name in its head, and Leave.
- **API:** `conversations.reader_offer.get` answers a chat's workspace, whether the caller
  reads it from outside, and the agents their turns may run there. Share candidates carry
  `member`, and `conversation.person_added` audits `outside: true` for a person outside the
  team.
