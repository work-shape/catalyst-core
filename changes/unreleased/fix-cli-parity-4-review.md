---
section: Fixed
---

- **Knowledge Bases:** `knowledge_bases.query` from an outside client (an API key, the CLI or the MCP server) is refused with `connection_exposure:outside` while the Knowledge Base reads rows that come from a Connection not open to outside clients: a synced source, or a published Workflow or App that adds rows to its Data Store and calls a Connection operation not exposed to `outside`. A Connection that is gone counts as closed. People and agents are asked nothing more.
- **Personal API keys:** The use level no longer opens rows on every store. `data-store rows` and `query` need the key's own `data_store.execute` on the store, `insert` needs `data_store.insert` and `knowledge-base query` needs `knowledge_base.use`, each limited by the key's `<action>[:<workspace>[/<asset>]]` scope. A key limited to one workspace or store reaches no other, and a key with `data_store.read` alone still reads no rows.
- **Personal API keys:** `workflow start` needs `workflow.use` on the key, limited the same way, and no right to write Workflows. A refusal names `workflow.use`. The key carries the new operation scope `workflow_runs:use` for it.
