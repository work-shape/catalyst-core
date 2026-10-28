import { and, desc, eq, exists, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import {
  asClientInstanceId,
  asCollaborationWorkspaceId,
  PROJECT_ASSET_KIND,
  projectDefinitionSchema,
  type Project,
  type ProjectStore
} from "@work-shape/catalyst-core";
import type { PostgresConnection, PostgresTransaction } from "./postgres-database";
import {
  configAssetRevisions,
  configAssets,
  configAssetState,
  conversations,
  messages,
  permissionGrants,
  projects
} from "./schema";

// A project is an asset of the kind `project` its workspace owns, with its audience in a row
// of its own (PRJ-1). Every read here joins both and answers active projects only.

export function createPostgresProjectStore(db: PostgresConnection): ProjectStore {
  return {
    async insertProjectRecord(input) {
      await db.insert(projects).values({
        assetId: input.assetId,
        clientInstanceId: input.clientInstanceId,
        createdByUserId: input.createdByUserId,
        audience: input.audience,
        audienceChangedAt: new Date(input.createdAt)
      });
    },
    async getProject(input) {
      const [project] = await selectProjects(
        db,
        and(
          eq(configAssets.clientInstanceId, input.clientInstanceId),
          eq(configAssets.id, input.projectId)
        )
      );
      return project;
    },
    async getProjectByName(input) {
      const [project] = await selectProjects(
        db,
        and(
          eq(configAssets.clientInstanceId, input.clientInstanceId),
          eq(configAssets.name, input.name)
        )
      );
      return project;
    },
    async listProjectsForViewer(input) {
      if (input.collaborationWorkspaceIds.length === 0) return [];
      const workspaceIds = [...input.collaborationWorkspaceIds];
      // The sent chats of each project, of its own workspace only: a row that names a project
      // of another workspace is read by nobody (PRJ-1) and is not counted.
      const activity = db
        .select({
          projectId: sql<string>`${conversations.projectId}`.as("activity_project_id"),
          workspaceId: sql<string>`${conversations.collaborationWorkspaceId}`.as(
            "activity_workspace_id"
          ),
          count: sql<number>`count(*)::int`.as("activity_count"),
          lastAt: sql<string>`max(${conversations.updatedAt})`.as("activity_last_at")
        })
        .from(conversations)
        .where(
          and(
            eq(conversations.clientInstanceId, input.clientInstanceId),
            inArray(conversations.collaborationWorkspaceId, workspaceIds),
            isNotNull(conversations.projectId),
            eq(conversations.status, "active"),
            eq(conversations.kind, "chat"),
            // A chat without messages is an unsent draft, which no list counts.
            exists(
              db
                .select({ id: messages.id })
                .from(messages)
                .where(
                  and(
                    eq(messages.clientInstanceId, conversations.clientInstanceId),
                    eq(messages.conversationId, conversations.id)
                  )
                )
            )
          )
        )
        .groupBy(conversations.projectId, conversations.collaborationWorkspaceId)
        .as("activity");
      const lastActivity = sql<Date>`greatest(${configAssets.updatedAt}, ${activity.lastAt})`;
      const rows = await db
        .select({
          asset: configAssets,
          project: projects,
          config: configAssetRevisions.config,
          count: activity.count,
          lastActivityAt: lastActivity
        })
        .from(configAssets)
        .innerJoin(projects, eq(projects.assetId, configAssets.id))
        .innerJoin(configAssetRevisions, eq(configAssetRevisions.id, configAssets.activeRevisionId))
        .leftJoin(
          activity,
          and(
            eq(activity.projectId, configAssets.id),
            eq(activity.workspaceId, configAssets.scopeId)
          )
        )
        .where(
          and(
            eq(configAssets.clientInstanceId, input.clientInstanceId),
            eq(configAssets.kind, PROJECT_ASSET_KIND),
            eq(configAssets.status, "active"),
            eq(configAssets.scopeKind, "workspace"),
            inArray(configAssets.scopeId, workspaceIds),
            or(eq(projects.audience, "workspace"), eq(projects.createdByUserId, input.viewerUserId))
          )
        )
        .orderBy(desc(lastActivity), desc(configAssets.id));
      return rows.flatMap(({ asset, project, config, count, lastActivityAt }) =>
        toProject(asset, project, config).map((entry) => ({
          ...entry,
          conversationCount: count ?? 0,
          lastActivityAt: new Date(lastActivityAt).toISOString()
        }))
      );
    },
    async listProjectIdsOfWorkspace(input) {
      const rows = await db
        .select({ id: configAssets.id })
        .from(configAssets)
        .where(
          and(
            eq(configAssets.clientInstanceId, input.clientInstanceId),
            eq(configAssets.kind, PROJECT_ASSET_KIND),
            eq(configAssets.scopeKind, "workspace"),
            eq(configAssets.scopeId, input.collaborationWorkspaceId)
          )
        );
      return rows.map((row) => row.id);
    },
    async listPrivateProjectIdsCreatedBy(input) {
      const rows = await db
        .select({ id: projects.assetId })
        .from(projects)
        .where(
          and(
            eq(projects.clientInstanceId, input.clientInstanceId),
            eq(projects.createdByUserId, input.userId),
            eq(projects.audience, "private")
          )
        );
      return rows.map((row) => row.id);
    },
    deleteProjects(input) {
      return db.transaction(async (tx) => {
        const ids = [...new Set(input.projectIds)];
        if (ids.length === 0) return { deleted: 0, conversationsLeft: 0 };
        // Every conversation that names one leaves it first, a deleted one too: the key from
        // conversations is ON DELETE RESTRICT, and a deleted conversation keeps its row.
        const left = await tx
          .update(conversations)
          .set({ projectId: null })
          .where(
            and(
              eq(conversations.clientInstanceId, input.clientInstanceId),
              inArray(conversations.projectId, ids)
            )
          )
          .returning({ id: conversations.id });
        await tx
          .delete(permissionGrants)
          .where(
            and(
              eq(permissionGrants.clientInstanceId, input.clientInstanceId),
              eq(permissionGrants.scopeKind, "asset"),
              inArray(permissionGrants.scopeId, ids)
            )
          );
        // Revisions, the audience and the file rows go with the asset through their keys.
        const removed = await tx
          .delete(configAssets)
          .where(
            and(
              eq(configAssets.clientInstanceId, input.clientInstanceId),
              eq(configAssets.kind, PROJECT_ASSET_KIND),
              inArray(configAssets.id, ids)
            )
          )
          .returning({ id: configAssets.id });
        if (removed.length > 0) {
          await tx
            .update(configAssetState)
            .set({ version: sql`${configAssetState.version} + 1` })
            .where(eq(configAssetState.clientInstanceId, input.clientInstanceId));
        }
        return { deleted: removed.length, conversationsLeft: left.length };
      });
    }
  };
}

async function selectProjects(db: PostgresConnection, where: SQL | undefined): Promise<Project[]> {
  const rows = await db
    .select({ asset: configAssets, project: projects, config: configAssetRevisions.config })
    .from(configAssets)
    .innerJoin(projects, eq(projects.assetId, configAssets.id))
    .innerJoin(configAssetRevisions, eq(configAssetRevisions.id, configAssets.activeRevisionId))
    .where(
      and(
        eq(configAssets.kind, PROJECT_ASSET_KIND),
        eq(configAssets.status, "active"),
        eq(configAssets.scopeKind, "workspace"),
        where
      )
    )
    .orderBy(desc(configAssets.updatedAt), desc(configAssets.id));
  return rows.flatMap(({ asset, project, config }) => toProject(asset, project, config));
}

/** The project of an asset row and its audience row; nothing where its definition is unreadable. */
function toProject(
  asset: typeof configAssets.$inferSelect,
  project: typeof projects.$inferSelect,
  config: unknown
): Project[] {
  const definition = projectDefinitionSchema.safeParse(config);
  if (!definition.success || asset.scopeId === null) return [];
  return [
    {
      id: asset.id,
      clientInstanceId: asClientInstanceId(asset.clientInstanceId),
      name: asset.name,
      collaborationWorkspaceId: asCollaborationWorkspaceId(asset.scopeId),
      title: definition.data.title,
      ...(definition.data.description ? { description: definition.data.description } : {}),
      audience: project.audience,
      createdByUserId: project.createdByUserId,
      createdAt: asset.createdAt.toISOString(),
      updatedAt: asset.updatedAt.toISOString()
    }
  ];
}

/**
 * Locks an active project of the workspace against a change of its owner or its removal until
 * the transaction ends, and answers its audience. Nothing when there is none such.
 */
export async function lockWorkspaceProject(
  tx: PostgresTransaction,
  input: { clientInstanceId: string; projectId: string; collaborationWorkspaceId: string }
): Promise<{ audience: Project["audience"] } | undefined> {
  const [row] = await tx
    .select({ audience: projects.audience })
    .from(configAssets)
    .innerJoin(projects, eq(projects.assetId, configAssets.id))
    .where(
      and(
        eq(configAssets.clientInstanceId, input.clientInstanceId),
        eq(configAssets.id, input.projectId),
        eq(configAssets.kind, PROJECT_ASSET_KIND),
        eq(configAssets.status, "active"),
        eq(configAssets.scopeKind, "workspace"),
        eq(configAssets.scopeId, input.collaborationWorkspaceId)
      )
    )
    .for("share", { of: configAssets })
    .limit(1);
  return row;
}
