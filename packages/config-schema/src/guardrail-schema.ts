import { z } from "zod";
import {
  GUARDRAIL_EVENTS,
  GUARDRAIL_NAME_MAX_LENGTH,
  GUARDRAIL_NAME_PATTERN,
  GUARDRAIL_NAME_RULE,
  GUARDRAIL_OUTCOMES,
  type GuardrailConfig
} from "@vivd-catalyst/core";

// A model reads the instruction on every check. Ten times the longest rule written so far; a
// longer one is refused at start with this name.
const GUARDRAIL_INSTRUCTION_MAX_CHARS = 8_000;

export const guardrailNameSchema = z
  .string()
  .max(GUARDRAIL_NAME_MAX_LENGTH)
  .regex(GUARDRAIL_NAME_PATTERN, { message: GUARDRAIL_NAME_RULE });

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
      })
  })
  .strict();

const guardrailFields = {
  description: z.string().max(2000).optional(),
  on: z.enum(GUARDRAIL_EVENTS),
  filter: z
    .object({ kind: z.string().trim().min(1).optional() })
    .strict()
    .optional(),
  check: z.discriminatedUnion("kind", [modelJudgeCheckSchema]),
  outcome: z.enum(GUARDRAIL_OUTCOMES)
};

/**
 * One Guardrail of release config, `guardrails.<name>`. The start-up seed makes it an asset
 * with `origin: release`, read-only in the product. It is the operator's floor: a guardrail
 * written later as an asset adds a check and never removes one of these.
 */
export const releaseGuardrailConfigSchema = z
  .object({ displayName: z.string().trim().min(1).max(120).optional(), ...guardrailFields })
  .strict();

export const releaseGuardrailsConfigSchema = z
  .record(guardrailNameSchema, releaseGuardrailConfigSchema)
  .default({});

export type ReleaseGuardrailConfig = z.infer<typeof releaseGuardrailConfigSchema>;

/** A Guardrail as a revision holds it. */
export const guardrailConfigSchema = z
  .object({
    name: guardrailNameSchema,
    displayName: z.string().trim().min(1).max(120),
    ...guardrailFields,
    origin: z.literal("release")
  })
  .strict() satisfies z.ZodType<GuardrailConfig>;

/** The definition the release seed stores for one entry of release config. */
export function guardrailFromRelease(name: string, entry: ReleaseGuardrailConfig): GuardrailConfig {
  const { displayName, ...fields } = entry;
  return { name, displayName: displayName ?? name, ...fields, origin: "release" };
}
