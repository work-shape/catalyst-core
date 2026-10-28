import { and, desc, eq, or, type SQL } from "drizzle-orm";
import {
  asClientInstanceId,
  asCollaborationWorkspaceId,
  PROJECT_ASSET_KIND,
  projectDefinitionSchema,
  type Project,
  type ProjectStore
} from "@work-shape/catalyst-core";
import type { PostgresConnection, PostgresTransaction } from "./postgres-database";
import { configAssetRevisions, configAssets, projects } from "./schema";

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
    listProjectsForWorkspace(input) {
      return selectProjects(
        db,
        and(
          eq(configAssets.clientInstanceId, input.clientInstanceId),
          eq(configAssets.scopeKind, "workspace"),
          eq(configAssets.scopeId, input.collaborationWorkspaceId),
          or(eq(projects.audience, "workspace"), eq(projects.createdByUserId, input.viewerUserId))
        )
      );
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
  return rows.flatMap(({ asset, project, config }) => {
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
  });
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
