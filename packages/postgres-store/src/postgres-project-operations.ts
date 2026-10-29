import {
  and,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
  type SQL
} from "drizzle-orm";
import {
  AppError,
  asClientInstanceId,
  asCollaborationWorkspaceId,
  asConversationId,
  PROJECT_ASSET_KIND,
  projectDefinitionSchema,
  type ClientInstanceId,
  type Project,
  type ProjectAudience,
  type ProjectIdleCriterion,
  type ProjectStore
} from "@work-shape/catalyst-core";
import { markLockedConversationTreeDeleted } from "./postgres-conversation-lifecycle";
import type { PostgresConnection, PostgresTransaction } from "./postgres-database";
import {
  collaborationWorkspaces,
  configAssetRevisions,
  configAssets,
  configAssetState,
  conversationDataStores,
  conversations,
  messages,
  permissionGrants,
  projectFiles,
  projectFileVersions,
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
    async getProjectImpact(input) {
      const [project] = await db
        .select({ createdByUserId: projects.createdByUserId })
        .from(projects)
        .where(
          and(
            eq(projects.clientInstanceId, input.clientInstanceId),
            eq(projects.assetId, input.projectId)
          )
        );
      if (!project) {
        return {
          conversations: 0,
          conversationsOfOthers: 0,
          conversationsKeptPrivate: 0,
          files: 0,
          filesOfOthers: 0,
          filesKeptPrivate: 0
        };
      }
      const [chats] = await db
        .select({
          all: sql<number>`count(*)::int`,
          ofOthers: sql<number>`(count(*) filter (where ${conversations.createdByUserId} <> ${project.createdByUserId}))::int`,
          keptPrivate: sql<number>`(count(*) filter (where ${keptPrivate(input.clientInstanceId)}))::int`
        })
        .from(conversations)
        .where(projectChats(input.clientInstanceId, input.projectId));
      const [files] = await db
        .select({
          all: sql<number>`count(*)::int`,
          ofOthers: sql<number>`(count(*) filter (where ${projectFiles.updatedByUserId} is distinct from ${project.createdByUserId}))::int`
        })
        .from(projectFiles)
        .where(
          and(
            eq(projectFiles.clientInstanceId, input.clientInstanceId),
            eq(projectFiles.projectId, input.projectId),
            isNotNull(projectFiles.objectKey)
          )
        );
      return {
        conversations: chats?.all ?? 0,
        conversationsOfOthers: chats?.ofOthers ?? 0,
        conversationsKeptPrivate: chats?.keptPrivate ?? 0,
        files: files?.all ?? 0,
        filesOfOthers: files?.ofOthers ?? 0,
        filesKeptPrivate: await countFilesKeptPrivate(db, input.clientInstanceId, input.projectId)
      };
    },
    async listProjectConversationIds(input) {
      const rows = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(projectChats(input.clientInstanceId, input.projectId))
        .orderBy(conversations.id);
      return rows.map((row) => row.id);
    },
    setProjectAudience(input) {
      return db.transaction(async (tx) => {
        await lockProjectChats(tx, input.clientInstanceId, input.projectId);
        const locked = await lockActiveProject(tx, input);
        if (!locked) throw new AppError("NOT_FOUND", "Project is not available");
        if (locked.project.audience !== input.expectedAudience) {
          throw audienceChanged();
        }
        const unchanged = {
          conversationsShared: 0,
          conversationsLeft: 0,
          conversationsMadePrivate: 0
        };
        if (input.audience === input.expectedAudience) {
          return { project: await requireProjectIn(tx, input), ...unchanged };
        }
        const [workspace] = await tx
          .select({ kind: collaborationWorkspaces.kind })
          .from(collaborationWorkspaces)
          .where(
            and(
              eq(collaborationWorkspaces.clientInstanceId, input.clientInstanceId),
              eq(collaborationWorkspaces.id, input.collaborationWorkspaceId)
            )
          );
        if (workspace?.kind !== "shared") {
          throw new AppError(
            "VALIDATION_FAILED",
            "A project in a Personal Workspace has no other audience",
            { reason: "project_personal_workspace" },
            { exposeMessage: true }
          );
        }
        let change = unchanged;
        if (input.audience === "workspace") {
          await refuseKeptPrivate(tx, input.clientInstanceId, input.projectId);
          const shared = await setChatVisibility(tx, input, "workspace");
          change = { ...unchanged, conversationsShared: shared };
        } else {
          // Other members' chats leave the project and stay where they are read now.
          const left = await tx
            .update(conversations)
            .set({ projectId: null })
            .where(
              and(
                projectChats(input.clientInstanceId, input.projectId),
                ne(conversations.createdByUserId, locked.project.createdByUserId)
              )
            )
            .returning({ id: conversations.id });
          const madePrivate = await setChatVisibility(tx, input, "private");
          change = {
            ...unchanged,
            conversationsLeft: left.length,
            conversationsMadePrivate: madePrivate
          };
        }
        await tx
          .update(projects)
          .set({ audience: input.audience, audienceChangedAt: new Date(input.changedAt) })
          .where(eq(projects.assetId, input.projectId));
        return { project: await requireProjectIn(tx, input), ...change };
      });
    },
    moveProject(input) {
      return db.transaction(async (tx) => {
        await lockProjectChats(tx, input.clientInstanceId, input.projectId);
        const locked = await lockActiveProject(tx, {
          clientInstanceId: input.clientInstanceId,
          projectId: input.projectId,
          collaborationWorkspaceId: input.fromCollaborationWorkspaceId
        });
        if (!locked) {
          throw new AppError("CONFLICT", "The project's workspace changed meanwhile");
        }
        // Held against its deletion until the move commits, as a key to it holds it.
        const [destination] = await tx
          .select({
            kind: collaborationWorkspaces.kind,
            personalUserId: collaborationWorkspaces.personalUserId
          })
          .from(collaborationWorkspaces)
          .where(
            and(
              eq(collaborationWorkspaces.clientInstanceId, input.clientInstanceId),
              eq(collaborationWorkspaces.id, input.toCollaborationWorkspaceId)
            )
          )
          .for("key share");
        if (!destination) {
          throw new AppError("NOT_FOUND", "Collaboration Workspace is not available");
        }
        const personal = destination.kind === "personal";
        const audience: ProjectAudience = personal ? "workspace" : input.audience;
        // Into one person's workspace, or a private audience: every chat must be theirs.
        const owner = personal
          ? destination.personalUserId
          : audience === "private"
            ? locked.project.createdByUserId
            : undefined;
        if (owner !== undefined) {
          const [foreign] = await tx
            .select({ id: conversations.id })
            .from(conversations)
            .where(
              and(
                projectChats(input.clientInstanceId, input.projectId),
                owner === null ? undefined : ne(conversations.createdByUserId, owner)
              )
            )
            .limit(1);
          if (foreign) {
            throw new AppError(
              "CONFLICT",
              "The project holds chats of other people, who would no longer read them",
              { reason: "project_holds_others_conversations" },
              { exposeMessage: true }
            );
          }
        }
        if (!personal && audience === "workspace") {
          await refuseKeptPrivate(tx, input.clientInstanceId, input.projectId);
        }
        const visibility = personal ? "workspace" : audience;
        const moved = await tx
          .update(conversations)
          .set({ collaborationWorkspaceId: input.toCollaborationWorkspaceId, visibility })
          .where(projectChats(input.clientInstanceId, input.projectId))
          .returning({ id: conversations.id });
        const movedIds = moved.map((row) => row.id);
        if (movedIds.length > 0) {
          // A run thread goes with its root (CR-1).
          await tx
            .update(conversations)
            .set({ collaborationWorkspaceId: input.toCollaborationWorkspaceId, visibility })
            .where(
              and(
                eq(conversations.clientInstanceId, input.clientInstanceId),
                eq(conversations.kind, "run_thread"),
                inArray(conversations.parentConversationId, movedIds)
              )
            );
        }
        // A deleted chat stays in its workspace and leaves the project: a project is its
        // workspace's alone.
        await tx
          .update(conversations)
          .set({ projectId: null })
          .where(
            and(
              eq(conversations.clientInstanceId, input.clientInstanceId),
              eq(conversations.projectId, input.projectId),
              ne(conversations.status, "active")
            )
          );
        const movedAt = new Date(input.movedAt);
        await tx
          .update(configAssets)
          .set({ scopeId: input.toCollaborationWorkspaceId, updatedAt: movedAt })
          .where(eq(configAssets.id, input.projectId));
        if (audience !== locked.project.audience) {
          await tx
            .update(projects)
            .set({ audience, audienceChangedAt: movedAt })
            .where(eq(projects.assetId, input.projectId));
        }
        // A grant named the project in the workspace it left: it ends with the move.
        const dropped = await tx
          .delete(permissionGrants)
          .where(
            and(
              eq(permissionGrants.clientInstanceId, input.clientInstanceId),
              eq(permissionGrants.scopeKind, "asset"),
              eq(permissionGrants.scopeId, input.projectId)
            )
          )
          .returning({ id: permissionGrants.id });
        await bumpAssetState(tx, input.clientInstanceId);
        return {
          project: await requireProjectIn(tx, {
            clientInstanceId: input.clientInstanceId,
            projectId: input.projectId
          }),
          conversationsMoved: movedIds.length,
          grantsDropped: dropped.length
        };
      });
    },
    claimProjectDeletion(input) {
      return db.transaction(async (tx) => {
        const chats = await lockProjectChats(tx, input.clientInstanceId, input.projectId);
        const locked = await lockActiveProject(tx, input);
        if (!locked) return { status: "not_claimed" as const };
        // A second statement, after the lock is held: a predicate in the locking statement
        // would be answered from the snapshot taken before the wait.
        if (input.idle) {
          const [due] = await tx
            .select({ id: configAssets.id })
            .from(configAssets)
            .innerJoin(projects, eq(projects.assetId, configAssets.id))
            .where(and(eq(configAssets.id, input.projectId), idleToDelete(input.idle)));
          if (!due) return { status: "not_claimed" as const };
        }
        await tx
          .update(configAssets)
          .set({ status: "deleted", updatedAt: new Date(input.deletedAt) })
          .where(eq(configAssets.id, input.projectId));
        // Every chat that still names it leaves it and keeps its visibility, a deleted one too.
        const left = await tx
          .update(conversations)
          .set({ projectId: null })
          .where(
            and(
              eq(conversations.clientInstanceId, input.clientInstanceId),
              eq(conversations.projectId, input.projectId)
            )
          )
          .returning({
            id: conversations.id,
            status: conversations.status,
            kind: conversations.kind
          });
        const active = left
          .filter((row) => row.status === "active" && row.kind === "chat")
          .map((row) => row.id);
        // The chats the person chose to delete are claimed in the same transaction, so a
        // cleanup that stops halfway leaves deleted chats for the conversation retry to finish,
        // never chats that outlive the choice. A chat that entered after its lock was taken is
        // kept: the choice was not about it.
        const locks = new Set(chats);
        const deleted = input.deleteConversations ? active.filter((id) => locks.has(id)) : [];
        for (const id of deleted) {
          await markLockedConversationTreeDeleted(tx, {
            clientInstanceId: asClientInstanceId(input.clientInstanceId),
            conversationId: asConversationId(id),
            deletedAt: input.deletedAt,
            status: "deleted"
          });
        }
        await bumpAssetState(tx, input.clientInstanceId);
        return {
          status: "claimed" as const,
          conversationIds: active.filter((id) => !deleted.includes(id)),
          deletedConversationIds: deleted
        };
      });
    },
    async listDeletedProjectIds(input) {
      const rows = await db
        .select({ id: configAssets.id })
        .from(configAssets)
        .where(
          and(
            eq(configAssets.clientInstanceId, input.clientInstanceId),
            eq(configAssets.kind, PROJECT_ASSET_KIND),
            eq(configAssets.status, "deleted")
          )
        )
        .orderBy(configAssets.updatedAt, configAssets.id)
        .limit(input.limit);
      return rows.map((row) => row.id);
    },
    async clearIdleNoticesAfterActivity(input) {
      const rows = await db
        .update(projects)
        .set({ idleNoticeAt: null })
        .where(
          and(
            eq(projects.clientInstanceId, input.clientInstanceId),
            isNotNull(projects.idleNoticeAt),
            exists(
              db
                .select({ id: configAssets.id })
                .from(configAssets)
                .where(
                  and(
                    eq(configAssets.id, projects.assetId),
                    sql`${lastActivity()} > ${projects.idleNoticeAt}`
                  )
                )
            )
          )
        )
        .returning({ id: projects.assetId });
      return rows.length;
    },
    async listProjectsToNotice(input) {
      return selectProjects(
        db,
        and(
          eq(configAssets.clientInstanceId, input.clientInstanceId),
          isNull(projects.idleNoticeAt),
          sql`${lastActivity()} <= ${input.idleBefore}::timestamptz`
        ),
        input.limit
      );
    },
    markIdleNotice(input) {
      return db.transaction(async (tx) => {
        if (!(await lockActiveProject(tx, input))) return false;
        // A second statement, after the lock: the criterion is read as it is now.
        const marked = await tx
          .update(projects)
          .set({ idleNoticeAt: new Date(input.noticedAt) })
          .where(
            and(
              eq(projects.assetId, input.projectId),
              isNull(projects.idleNoticeAt),
              exists(
                tx
                  .select({ id: configAssets.id })
                  .from(configAssets)
                  .where(
                    and(
                      eq(configAssets.id, projects.assetId),
                      sql`${lastActivity()} <= ${input.idleBefore}::timestamptz`
                    )
                  )
              )
            )
          )
          .returning({ id: projects.assetId });
        return marked.length > 0;
      });
    },
    async listIdleProjectsToDelete(input) {
      const rows = await db
        .select({ id: configAssets.id })
        .from(configAssets)
        .innerJoin(projects, eq(projects.assetId, configAssets.id))
        .where(
          and(
            eq(configAssets.clientInstanceId, input.clientInstanceId),
            eq(configAssets.kind, PROJECT_ASSET_KIND),
            eq(configAssets.status, "active"),
            idleToDelete(input)
          )
        )
        .orderBy(projects.idleNoticeAt, configAssets.id)
        .limit(input.limit);
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

async function selectProjects(
  db: PostgresConnection,
  where: SQL | undefined,
  limit?: number
): Promise<Project[]> {
  const query = db
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
  const rows = await (limit === undefined ? query : query.limit(limit));
  return rows.flatMap(({ asset, project, config }) => toProject(asset, project, config));
}

/** An active project of the workspace, after a write in the same transaction. */
async function requireProjectIn(
  tx: PostgresTransaction,
  input: { clientInstanceId: string; projectId: string }
): Promise<Project> {
  const [project] = await selectProjects(
    tx,
    and(
      eq(configAssets.clientInstanceId, input.clientInstanceId),
      eq(configAssets.id, input.projectId)
    )
  );
  if (!project) throw new AppError("NOT_FOUND", "Project is not available");
  return project;
}

function audienceChanged(): AppError {
  return new AppError(
    "CONFLICT",
    "Who reads the project changed meanwhile",
    { reason: "project_audience_changed" },
    { exposeMessage: true }
  );
}

/**
 * Locks an active project for a change of the whole project: its asset row, against a move or
 * a conversation entering it, and its audience row, against a file write. Answers its rows.
 */
async function lockActiveProject(
  tx: PostgresTransaction,
  input: { clientInstanceId: string; projectId: string; collaborationWorkspaceId?: string }
): Promise<{ project: typeof projects.$inferSelect } | undefined> {
  const [row] = await tx
    .select({ project: projects })
    .from(configAssets)
    .innerJoin(projects, eq(projects.assetId, configAssets.id))
    .where(
      and(
        eq(configAssets.clientInstanceId, input.clientInstanceId),
        eq(configAssets.id, input.projectId),
        eq(configAssets.kind, PROJECT_ASSET_KIND),
        eq(configAssets.status, "active"),
        eq(configAssets.scopeKind, "workspace"),
        input.collaborationWorkspaceId === undefined
          ? undefined
          : eq(configAssets.scopeId, input.collaborationWorkspaceId)
      )
    )
    .for("update", { of: [configAssets, projects] })
    .limit(1);
  return row;
}

/**
 * Locks the active chats of a project in id order. Every write that changes a chat's project
 * takes the chat's lock before the project's, so a change of the whole project takes them in
 * the same order and the two never wait for each other in a circle.
 */
async function lockProjectChats(
  tx: PostgresTransaction,
  clientInstanceId: string,
  projectId: string
): Promise<string[]> {
  const rows = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(projectChats(clientInstanceId, projectId))
    .orderBy(conversations.id)
    .for("update");
  return rows.map((row) => row.id);
}

/** The active chats of a project. */
function projectChats(clientInstanceId: string, projectId: string): SQL | undefined {
  return and(
    eq(conversations.clientInstanceId, clientInstanceId),
    eq(conversations.projectId, projectId),
    eq(conversations.status, "active"),
    eq(conversations.kind, "chat")
  );
}

/**
 * A chat that must stay private: it holds personal data, reads a Data Store a person added
 * (STORE-USE-1), or is about an asset. The same rules keep one chat out of a shared project.
 */
function keptPrivate(clientInstanceId: string): SQL {
  return sql`(${conversations.personalDataAt} is not null or ${conversations.subjectKind} is not null or exists (select 1 from ${conversationDataStores} where ${conversationDataStores.clientInstanceId} = ${clientInstanceId} and ${conversationDataStores.conversationId} = ${conversations.id}))`;
}

/** Refuses sharing a project while a chat in it must stay private. */
async function refuseKeptPrivate(
  tx: PostgresTransaction,
  clientInstanceId: string,
  projectId: string
): Promise<void> {
  const [kept] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(conversations)
    .where(and(projectChats(clientInstanceId, projectId), keptPrivate(clientInstanceId)));
  if (kept && kept.count > 0) {
    throw new AppError(
      "CONFLICT",
      "Chats in the project must stay private: they hold personal data, read a Data Store or are about an asset",
      { reason: "project_conversations_stay_private", conversations: kept.count },
      { exposeMessage: true }
    );
  }
  const files = await countFilesKeptPrivate(tx, clientInstanceId, projectId);
  if (files > 0) {
    throw new AppError(
      "CONFLICT",
      "Files in the project were written by a chat that must stay private, or by one that is gone; remove those files or their versions first",
      { reason: "project_files_stay_private", files },
      { exposeMessage: true }
    );
  }
}

/**
 * The files of a project with a kept version a chat wrote that must stay private, wherever that
 * chat is now, deleted too. A version whose chat is gone cannot be told apart and counts: what
 * it holds may have come from such a chat.
 */
async function countFilesKeptPrivate(
  tx: PostgresConnection | PostgresTransaction,
  clientInstanceId: string,
  projectId: string
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(distinct ${projectFileVersions.path})::int` })
    .from(projectFileVersions)
    .leftJoin(
      conversations,
      and(
        eq(conversations.clientInstanceId, clientInstanceId),
        eq(conversations.id, projectFileVersions.conversationId)
      )
    )
    .where(
      and(
        eq(projectFileVersions.clientInstanceId, clientInstanceId),
        eq(projectFileVersions.projectId, projectId),
        isNotNull(projectFileVersions.conversationId),
        isNotNull(projectFileVersions.objectKey),
        or(isNull(conversations.id), keptPrivate(clientInstanceId))
      )
    );
  return row?.count ?? 0;
}

/** Sets the visibility of a project's chats and of their run threads; counts the chats. */
async function setChatVisibility(
  tx: PostgresTransaction,
  input: { clientInstanceId: ClientInstanceId; projectId: string },
  visibility: ProjectAudience
): Promise<number> {
  const chats = await tx
    .update(conversations)
    .set({ visibility })
    .where(projectChats(input.clientInstanceId, input.projectId))
    .returning({ id: conversations.id });
  const ids = chats.map((row) => row.id);
  if (ids.length > 0) {
    await tx
      .update(conversations)
      .set({ visibility })
      .where(
        and(
          eq(conversations.clientInstanceId, input.clientInstanceId),
          eq(conversations.kind, "run_thread"),
          inArray(conversations.parentConversationId, ids)
        )
      );
  }
  return ids.length;
}

async function bumpAssetState(tx: PostgresTransaction, clientInstanceId: string): Promise<void> {
  await tx
    .update(configAssetState)
    .set({ version: sql`${configAssetState.version} + 1` })
    .where(eq(configAssetState.clientInstanceId, clientInstanceId));
}

/**
 * The latest activity of a project, read beside its asset and audience rows: a change to its
 * definition or audience, a chat in it, or a change to a file. A conversation's own retention
 * is not this: a chat in a project expires as every chat does.
 */
function lastActivity(): SQL {
  return sql`greatest(
    ${configAssets.createdAt},
    ${configAssets.updatedAt},
    (select ${projects.audienceChangedAt} from ${projects} where ${projects.assetId} = ${configAssets.id}),
    (select max(${conversations.updatedAt}) from ${conversations} where ${conversations.clientInstanceId} = ${configAssets.clientInstanceId} and ${conversations.projectId} = ${configAssets.id} and ${conversations.status} = 'active'),
    (select max(${projectFiles.updatedAt}) from ${projectFiles} where ${projectFiles.projectId} = ${configAssets.id})
  )`;
}

/**
 * The idle criterion of a deletion, one fragment for the list and the claim: noticed long
 * enough ago, idle long enough, and nothing happened since the notice.
 */
function idleToDelete(criterion: ProjectIdleCriterion): SQL | undefined {
  return and(
    isNotNull(projects.idleNoticeAt),
    sql`${projects.idleNoticeAt} <= ${criterion.noticedBefore}::timestamptz`,
    sql`${lastActivity()} <= ${criterion.idleBefore}::timestamptz`,
    sql`${lastActivity()} <= ${projects.idleNoticeAt}`
  );
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
      updatedAt: asset.updatedAt.toISOString(),
      ...(definition.data.defaultAgent ? { defaultAgent: definition.data.defaultAgent } : {}),
      ...(definition.data.skills?.length ? { skills: definition.data.skills } : {}),
      ...(definition.data.knowledgeBases?.length
        ? { knowledgeBases: definition.data.knowledgeBases }
        : {})
    }
  ];
}

/**
 * Locks an active project of the workspace against a change of its owner, its audience or its
 * removal until the transaction ends, and answers its audience. Nothing when there is none such.
 * A change of the audience locks the same row for update, so the two wait for each other; the
 * audience is read in a second statement once the lock is held, because the locking statement
 * answers the joined row from the snapshot taken before the wait.
 */
export async function lockWorkspaceProject(
  tx: PostgresTransaction,
  input: { clientInstanceId: string; projectId: string; collaborationWorkspaceId: string }
): Promise<Pick<Project, "audience" | "createdByUserId"> | undefined> {
  const [locked] = await tx
    .select({ id: configAssets.id })
    .from(configAssets)
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
    .for("share")
    .limit(1);
  if (!locked) return undefined;
  const [row] = await tx
    .select({ audience: projects.audience, createdByUserId: projects.createdByUserId })
    .from(projects)
    .where(eq(projects.assetId, input.projectId))
    .limit(1);
  return row;
}
