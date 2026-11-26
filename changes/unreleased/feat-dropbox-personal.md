---
section: Added
---

- A Connector type declares `personalSignIn` where each person may sign in for themselves; a Connection then takes `credentialMode: user` with `authScheme: oauth`. `http_api` and `mcp` declare it; on any other type a save is refused with `personal_oauth_required`. A type's `operationRefusal` now also receives the Connection's credential mode, and `ConnectorContext.connection` carries `credentialMode`.
- A catalogue part is checked in every credential mode it allows, with the scopes its install derives from the operations.
- A personal Connection is never offered or accepted as a Knowledge Base source: ingestion keeps a shared binding.
