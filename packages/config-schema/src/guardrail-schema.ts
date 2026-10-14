import { z } from "zod";
import {
  GUARDRAIL_APPROVAL_EVENTS,
  GUARDRAIL_CHECKABLE_FIELDS,
  GUARDRAIL_EVENTS,
  GUARDRAIL_FILTER_KEYS,
  GUARDRAIL_FILTER_ORIGINS,
  GUARDRAIL_NAME_MAX_LENGTH,
  GUARDRAIL_NAME_PATTERN,
  GUARDRAIL_NAME_RULE,
  GUARDRAIL_ORIGINS,
  GUARDRAIL_OUTCOMES,
  type GuardrailConfig,
  type GuardrailEvent
} from "@vivd-catalyst/core";
import { GUARDRAIL_PATTERN_MAX_CHARS, guardrailPatternError } from "./guardrail-pattern";

// A model reads the instruction on every check. Ten times the longest rule written so far; a
// longer one is refused at start with this name.
const GUARDRAIL_INSTRUCTION_MAX_CHARS = 8_000;
// What a person is told on a match. One or two sentences.
const GUARDRAIL_REASON_MAX_CHARS = 500;

export const guardrailNameSchema = z
  .string()
  .max(GUARDRAIL_NAME_MAX_LENGTH)
  .regex(GUARDRAIL_NAME_PATTERN, { message: GUARDRAIL_NAME_RULE });

const checkedFieldsSchema = z.array(z.string().trim().min(1)).min(1).optional();

const modelJudgeCheckSchema = z
  .object({
    kind: z.literal("model_judge"),
    modelBindingId: z.string().trim().min(1),
    instruction: z
      .string()
      .trim()
      .min(1)
      .max(GUARDRAIL_INSTRUCTION_MAX_CHARS, {
        message: `A guardrail's instruction has at most ${GUARDRAIL_INSTRUCTION_MAX_CHARS} characters (GUARDRAIL_INSTRUCTION_MAX_CHARS)`
      }),
    fields: checkedFieldsSchema
  })
  .strict();

const patternCheckSchema = z
  .object({
    kind: z.literal("pattern"),
    pattern: z
      .string()
      .min(1)
      .max(GUARDRAIL_PATTERN_MAX_CHARS, {
        message: `A guardrail's pattern has at most ${GUARDRAIL_PATTERN_MAX_CHARS} characters (GUARDRAIL_PATTERN_MAX_CHARS)`
      })
      .superRefine((pattern, context) => {
        const error = guardrailPatternError(pattern);
        if (error !== undefined) {
          context.addIssue({ code: "custom", message: error });
        }
      }),
    fields: checkedFieldsSchema,
    reason: z.string().trim().min(1).max(GUARDRAIL_REASON_MAX_CHARS).optional()
  })
  .strict();

const guardrailFields = {
  description: z.string().max(2000).optional(),
  on: z.enum(GUARDRAIL_EVENTS),
  filter: z
    .object({
      kind: z.string().trim().min(1).optional(),
      operation: z.string().trim().min(1).optional(),
      origin: z.enum(GUARDRAIL_FILTER_ORIGINS).optional(),
      agent: z.string().trim().min(1).optional(),
      workspace: z.string().trim().min(1).optional()
    })
    .strict()
    .optional(),
  check: z.discriminatedUnion("kind", [patternCheckSchema, modelJudgeCheckSchema]),
  outcome: z.enum(GUARDRAIL_OUTCOMES)
};

/**
 * What the shape alone does not say: a filter narrows only by what its event knows, a check
 * reads only fields its event has, and only an event where something can wait may hold it.
 */
function refineGuardrail(
  guardrail: {
    on: GuardrailEvent;
    filter?: Partial<Record<string, unknown>>;
    check: { fields?: string[] };
    outcome: string;
  },
  context: z.RefinementCtx
): void {
  const filterKeys: readonly string[] = GUARDRAIL_FILTER_KEYS[guardrail.on];
  for (const key of Object.keys(guardrail.filter ?? {})) {
    if (guardrail.filter?.[key] !== undefined && !filterKeys.includes(key)) {
      context.addIssue({
        code: "custom",
        path: ["filter", key],
        message: `A guardrail on '${guardrail.on}' cannot filter by '${key}'. It filters by ${listed(filterKeys)}`
      });
    }
  }
  const fields: readonly string[] = GUARDRAIL_CHECKABLE_FIELDS[guardrail.on];
  for (const [index, field] of (guardrail.check.fields ?? []).entries()) {
    if (!fields.includes(field)) {
      context.addIssue({
        code: "custom",
        path: ["check", "fields", index],
        message: `'${guardrail.on}' has no field '${field}' to check. It has ${listed(fields)}`
      });
    }
  }
  const approvalEvents: readonly string[] = GUARDRAIL_APPROVAL_EVENTS;
  if (guardrail.outcome === "require_approval" && !approvalEvents.includes(guardrail.on)) {
    context.addIssue({
      code: "custom",
      path: ["outcome"],
      message: `Nothing at '${guardrail.on}' can wait for an approval. The outcome 'require_approval' applies at ${listed(approvalEvents)}`
    });
  }
}

function listed(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

/**
 * One Guardrail of release config, `guardrails.<name>`. The start-up seed makes it an asset
 * with `origin: release`, read-only in the product. It is the operator's floor: a guardrail
 * written later as an asset adds a check and never removes one of these.
 */
export const releaseGuardrailConfigSchema = z
  .object({ displayName: z.string().trim().min(1).max(120).optional(), ...guardrailFields })
  .strict()
  .superRefine(refineGuardrail);

export const releaseGuardrailsConfigSchema = z
  .record(guardrailNameSchema, releaseGuardrailConfigSchema)
  .default({});

export type ReleaseGuardrailConfig = z.infer<typeof releaseGuardrailConfigSchema>;

/**
 * A Guardrail as a revision holds it. A definition written as an asset may leave `origin`
 * out: it is an `asset` one. Only the release seed writes `release`, and the kind refuses it
 * from every other writer.
 */
export const guardrailConfigSchema = z
  .object({
    name: guardrailNameSchema,
    displayName: z.string().trim().min(1).max(120),
    ...guardrailFields,
    origin: z.enum(GUARDRAIL_ORIGINS).default("asset")
  })
  .strict()
  .superRefine(refineGuardrail) satisfies z.ZodType<GuardrailConfig>;

/** The definition the release seed stores for one entry of release config. */
export function guardrailFromRelease(name: string, entry: ReleaseGuardrailConfig): GuardrailConfig {
  const { displayName, ...fields } = entry;
  return { name, displayName: displayName ?? name, ...fields, origin: "release" };
}
