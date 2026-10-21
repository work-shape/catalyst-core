---
section: Database
---

- Migration `0137_user_follow_up_mode` adds `product_users.follow_up_mode` (text, not null, default `queue`). The constant default adds the column without a rewrite; the migration waits at most 5 seconds for its lock. Apply it before starting the new API. The previous release ignores the column, so a rollback keeps it and every person sends with Queue until the next upgrade.
