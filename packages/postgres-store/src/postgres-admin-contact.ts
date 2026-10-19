import type { ClientInstanceId } from "@work-shape/catalyst-core";
import { and, or, desc, eq, isNotNull, isNull, sql as drizzleSql } from "drizzle-orm";
import type { PostgresConnection } from "./postgres-database";
import { productUsers } from "./schema";

export async function findAdminContact(
  db: PostgresConnection,
  clientInstanceId: ClientInstanceId,
  roles: string[]
): Promise<string | undefined> {
  // The existing product_users_client_idx bounds the lookup to this instance. Read only
  // the name: listUsers also loads identities and grants that help text must not need.
  const [admin] = await db
    .select({ displayLabel: productUsers.displayLabel })
    .from(productUsers)
    .where(
      and(
        eq(productUsers.clientInstanceId, clientInstanceId),
        or(
          ...roles.map(
            (role) => drizzleSql`${productUsers.roles} @> ${JSON.stringify([role])}::jsonb`
          )
        ),
        eq(productUsers.status, "active"),
        isNull(productUsers.deletionRequestedAt),
        isNotNull(productUsers.lastAuthenticatedAt)
      )
    )
    .orderBy(
      desc(productUsers.lastAuthenticatedAt),
      drizzleSql`${productUsers.displayLabel} COLLATE "C"`,
      drizzleSql`${productUsers.id} COLLATE "C"`
    )
    .limit(1);
  return admin?.displayLabel;
}
