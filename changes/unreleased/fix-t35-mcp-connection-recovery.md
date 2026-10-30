---
section: Fixed
---

- **Connections:** In the New connection dialog, an Id another Connection holds is called an Id, not an address, and the dialog names that Connection and offers to open it, connect it again with its stored definition, or replace it (delete at its revision, then connect the new one). An Id held only by a deleted Connection no longer blocks the connect.
- **Connections:** An MCP server or REST API saved without any tools is marked "Incomplete" in the Connections list, and anyone with the delete right on it removes it from its row after one question. The delete is the existing asset delete, with its rights check and audit. The list summary of such a Connection carries `withoutTools: true`.
- **Connections:** A refused connect or approval says the reason in plain words for the known reasons (personal Connection, Connection unavailable or not configured, Secret Store unavailable, unknown Connector type, managed client unavailable, catalogue entry not offered, person context not mapped). For any other reason, a reader without the right to see System pages is told who can see it and where, and a reader with that right sees the technical details already open.
