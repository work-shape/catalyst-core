---
section: Added
---

- **Agents:** A run its person starts in their own private chat is offered the accepted tools
  of the MCP servers that person added for themselves, where the agent lets them in. The agent
  setting `ownServers` ("Your MCP servers" on the agent's page) is on unless set to `false`.
  Nobody else's run, no chat with a named person or a team, no subagent, no Workflow step and
  no run started with a key is offered them. An agent's save that lists such a tool is refused
  (`own_server_tool_on_agent`), and no call of a run that is not offered one may make it.
- **Connections:** A changing tool of a person's own server asks before every call. A reading
  tool asks in a chat where an operation of another Connection ran, in the chat or in one of
  its run threads, and where that cannot be read. An admin's `allow` and the person's "Always
  allow" lower neither. The delete of a person's own server is never refused by an agent that
  lists its tools. The add stays off until PMCP-5.
