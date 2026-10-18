import { AppError } from "@work-shape/catalyst-core";
import { quoteIdentifier } from "./server";

/** The same typed group and lock for dataset-derived and explicitly scoped replacements. */
export function replacementStatements(
  table: string,
  typeOf: ReadonlyMap<string, string>,
  by: readonly string[]
) {
  const listed = (alias: string) =>
    by.map((column) => `${alias}.${quoteIdentifier(column)}`).join(", ");
  const typed = by
    .map((column) => {
      const type = typeOf.get(column);
      if (!type)
        throw new AppError(
          "VALIDATION_FAILED",
          `The table '${table}' has no loadable column '${column}'`,
          {
            reason: "column_unknown"
          }
        );
      return `${quoteIdentifier(column)} ${type}`;
    })
    .join(", ");
  const sent = `pg_catalog.jsonb_to_recordset($1::pg_catalog.jsonb) as sent(${typed})`;
  const same = (left: string, right: string) =>
    by
      .map(
        (column) =>
          `${left}.${quoteIdentifier(column)} is not distinct from ${right}.${quoteIdentifier(column)}`
      )
      .join(" and ");
  // A replacement holds each group until commit. The load takes its table lock first:
  // sorting here orders only this chunk, while later chunks may visit groups in any order.
  return {
    lock: `
      select pg_catalog.count(pg_catalog.pg_advisory_xact_lock(held.id)::pg_catalog.text)::pg_catalog.int4 as held
      from (
        select distinct pg_catalog.hashtextextended(
          $2::pg_catalog.text || ' ' || row(${listed("sent")})::pg_catalog.text, 0
        ) as id from ${sent} order by id
      ) as held`,
    remove: `
      with gone as (
        delete from public.${quoteIdentifier(table)} as stored
        where (${listed("stored")}) in (select ${listed("sent")} from ${sent})
          and not (stored.xmin operator(pg_catalog.=) pg_catalog.pg_current_xact_id()::pg_catalog.xid)
        returning 1
      ) select pg_catalog.count(*)::pg_catalog.int4 as count from gone`,
    outside: `
      select pg_catalog.count(*)::pg_catalog.int4 as count from ${sent}
      cross join pg_catalog.jsonb_to_record($2::pg_catalog.jsonb) as scope(${typed})
      where not (${same("sent", "scope")})`
  };
}
