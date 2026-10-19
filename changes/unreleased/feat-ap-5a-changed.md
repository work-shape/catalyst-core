---
section: Changed
---

- No deny takes `users.manage` on the instance from a superadmin any more, also not a legacy `!users.manage` revocation. `scripts/verify-permissions.ts` reads such a revocation as held.
- `users.update` refuses to remove the role `superadmin` from, or to deactivate, the last active superadmin, with `VALIDATION_FAILED` and `last_superadmin`, as `users.delete` refused its deletion. The one check is `requireActiveSuperadminRemains`.
