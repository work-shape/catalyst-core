import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { ProjectAudience } from "@work-shape/catalyst-core";
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
