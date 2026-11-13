---
section: Changed
---

- An agent may propose a person's own MCP server in any chat that person's own run is in, also a
  team-visible chat or one with named people (PMCP-CHAT-2). The server's tools and the person's
  own skills still run only in their private chats. The tool's answer says `privateChat: false`
  in a chat others read and tells the agent where the tools work.
- In such a chat the card says "Works only in your private chats." ("Funktioniert nur in deinen
  privaten Chats.") and offers "Start private chat" ("Privaten Chat starten"), which opens a new
  private chat in the same workspace with the same agent. After "Done" the add screen sends no
  message into that chat.
- The card's buttons go to the person whose message the run answered, not to whoever started
  the chat; everyone else sees the reader line.
