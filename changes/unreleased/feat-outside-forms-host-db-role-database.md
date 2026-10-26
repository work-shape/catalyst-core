---
section: Database
---

- Migration `0154_capability_records_row_security` turns on row-level security for `capability_records` with two policies: a permissive one that keeps every role's access as its grants give it, and a restrictive one that holds every session that logged in as, or switched to, a role whose name starts with `catalyst_outside_forms` to the rows of the capability `outside-forms`. The platform's role owns the table, or is a superuser, and is not subject to either. The migration creates no role and needs no `CREATEROLE`. A backup made by a role that neither owns the table nor is a superuser needs `pg_dump --enable-row-security`, or it stops at this table.
