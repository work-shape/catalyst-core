---
section: Added
---

- **New connection dialog (CS-5a 2/2):** "New connection" asks for an MCP server or a REST API, then for the name, the address and the key, with the id, how the key is sent, fixed headers and a test path under "Technical details". "Connect" writes the definition without operations, stores the key, tests the connection and, for an MCP server, reads its tools; a wrong address or a refused key is told at its field, a refused key empties the field, and a changed host sends the key again. Cancel after a failed connect asks, then deletes the Connection. The tools an MCP server names are approved in one list, the reading ones ticked, for agents, the bridge and workflows at once; the same list replaces "Accept" per tool on the Connection page. The tools of a REST API are pasted as YAML into that list, or "Draft with Workshaper" opens the chat beside the page with the request typed. Each operation on the page has four boxes: agents, the bridge, workflows and outside.
