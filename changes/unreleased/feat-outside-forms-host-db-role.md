---
section: Changed
---

- `createPostgresCapabilityRecords` takes the `capability` it opens the records for and answers `access.problems`: each way its database role reaches beyond those records (superuser, `BYPASSRLS`, owner of the table, membership of another role, privileges on another table, column, sequence or schema, a definer function, a record of another capability). It no longer reads the migration ledger with a role that may not read it.
- The deployment kit's policy check refuses an outside forms host in `docker-compose.prod.yml` that receives `DATABASE_URL`, `POSTGRES_USER` or `POSTGRES_PASSWORD`, sets a variable from `DATABASE_URL`, or has no `OUTSIDE_FORMS_DATABASE_URL`.
- Operator runbook: the outside forms host's database role (Operate > Deployment). An instance that already runs the host creates the role and changes its Compose file before it deploys this release.
