import { z } from "zod";
import { timestampSchema } from "../shared";
import { defineRegisteredOperation, json } from "./define-operation";

// What a Guardrail's page reads beyond the asset itself: the times it warned or blocked, and how
// often. The asset, with its event, check and outcome, is read through `assets.get`. A hit names
// no person: hits are counted by rule and period, never listed by person (works-council
// co-determination, §87(1) no. 6 BetrVG). Who made a request is in the audit log.

/** How many hits one read answers: the newest ones. The page says that older ones exist. */
export const GUARDRAIL_HITS_LIMIT = 50;

export const guardrailHitSchema = z.object({
  id: z.string(),
  /** The before-event the guardrail answered at, such as `approval_request.before_create`. */
  event: z.string(),
  outcome: z.enum(["warn", "block"]),
  /** The guardrail's reason, one sentence. Empty where the check could not run and it warned. */
  message: z.string(),
  /** What was checked: for an approval request its kind, such as `skill_change`. */
  subjectKind: z.string(),
  createdAt: timestampSchema
});

/** How often the guardrail warned or blocked, by the instance's clock. */
export const guardrailHitCountsSchema = z.object({
  last7Days: z.number().int().nonnegative(),
  last30Days: z.number().int().nonnegative()
});

export const guardrailHitsSchema = z.object({
  items: z.array(guardrailHitSchema),
  /** More hits exist than this answer holds. */
  hasMore: z.boolean(),
  counts: guardrailHitCountsSchema
});

export type GuardrailHitView = z.infer<typeof guardrailHitSchema>;
export type GuardrailHits = z.infer<typeof guardrailHitsSchema>;

// The right is the Guardrail's own (`guardrail.read`) and is decided on the Guardrail the call
// names, so `requires` names none.
export const guardrailOperations = {
  "guardrails.list_hits": defineRegisteredOperation({
    id: "guardrails.list_hits",
    method: "GET",
    path: "/api/v1/guardrails/:name/hits",
    summary: "List the newest times one Guardrail warned or blocked, and count them by period",
    tag: "Guardrails",
    auth: "principal",
    scope: "config_assets:read",
    requires: [],
    effect: "reading",
    response: json(guardrailHitsSchema),
    errors: ["NOT_FOUND"],
    rateClass: "read"
  })
} as const;
