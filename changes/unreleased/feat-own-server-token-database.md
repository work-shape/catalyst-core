---
section: Database
---

- Migrations 0201 and 0202 let `connection_bindings` hold a person's own token: scheme `static`
  with subject `user:<id>` of the person, `user_id` set, a Secret Store handle and version, and
  state `connected` or `needs_reconnect`. The scheme constraint is widened, added `NOT VALID` in
  0201 and validated in 0202, so the table is not scanned under the lock. Every existing row and
  every write of the previous release still fits it. A rollback needs no step for the schema: the
  previous release reads no such row, so people's tokens wait unused until it is back.
