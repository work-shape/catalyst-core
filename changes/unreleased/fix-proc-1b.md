---
section: Fixed
---

- **Knowledge Bases:** Knowledge Base asset reads skip processing review unless the draft changes processing. Changed drafts and publish-time confirmations use set-based counts grouped by effective processing fingerprint, without loading individual contents into the API. Publish still checks stored processor revisions and invalidates stale confirmations. Selective processing tests now assert physical content and chunk row identity.

- **Knowledge Bases:** Uploads without passage tokens or source-size metadata receive an explicitly conservative file-limit estimate, so processing confirmation does not wait on the indexing it needs to authorize.
