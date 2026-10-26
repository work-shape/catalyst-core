---
section: Added
---

- **Knowledge Bases:** A new knowledge base asks first where its knowledge comes from: uploaded files, a connected document source (marked "Connected"), or the tables of a data store. Source types with no connection yet are named under the choice, with New connection.
- **Knowledge Bases:** A synced source's folders are chosen by name in a folder browser instead of typed as IDs. The chosen folders are shown by their paths, and folder IDs and file patterns are under Advanced settings. A source type without folder browsing still takes typed IDs.
- **Connections:** `GET /api/v1/connections/:name/source-folders` (`connections.source_folders`) lists the folders inside one folder of a document source, for anyone with `connection.use` on the Connection. It answers folder names and IDs only and goes through the Connection's credential, egress check and source limits. A document source type offers it through the new optional `folders` call of the `document_source` capability, and a Connection's list entry says `browsesFolders` where it does.
