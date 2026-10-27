import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";
import type {
  ClientInstanceId,
  ConversationId,
  FileSetFile,
  FileSetId,
  FileSetOwner,
  JsonObject,
  PageBuildId,
  PageBuildRequest,
  PageBuildResult,
  PageId,
  PreviewReport,
  UserId
} from "@work-shape/catalyst-core";
import { configAssets } from "./configAssets";
import { productUsers } from "./users";
import { conversations } from "./conversations";

/**
 * A Page of a conversation. The cascade is the last resort: a conversation's row is only
 * removed after its cleanup removed the Pages, because their rows lead to the stored objects.
 */
export const pages = pgTable(
  "pages",
  {
    id: text("id").$type<PageId>().primaryKey(),
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    conversationId: text("conversation_id")
      .$type<ConversationId>()
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull()
  },
  (table) => [
    uniqueIndex("pages_conversation_name_idx").on(
      table.clientInstanceId,
      table.conversationId,
      table.name
    )
  ]
);

/**
 * One immutable file set. Nothing updates a row: a save inserts a new one with a new id. The
 * owner is a Page or an asset and has no foreign key; whoever deletes an owner deletes its
 * file sets in the same transaction.
 */
export const fileSets = pgTable(
  "file_sets",
  {
    id: text("id").$type<FileSetId>().primaryKey(),
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    ownerKind: text("owner_kind").$type<FileSetOwner["kind"]>().notNull(),
    ownerId: text("owner_id").notNull(),
    number: integer("number").notNull(),
    kitVersion: text("kit_version").notNull(),
    manifest: jsonb("manifest").$type<JsonObject>().notNull(),
    // The file index: path, SHA-256, bytes and content type. The bytes are in the object store.
    sourceFiles: jsonb("source_files").$type<FileSetFile[]>().notNull(),
    builtFiles: jsonb("built_files").$type<FileSetFile[]>().notNull(),
    sourceFileCount: integer("source_file_count").notNull(),
    builtFileCount: integer("built_file_count").notNull(),
    totalBytes: integer("total_bytes").notNull(),
    createdByUserId: text("created_by_user_id").$type<UserId>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull()
  },
  (table) => [
    // Also what every read by owner uses: an owner's id is unique in the instance.
    uniqueIndex("file_sets_owner_number_idx").on(table.ownerKind, table.ownerId, table.number)
  ]
);

/**
 * One build a save asked for. The row is how the save and the job that builds find each other:
 * the save writes the request, the job writes the result, the save reads it and removes the
 * row. A row whose save never came back goes with a later save of its conversation or with the
 * conversation.
 */
export const pageBuilds = pgTable(
  "page_builds",
  {
    id: text("id").$type<PageBuildId>().primaryKey(),
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    // Empty for the build of an asset's files, which belongs to no conversation.
    conversationId: text("conversation_id")
      .$type<ConversationId>()
      .references(() => conversations.id, { onDelete: "cascade" }),
    request: jsonb("request").$type<PageBuildRequest>().notNull(),
    result: jsonb("result").$type<PageBuildResult>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true })
  },
  (table) => [index("page_builds_conversation_idx").on(table.conversationId, table.createdAt)]
);

/** Per-person preferences, independent of an App's revision; foreign keys own erasure. */
export const appUserStorage = pgTable(
  "app_user_storage",
  {
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    appId: text("app_id")
      .notNull()
      .references(() => configAssets.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .$type<UserId>()
      .notNull()
      .references(() => productUsers.id, { onDelete: "cascade" }),
    values: jsonb("values").$type<Record<string, string>>().notNull()
  },
  (table) => [primaryKey({ columns: [table.clientInstanceId, table.appId, table.userId] })]
);

/**
 * One person's allowance of one outside host for their own view of a draft (DRAFT-HOSTS-1):
 * an App's draft or a Page of a conversation that is no App yet. A row holds until the App is
 * published or its draft discarded, and goes with the App, the Page or the account. Whether it
 * still holds for the file set shown is decided where it is read: the host must be listed by
 * every file set of the owner since `file_set_number`.
 */
export const draftHostAllowances = pgTable(
  "draft_host_allowances",
  {
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    appId: text("app_id").references(() => configAssets.id, { onDelete: "cascade" }),
    pageId: text("page_id")
      .$type<PageId>()
      .references(() => pages.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .$type<UserId>()
      .notNull()
      .references(() => productUsers.id, { onDelete: "cascade" }),
    host: text("host").notNull(),
    // The owner's file set the host was allowed on. File sets count up per owner.
    fileSetNumber: integer("file_set_number").notNull(),
    allowedAt: timestamp("allowed_at", { withTimezone: true }).notNull()
  },
  (table) => [
    check(
      "draft_host_allowances_owner_check",
      sql`(${table.appId} is null) <> (${table.pageId} is null)`
    ),
    // A row of a Page has no App, and the other way round: each key is unique where it is set.
    uniqueIndex("draft_host_allowances_app_idx").on(table.appId, table.userId, table.host),
    uniqueIndex("draft_host_allowances_page_idx").on(table.pageId, table.userId, table.host),
    // The delete of an account finds its rows.
    index("draft_host_allowances_user_idx").on(table.userId)
  ]
);

/**
 * What a preview last reported of itself (PREVIEW-STATUS-1): one row per conversation and file
 * set, replaced by each report. Diagnostics, scrubbed and bounded before they are written. A
 * row is removed 24 hours after it was written, when the conversation is deleted or expires,
 * and with the conversation or the file set.
 */
export const previewReports = pgTable(
  "preview_reports",
  {
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    conversationId: text("conversation_id")
      .$type<ConversationId>()
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    fileSetId: text("file_set_id")
      .$type<FileSetId>()
      .notNull()
      .references(() => fileSets.id, { onDelete: "cascade" }),
    report: jsonb("report").$type<PreviewReport>().notNull(),
    reportedAt: timestamp("reported_at", { withTimezone: true }).notNull()
  },
  (table) => [
    primaryKey({
      name: "preview_reports_pk",
      columns: [table.conversationId, table.fileSetId]
    }),
    // The delete of a file set finds its rows.
    index("preview_reports_file_set_idx").on(table.fileSetId),
    // The hourly removal of rows past 24 hours.
    index("preview_reports_reported_at_idx").on(table.reportedAt)
  ]
);
