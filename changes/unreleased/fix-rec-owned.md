---
section: Database
---

- **Data Stores:** Owned-store release 11 adds `catalyst.record_fields.content_sha256` with `IF NOT EXISTS`, preserving columns already created by earlier releases. Knowledge Base readiness checks every required owned-store release number, so a missing earlier release keeps the store preparing until the existing upgrade path repairs it. Core Drizzle migrations are unchanged. Rolling back the application restores the previous level-based readiness check; the additive column can remain.
