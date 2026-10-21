---
section: Added
---

- Connecting from chat (CHAT-CONN-1): `platform.connections.propose`, a tool of the Module `connections`, lets an agent propose a new Connection of any Connector type with its id, name and, for `mcp` or `http_api`, an https address without credentials and the key's header name. The tab that sent the message opens the New connection dialog filled with it, the conversation docked beside it, and the card in the conversation opens it again. The key or sign-in stays in the dialog. Once the Connection is ready, that tab sends the conversation a message as the person naming the Connection and the approved tools, never an address or a key, and the agent goes on. The audit record of a proposal names the id and the type only.
