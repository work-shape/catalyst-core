---
section: Database
---

- Migration `0122_app_user_storage` creates private state with cascading App/account erasure. Run migrations before startup; an older database refuses startup with the missing migration name. Rollback leaves the new table unused; do not drop it unless losing stored personal state is intended. Personal state is capped at 64 KiB of UTF-8 JSON; the refusal is `App storage exceeds APP_USER_STORAGE_MAX_BYTES (65536 bytes). Use a Data Store for business records.`
