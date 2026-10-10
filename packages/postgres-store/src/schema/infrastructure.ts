import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { ClientInstanceId, InfrastructureCheckOutcome } from "@vivd-catalyst/core";

/**
 * One row per instance: the last check outcome of each of its providers, by the provider's id,
 * and when a person last started a check. `stores/infrastructure.ts` holds the only code that
 * reads or writes it. It holds no config and no secret: an id, a time and a class of failure.
 */
export const infrastructureCheckState = pgTable("infrastructure_check_state", {
  clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().primaryKey(),
  outcomes: jsonb("outcomes").$type<Record<string, InfrastructureCheckOutcome>>().notNull(),
  manualCheckAt: timestamp("manual_check_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});
