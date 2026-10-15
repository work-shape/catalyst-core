import { and, eq, sql } from "drizzle-orm";
import { AppError, userInDeletionError, type ClientInstanceId } from "@vivd-catalyst/core";
import type { PostgresConnection } from "./postgres-database";
import { productUsers } from "./schema";

/**
 * The locks every write that changes who holds what takes at the start of its transaction, in
 * this order: the instance's access lock, then the row of the user the write is about, where
 * there is one. Grants, roles, legacy keys, references, sign-ins, passwords, memberships,
 * service principals and keys all wait for each other this way, so a check made under these
 * locks stays true until its write commits, and no two such writes wait for each other in a
 * circle. Rights writes are rare: one writer at a time per instance costs nothing that matters.
 *
 * Both locks are held to the end of the transaction and taken again at no cost by the same
 * transaction, so a write inside a transaction that holds them already keeps the order. Outside
 * a transaction they would end with the statement: `tx` is a transaction.
 */
export async function lockRights(
  tx: PostgresConnection,
  input: { clientInstanceId: ClientInstanceId; userId?: string }
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`access:${input.clientInstanceId}`}, 0))`
  );
  if (input.userId === undefined) return;
  await tx
    .select({ id: productUsers.id })
    .from(productUsers)
    .where(
      and(
        eq(productUsers.clientInstanceId, input.clientInstanceId),
        eq(productUsers.id, input.userId)
      )
    )
    .for("update");
}

/**
 * `lockRights` for a write that a user whose deletion was requested may no longer receive:
 * the statement that marks the user waits for the lock, so the mark is either seen here or
 * set after the write.
 */
export async function lockRightsOfUsableUser(
  tx: PostgresConnection,
  input: { clientInstanceId: ClientInstanceId; userId: string }
): Promise<void> {
  await lockRights(tx, input);
  const [user] = await tx
    .select({ deletionRequestedAt: productUsers.deletionRequestedAt })
    .from(productUsers)
    .where(
      and(
        eq(productUsers.clientInstanceId, input.clientInstanceId),
        eq(productUsers.id, input.userId)
      )
    );
  if (!user) throw new AppError("NOT_FOUND", "User is not available");
  if (user.deletionRequestedAt !== null) throw userInDeletionError();
}
