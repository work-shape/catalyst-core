import { GUARDRAIL_CHECK_KINDS, GUARDRAIL_OUTCOMES } from "@work-shape/catalyst-asset-schemas";
import { z } from "zod";
import { timestampSchema } from "./shared";

// What a person is shown of a guardrail where they act (GR-3), and the read-only list of the
// rules in force for them. Spec: events-workflows-and-guardrails.md, What a stopped person sees.

const guardrailScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("instance") }),
  z.object({ kind: z.literal("workspace"), workspaceId: z.string() })
]);

/** Where a guardrail comes from: the operator's floor, the release's switch, or a published asset. */
export const GUARDRAIL_ANSWER_ORIGINS = ["release", "shipped", "asset"] as const;

/**
 * One guardrail's answer as the person who acted is shown it: which guardrail, what it did and
 * why, and where it belongs. Who can change it is read from Rules in force when it is shown.
 */
export const guardrailAnswerRefSchema = z.object({
  name: z.string(),
  title: z.string(),
  outcome: z.enum(GUARDRAIL_OUTCOMES),
  reason: z.string().optional(),
  origin: z.enum(GUARDRAIL_ANSWER_ORIGINS),
  scope: guardrailScopeSchema.optional(),
  revision: z.number().int().positive().optional(),
  /** A `require_approval` answered as a block, because the action could not wait. */
  approvalCannotWait: z.literal(true).optional()
});

export type GuardrailAnswerRefView = z.infer<typeof guardrailAnswerRefSchema>;

/**
 * One rule in force for the viewer. People are named only where the viewer may see them: their
 * co-members of a shared workspace, themselves, and everyone for a holder of the people right.
 * Hits are a count, never who was stopped or what.
 */
export const ruleInForceSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  /** The reason a person it stops is told, where the rule words one. Empty where a model words it. */
  reason: z.string(),
  /** The before-events it is bound to, such as `operation.before_call`. */
  on: z.array(z.string()),
  /** What its filter narrows by: kind, operation, origin, agent, workspace. */
  filter: z.record(z.string(), z.string()).optional(),
  checkKind: z.enum(GUARDRAIL_CHECK_KINDS).optional(),
  outcome: z.enum(GUARDRAIL_OUTCOMES),
  origin: z.enum(GUARDRAIL_ANSWER_ORIGINS),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("instance") }),
    z.object({
      kind: z.literal("workspace"),
      workspaceId: z.string(),
      workspaceName: z.string().optional()
    })
  ]),
  /** The published revision of a guardrail written as an asset. */
  revision: z.number().int().positive().optional(),
  /** A shipped guardrail: whether it is switched on, and whether it asks on every publish. */
  enabled: z.boolean().optional(),
  alwaysAsk: z.boolean().optional(),
  /**
   * Who published the revision, or switched the shipped guardrail last, and when. The name is
   * left out where the viewer may not see it; `changedByHidden` then says somebody did.
   */
  changedBy: z.string().optional(),
  changedByHidden: z.literal(true).optional(),
  changedAt: timestampSchema.optional(),
  /**
   * Who can change it, by the names the viewer may see: holders of `guardrail.publish` at its
   * scope. Empty for the floor, which the operator sets, and where the viewer may see none.
   */
  changers: z.array(z.string()),
  /** Whether the viewer can ask who can change it from here: never for the floor. */
  askable: z.boolean(),
  /** How often it warned, held or blocked in the last 30 days. A count, never who. */
  hitsLast30Days: z.number().int().nonnegative()
});

export const rulesInForceSchema = z.object({
  items: z.array(ruleInForceSchema),
  /**
   * An admin for all workspaces the help texts of the instance name, where one is active: the
   * person to ask where no holder of a rule's scope is shown.
   */
  instanceAdmin: z.string().optional()
});

export const askGuardrailRequestSchema = z
  .object({
    /** The person's question, in their words. It goes to the Inbox of who can change the rule. */
    text: z.string().trim().min(1).max(1000)
  })
  .strict();

export const askGuardrailResponseSchema = z.object({
  /** How many people got the question in their Inbox. */
  addressees: z.number().int().positive()
});

export type RuleInForceView = z.infer<typeof ruleInForceSchema>;
export type RulesInForceView = z.infer<typeof rulesInForceSchema>;
