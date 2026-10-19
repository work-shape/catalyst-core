---
section: Database
---

- Decided or settled Inbox requests are deleted atomically with their Operation Run: with its conversation, or after `retention.auditDays` for calls without a conversation. Pending calls remain. Request history whose run was already deleted by an earlier release is not backfilled by this change. Migration `0123` adds an index on the request’s run reference, including confirmations handed to an approver. Rollback stops future request pruning and does not restore deleted history; the additive index remains compatible.
