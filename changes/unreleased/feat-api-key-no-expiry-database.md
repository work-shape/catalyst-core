---
section: Database
---

- Migrations 0194 and 0195 let a confirmed connect code keep `api_connect_codes.key_expires_at` null, for a personal API key that never expires (`api_credentials.expires_at` was nullable already). The approval constraint is widened, added `NOT VALID` in 0194 and validated in 0195, so the table is not scanned under the lock. Every existing row and every write of the previous release still fits it. Rolling back needs no step for the schema, but the previous release cannot read a personal key issued without an expiry: revoke such keys before a rollback.
