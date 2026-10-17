---
section: Changed
---

- SRC-1b: sync operations, source inspection and retry commands for synced Knowledge Bases, using an owned ingestion principal.

- Source narrowing and removal remain refused with `not_supported_yet`: "Changing a source boundary or removing a source is not supported yet; the published source is kept."

- Change-feed sync remains refused with `not_supported_yet`: "Change-feed sync is not supported yet; request mode full." Use `catalyst knowledge-base sync <kb> --source <id> --full` for a full pass.

- Knowledge Base document retry now requires credential scope `config_assets:write` instead of `data_store_rows:write` shipped in 0.8.0-rc.3. Integrations issuing access tokens must request `config_assets:write`; CLI automation must use a personal API key that includes `knowledge_base.write`, also held by its owner. Existing service API credentials cannot carry the new write scope: replace them with such a personal key for retry automation. An old scope alone is refused with "Missing auth scope 'config_assets:write'". On rollback, use the previous credential scope again.
