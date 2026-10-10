import { integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type {
  ClientInstanceId,
  ConversationId,
  FileSetFile,
  FileSetId,
  FileSetOwner,
  JsonObject,
  PageId,
  UserId
} from "@vivd-catalyst/core";
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
 * owner has no foreign key, because S3-40 adds a second kind of owner; whoever deletes an
 * owner deletes its file sets in the same transaction.
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
