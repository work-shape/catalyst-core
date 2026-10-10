import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";
import type {
  CollaborationWorkspace,
  Conversation,
  WorkspaceMembership
} from "@vivd-catalyst/core";
import { productUsers } from "./users";

export const collaborationWorkspaces = pgTable(
  "collaboration_workspaces",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    kind: text("kind").$type<CollaborationWorkspace["kind"]>().notNull(),
    name: text("name").notNull(),
    description: text("description"),
    visibility: text("visibility").$type<CollaborationWorkspace["visibility"]>().notNull(),
    defaultConversationVisibility: text("default_conversation_visibility")
      .$type<Conversation["visibility"]>()
      .notNull()
      .default("workspace"),
    emoji: text("emoji"),
    accentColor: text("accent_color").$type<CollaborationWorkspace["accentColor"]>(),
    personalUserId: text("personal_user_id"),
    /** Set when the deletion of the workspace was accepted. It is closed from then on. */
    deletionRequestedAt: timestamp("deletion_requested_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => [
    uniqueIndex("collaboration_workspaces_client_id_idx").on(table.clientInstanceId, table.id),
    uniqueIndex("collaboration_workspaces_personal_user_idx")
      .on(table.clientInstanceId, table.personalUserId)
      .where(sql`${table.kind} = 'personal'`),
    foreignKey({
      name: "collaboration_workspaces_personal_user_fk",
      columns: [table.clientInstanceId, table.personalUserId],
      foreignColumns: [productUsers.clientInstanceId, productUsers.id]
    }).onDelete("restrict"),
    check(
      "collaboration_workspaces_personal_kind_check",
      sql`(${table.kind} = 'personal') = (${table.personalUserId} is not null)`
    ),
    check(
      "collaboration_workspaces_personal_visibility_check",
      sql`${table.kind} <> 'personal' or ${table.visibility} = 'private'`
    ),
    check(
      "collaboration_workspaces_personal_conversation_visibility_check",
      sql`${table.kind} <> 'personal' or ${table.defaultConversationVisibility} = 'workspace'`
    )
  ]
);

export const collaborationWorkspaceMemberships = pgTable(
  "collaboration_workspace_memberships",
  {
    collaborationWorkspaceId: text("collaboration_workspace_id").notNull(),
    clientInstanceId: text("client_instance_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").$type<WorkspaceMembership["role"]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => [
    primaryKey({
      name: "collaboration_workspace_memberships_pk",
      columns: [table.collaborationWorkspaceId, table.userId]
    }),
    foreignKey({
      name: "collaboration_workspace_memberships_workspace_fk",
      columns: [table.clientInstanceId, table.collaborationWorkspaceId],
      foreignColumns: [collaborationWorkspaces.clientInstanceId, collaborationWorkspaces.id]
    }).onDelete("cascade"),
    foreignKey({
      name: "collaboration_workspace_memberships_user_fk",
      columns: [table.clientInstanceId, table.userId],
      foreignColumns: [productUsers.clientInstanceId, productUsers.id]
    }).onDelete("restrict"),
    index("collaboration_workspace_memberships_user_idx").on(table.clientInstanceId, table.userId)
  ]
);

export const collaborationWorkspaceAccessRequests = pgTable(
  "collaboration_workspace_access_requests",
  {
    id: text("id").primaryKey(),
    collaborationWorkspaceId: text("collaboration_workspace_id").notNull(),
    clientInstanceId: text("client_instance_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull()
  },
  (table) => [
    uniqueIndex("collaboration_workspace_access_requests_workspace_user_idx").on(
      table.collaborationWorkspaceId,
      table.userId
    ),
    foreignKey({
      name: "collaboration_workspace_access_requests_workspace_fk",
      columns: [table.clientInstanceId, table.collaborationWorkspaceId],
      foreignColumns: [collaborationWorkspaces.clientInstanceId, collaborationWorkspaces.id]
    }).onDelete("cascade"),
    foreignKey({
      name: "collaboration_workspace_access_requests_user_fk",
      columns: [table.clientInstanceId, table.userId],
      foreignColumns: [productUsers.clientInstanceId, productUsers.id]
    }).onDelete("cascade"),
    index("collaboration_workspace_access_requests_workspace_idx").on(
      table.clientInstanceId,
      table.collaborationWorkspaceId
    )
  ]
);
