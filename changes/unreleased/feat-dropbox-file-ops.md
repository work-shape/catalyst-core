---
section: Added
---

- A Connector operation may declare `producesFiles` in a release's static catalog. Its type is handed `ConnectorContext.outputFiles` and saves a file (at most 50 MiB, `CONNECTION_OUTPUT_FILE_MAX_BYTES`) into the calling conversation's execution workspace, as `web_download` does: a free path under `inputs/` from the file's name, the operation's name as the file's source, a subagent's thread saving into its root's workspace. The result, the Operation Run and the audit carry only the path. A call outside an agent's conversation, or on an instance without workspace storage, is refused before the type runs.
- Four new reasons a Connection call may end with: `output_file_unavailable`, `output_file_too_large` (over 50 MiB or the workspace's room; nothing is kept), `target_changed` and `item_protected`.
