import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp
} from "drizzle-orm/pg-core";
import type { ProjectAudience, ProjectFileOrigin } from "@work-shape/catalyst-core";
import { configAssets } from "./configAssets";

/**
 * Who reads a project (PRJ-1): its whole workspace or its creator alone. Beside the
 * definition, never in it: restoring a revision must not share or hide a project. The row
 * goes with its asset.
 */
export const projects = pgTable(
  "projects",
  {
    assetId: text("asset_id")
      .primaryKey()
      .references(() => configAssets.id, { onDelete: "cascade" }),
    clientInstanceId: text("client_instance_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    audience: text("audience").$type<ProjectAudience>().notNull(),
    audienceChangedAt: timestamp("audience_changed_at", { withTimezone: true }).notNull()
  },
  (table) => [check("projects_audience_check", sql`${table.audience} in ('workspace', 'private')`)]
);

const ORIGIN_CHECK = sql.raw("('person', 'agent', 'upload')");

/**
 * The files of a project as they are now (PRJ-2), one row per path. A row whose object is
 * null is a deleted file, kept with its versions until they go. The rows go with the project's
 * asset. No key reaches a conversation: a chat that goes leaves its versions behind.
 */
export const projectFiles = pgTable(
  "project_files",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => configAssets.id, { onDelete: "cascade" }),
    clientInstanceId: text("client_instance_id").notNull(),
    path: text("path").notNull(),
    currentVersion: integer("current_version").notNull(),
    /** Null: the current version is a deletion. */
    objectKey: text("object_key"),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    checksum: text("checksum"),
    mimeType: text("mime_type"),
    origin: text("origin").$type<ProjectFileOrigin>().notNull(),
    /** Null once the person is deleted: a former member. */
    updatedByUserId: text("updated_by_user_id"),
    conversationId: text("conversation_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => [
    primaryKey({ name: "project_files_pk", columns: [table.projectId, table.path] }),
    check("project_files_origin_check", sql`${table.origin} in ${ORIGIN_CHECK}`),
    check("project_files_version_check", sql`${table.currentVersion} > 0`),
    // A person's deletion clears the files they last wrote (forgetProjectFileAuthor).
    index("project_files_updated_by_idx")
      .on(table.clientInstanceId, table.updatedByUserId)
      .where(sql`${table.updatedByUserId} is not null`)
  ]
);

/**
 * Every kept version of a project file. A deletion is a version without an object. A move
 * renames the file's versions with it.
 */
export const projectFileVersions = pgTable(
  "project_file_versions",
  {
    projectId: text("project_id").notNull(),
    clientInstanceId: text("client_instance_id").notNull(),
    path: text("path").notNull(),
    version: integer("version").notNull(),
    objectKey: text("object_key"),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    checksum: text("checksum"),
    mimeType: text("mime_type"),
    origin: text("origin").$type<ProjectFileOrigin>().notNull(),
    byUserId: text("by_user_id"),
    conversationId: text("conversation_id"),
    runId: text("run_id"),
    at: timestamp("at", { withTimezone: true }).notNull()
  },
  (table) => [
    primaryKey({
      name: "project_file_versions_pk",
      columns: [table.projectId, table.path, table.version]
    }),
    foreignKey({
      name: "project_file_versions_file_fk",
      columns: [table.projectId, table.path],
      foreignColumns: [projectFiles.projectId, projectFiles.path]
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
    check("project_file_versions_origin_check", sql`${table.origin} in ${ORIGIN_CHECK}`),
    // A person's deletion clears them as author of every version (forgetProjectFileAuthor).
    index("project_file_versions_by_user_idx")
      .on(table.clientInstanceId, table.byUserId)
      .where(sql`${table.byUserId} is not null`)
  ]
);
