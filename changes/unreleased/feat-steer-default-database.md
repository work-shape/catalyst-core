---
section: Database
---

- Migration `0139_user_follow_up_mode_steer` sets the default of `product_users.follow_up_mode` to `steer` and moves every row that holds `queue` to `steer`. No release carries `0137_user_follow_up_mode`, so no person has chosen Queue yet. The update touches one row per person and waits at most 5 seconds for its lock. A rollback keeps the column and its rows; the previous release ignores them.
