import type { ClientInstanceId, CollaborationWorkspaceId } from "@work-shape/catalyst-core";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { PostgresConnection } from "./postgres-database";
import { collaborationWorkspaces, collaborationWorkspaceMemberships, productUsers } from "./schema";

/** Closed links expose help contacts, never the workspace name or ordinary members. */
export async function listWorkspaceAdministratorNames(
  db: PostgresConnection,
  input: { clientInstanceId: ClientInstanceId; collaborationWorkspaceId: CollaborationWorkspaceId }
): Promise<string[]> {
  const rows = await db
    .select({ name: productUsers.displayLabel })
    .from(collaborationWorkspaceMemberships)
    .innerJoin(
      collaborationWorkspaces,
      and(
        eq(collaborationWorkspaces.id, collaborationWorkspaceMemberships.collaborationWorkspaceId),
        eq(
          collaborationWorkspaces.clientInstanceId,
          collaborationWorkspaceMemberships.clientInstanceId
        )
      )
    )
    .innerJoin(
      productUsers,
      and(
        eq(productUsers.id, collaborationWorkspaceMemberships.userId),
        eq(productUsers.clientInstanceId, collaborationWorkspaceMemberships.clientInstanceId)
      )
    )
    .where(
      and(
        eq(collaborationWorkspaceMemberships.clientInstanceId, input.clientInstanceId),
        eq(
          collaborationWorkspaceMemberships.collaborationWorkspaceId,
          input.collaborationWorkspaceId
        ),
        inArray(collaborationWorkspaceMemberships.role, ["owner", "admin"]),
        eq(collaborationWorkspaces.kind, "shared"),
        isNull(collaborationWorkspaces.deletionRequestedAt),
        eq(productUsers.status, "active"),
        isNull(productUsers.deletionRequestedAt)
      )
    )
    .orderBy(
      asc(collaborationWorkspaceMemberships.createdAt),
      asc(collaborationWorkspaceMemberships.userId)
    );
  return rows.map(({ name }) => name);
}
