import { z } from "zod";
import { AppError, type DataStoreRecord, type LocaleCode } from "@work-shape/catalyst-core";
import type { PostgresChangeStatements } from "@work-shape/catalyst-postgres-connector";

/** Read the catalogs only: proposals never repair an old store, even on their first call. */
export async function requireRecordsUpgrade(
  sql: Pick<PostgresChangeStatements, "run">,
  store: Pick<DataStoreRecord, "name" | "roles">,
  locale: LocaleCode
) {
  const [row] = await sql.run(
    `select
    exists(select 1 from pg_catalog.pg_attribute
      where attrelid=pg_catalog.to_regclass('catalyst.record_fields')
        and attname='content_sha256' and not attisdropped) and
    exists(select 1 from pg_catalog.pg_attribute
      where attrelid=pg_catalog.to_regclass('catalyst.record_fields')
        and attname='corrected_value' and not attisdropped) and
    exists(select 1 from pg_catalog.pg_proc
      where oid=pg_catalog.to_regprocedure('catalyst.project_record(text,jsonb)')
        and proowner=(select oid from pg_catalog.pg_roles where rolname=$1::text)
        and prosecdef and proconfig=array['search_path=pg_catalog']) as ready`,
    [store.roles.app]
  );
  if (!z.object({ ready: z.boolean() }).parse(row).ready)
    throw new AppError(
      "CONFLICT",
      locale === "de"
        ? `Der Data Store '${store.name}' benötigt sein Upgrade für records.propose. Veröffentliche den Store erneut; ein von Catalyst betriebener Store schließt sein Upgrade selbst ab.`
        : `Data Store '${store.name}' needs its upgrade for records.propose. Publish the store again; a store Catalyst runs finishes its upgrade on its own.`,
      { reason: "record_store_upgrade_required", store: store.name }
    );
}
