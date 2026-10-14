---
section: Database
---

- **Legacy permission keys become grant rows (AP-4):** migration
  `0079_legacy_permission_grants` writes the rows; a user whose deletion was requested gets
  none, an entry that is no key gives none, and a row the holder already had keeps who wrote it
  (a `!key` still makes it a deny). It gives `["*"]` to every API key without scopes, keeps an
  empty list empty (it still gives nothing) and takes `*` out of a list that held it (it gave
  nothing before and would give everything now). Every statement can run again. It creates the
  table `legacy_permission_restores`. **Operators:** after the migration and before anyone
  changes a right, run `node --experimental-strip-types scripts/verify-permissions.ts` with
  `DATABASE_URL` set: it compares every holder's rights from the rows with what the columns
  answered and exits `1` on a difference. Do not change rights while a release before this one
  still runs beside it: that release writes the column only, and the change is not seen.
  **Rollback:** the columns are kept for one release. Stop this release, run the script with
  `--restore-legacy-columns`, then start the earlier release. It writes each holder's rows back
  into its column and removes them (the earlier release reads every row as well), turns `["*"]`
  back to null and marks the restore with a row in `legacy_permission_restores`; it leaves the
  migration record alone. To upgrade again, run the migration step as always: after the
  migrations it moves the lists the earlier release kept into rows again and clears the mark, in
  one transaction, whatever migrations are recorded. Until then this release refuses to start.
  A later release drops the columns.
