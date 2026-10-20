---
section: Database
---

- Add the table `roles` (0125, additive): a custom role, or `user` and `admin` once a superadmin edited them, with the default the role was last reconciled with and its pending actions. A role's grants are rows of `permission_grants` with `holder_kind = 'role'`. The migration step reconciles the stored `user` and `admin` roles with the release's defaults after the migrations, writes `role.reconciled` audit events and removes role grants of actions the release no longer knows. Apply the migration before startup. The previous release ignores the table and every role row: on a rollback `user` and `admin` hold the previous release's code defaults, custom roles give nothing, and the rows wait for the next upgrade.
