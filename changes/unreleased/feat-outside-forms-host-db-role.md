---
section: Changed
---

- `createPostgresCapabilityRecords` takes the `capability` it opens the records for and answers `access.problems`: each way its database role reaches beyond those records (superuser, `BYPASSRLS`, owner of the table, privileges on another table, sequence or schema, a definer function, a record of another capability). It no longer reads the migration ledger with a role that may not read it.
- The deployment kit's policy check refuses an outside forms host in `docker-compose.prod.yml` that receives `DATABASE_URL`, sets a variable from it, or has no `OUTSIDE_FORMS_DATABASE_URL`.
- Operator runbook: the outside forms host's database role (Operate > Deployment).
