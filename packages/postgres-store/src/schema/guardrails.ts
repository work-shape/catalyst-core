import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { GuardrailEvent, GuardrailHitOutcome } from "@vivd-catalyst/core";

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
