---
section: Added
---

- **Connections:** A Connector type can declare a form (`form` on its definition: title, description, auth scheme, fixed settings and fields with English and German labels). The New connection dialog offers each such type as a card beside an MCP server and a REST API, asks for the fields it declares, and Connect writes the definition, sends the secret and runs the type's test. A refused secret empties the field and says so. The new read-only operation `connections.connector_types` (`GET /api/v1/connector-types`) lists these types to whoever may make a Connection. A Connection of such a type shows its settings read-only on its page and waits for no discovery.
