---
section: Added
---

- `web_download` saves one file from a public address, such as a PDF, an image, a CSV or a workbook, into the conversation's execution workspace, where the agent reads and analyses it with the workspace tools. It takes `web_fetch`'s address checks and is off unless `webAccess.enabled`, `webAccess.download.enabled` and `executionWorkspaces.enabled` are all set. `webAccess.download` bounds it: `maxBytes` (25 MiB by default, at most 100 MiB; a larger file is refused, not cut), `timeoutMs` (60 seconds, at most 300), `maxRedirects` (5) and `contentTypes`, the declared media types it takes. The audit records the host, the media type and the size only. After a call on a personal connection it leaves the conversation with the other web tools.
