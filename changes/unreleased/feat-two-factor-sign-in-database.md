---
section: Database
---

- Migration `0153_two_factor` adds the table `two_factor` (one row per account with a second factor: the encrypted secret and backup codes, the failed-attempt count and the lock time; unique on `user_id`, deleted with the user) and the column `user.two_factor_enabled` (not null, default `false`). Additive, without a backfill: every existing account starts without a second factor.
