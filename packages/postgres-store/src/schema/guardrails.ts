import { boolean, index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import type { GuardrailEvent, GuardrailHitOutcome } from "@work-shape/catalyst-core";

/**
 * One time a guardrail warned, held or blocked. A row names what was checked, by kind, id and
 * name, never its content and never the person: who acted is in the audit log. Rows older than the
 * audit retention are deleted with the audit events. A guardrail that leaves release config
 * keeps its rows until then.
 */
export const guardrailHits = pgTable(
  "guardrail_hits",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    guardrailName: text("guardrail_name").notNull(),
    event: text("event").$type<GuardrailEvent>().notNull(),
    outcome: text("outcome").$type<GuardrailHitOutcome>().notNull(),
    message: text("message").notNull(),
    subjectKind: text("subject_kind").notNull(),
    // The asset's id and the asset's or the operation's name, where the subject has them; never
    // a run's id, which names the person who acted. Hits written before GR-2 have neither.
    subjectId: text("subject_id"),
    subjectName: text("subject_name"),
    // `require_approval` where the guardrail asked for an approval the action could not wait
    // for, and the hit is the block it was answered as. Null on every other hit.
    convertedFrom: text("converted_from").$type<"require_approval">(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    // The newest hits of one guardrail, read backwards.
    index("guardrail_hits_client_guardrail_created_idx").on(
      table.clientInstanceId,
      table.guardrailName,
      table.createdAt,
      table.id
    )
  ]
);

/**
 * A shipped guardrail somebody switched, and who did it last. A shipped guardrail without a
 * row is on: it is on on every instance, existing ones included, from the release that ships
 * it. A release never writes a row, so what an instance admin switched off stays off.
 */
export const shippedGuardrailSwitches = pgTable(
  "shipped_guardrail_switches",
  {
    clientInstanceId: text("client_instance_id").notNull(),
    guardrailName: text("guardrail_name").notNull(),
    enabled: boolean("enabled").notNull(),
    switchedById: text("switched_by_id").notNull(),
    switchedByLabel: text("switched_by_label").notNull(),
    switchedAt: timestamp("switched_at", { withTimezone: true }).notNull()
  },
  (table) => [
    primaryKey({
      name: "shipped_guardrail_switches_pk",
      columns: [table.clientInstanceId, table.guardrailName]
    })
  ]
);
