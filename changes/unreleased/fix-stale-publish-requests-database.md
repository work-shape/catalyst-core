---
section: Database
---

- Migration 0200 adds `approval_requests.requester_decides` (boolean, default false): the requester held the request's deciding right when filing. It needs no backfill, since requests filed before stay listed to all who may decide them, and rolls back without a step: the previous release ignores the column.
