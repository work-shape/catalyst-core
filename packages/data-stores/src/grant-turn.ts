import type { PostgresChangeStatements } from "@work-shape/catalyst-postgres-connector";

/**
 * Waits, in the transaction of `sql`, until no other transaction writes grants onto the catalog
 * rows of `database`: the database's own row, its schemas, its tables and its routines. A grant
 * or revoke rewrites such a row also where nothing changes, and two at once fail the second
 * with "tuple concurrently updated" (XX000). The lock ends with the transaction and is one per
 * database, so the grants of different stores never wait for each other.
 */
export async function takeGrantTurn(
  sql: PostgresChangeStatements,
  database: string
): Promise<void> {
  await sql.run(
    `select pg_catalog.pg_advisory_xact_lock(
       pg_catalog.hashtextextended('catalyst data store grants ' || $1::pg_catalog.text, 0)
     )::pg_catalog.text as held`,
    [database]
  );
}
