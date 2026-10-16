---
section: Changed
---

- **Packages:** complete the freeze-C package layout: move the server to `packages/server` and the standalone client to `clients/chat-standalone`; fold data sources into postgres-connector, the widget into chat-ui/widget, and native document helpers into tool-execution/native-document. Remove registry-canary, unused image mirror plumbing and deployment-kit forwarders. Update consumer imports, source aliases, baseline scopes and deployment paths together.

- **Compatibility:** consumers must update the removed package imports and script paths in the paired capability/deployment changes. No database migration or runtime configuration change is required; rollback uses the previous matched repository revisions.
