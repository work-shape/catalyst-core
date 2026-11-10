---
section: Added
---

- **Chats:** The creator of a private chat in a team shares it with single members from the
  composer. An `@` at the start of the text or after a space offers up to five likely people,
  and the letters after it search them; arrows, Enter and Escape move, pick and close. A picked
  person becomes a chip above the composer with one line on what sharing gives them, and Send
  shares first, then sends. A refused share says why on the chip and sends nothing. A message
  of chips alone shares and sends the files waiting with it.
- **Chats:** The head of a shared chat shows who reads it, and the creator's private chats carry
  a Share button. Both open "Who can see this chat", where the creator adds and removes people
  and a named person leaves. The rail's row menu gains "Share…", a shared chat carries a people
  mark in place of the lock, and each message of a shared chat names who wrote it, also after
  that person left or was removed.
- **Inbox:** The notice of a chat shared with the reader opens the chat in its workspace.
- **API:** A conversation that names people carries `createdByDisplayLabel`, and the run agents
  of its snapshot carry `ownerUserId` and `ownerDisplayLabel`, so its readers see who started it
  and who wrote what. A chat more than one person wrote in carries them too, so the turns of
  someone removed keep their name after the last named person is gone.
- **UI library:** `SuggestionList`, the list a text field offers as one types, and
  `AvatarStack`, overlapping avatars with a count of the rest.
