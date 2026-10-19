import { sql } from "drizzle-orm";
import { check, jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import type { ScopeAssignmentInput } from "@work-shape/catalyst-core";

/** Assignments have the same instance and holder boundary as rights. No row payload is audited. */
export const scopeAssignments = pgTable(
  "scope_assignments",
  {
    clientInstanceId: text("client_instance_id").notNull(),
    dimension: text("dimension").notNull(),
    holderKind: text("holder_kind").$type<ScopeAssignmentInput["holderKind"]>().notNull(),
    holderId: text("holder_id").notNull(),
    effect: text("effect").$type<ScopeAssignmentInput["effect"]>().notNull(),
    values: jsonb("values").$type<ScopeAssignmentInput["values"]>().notNull()
  },
  (table) => [
    primaryKey({
      name: "scope_assignments_pk",
      columns: [
        table.clientInstanceId,
        table.holderKind,
        table.holderId,
        table.dimension,
        table.effect
      ]
    }),
    check(
      "scope_assignments_holder_kind",
      sql`${table.holderKind} in ('user', 'group', 'service_principal')`
    ),
    check("scope_assignments_effect", sql`${table.effect} in ('allow', 'deny')`),
    check(
      "scope_assignments_values",
      sql`jsonb_typeof(${table.values}) = 'array' or ${table.values} = '"all"'::jsonb`
    )
  ]
);
