import { APPROVAL_CHECK_FAILURE_OUTCOMES } from "@work-shape/catalyst-asset-schemas";
import { z } from "zod";
import {
  AppError,
  GUARDRAIL_NAME_MAX_LENGTH,
  GUARDRAIL_NAME_PATTERN,
  GUARDRAIL_NAME_RULE
} from "@work-shape/catalyst-core";
import { invalidConfigError } from "./config-errors";
import type { ReleaseGuardrailConfig } from "./guardrail-schema";

const REMOVED_KEY = "approvalChecks";
const REPLACING_KEY = "guardrails";

export const APPROVAL_CHECKS_WITH_GUARDRAILS_REFUSAL =
  "'approvalChecks' was replaced by 'guardrails', and the config sets both. Move each approval check into 'guardrails' and remove 'approvalChecks'.";

const approvalCheckSchema = z.object({
  id: z.string().trim().min(1),
  appliesTo: z.string().trim().min(1),
  modelBindingId: z.string().trim().min(1),
  instruction: z.string().trim().min(1),
  onFail: z.enum(APPROVAL_CHECK_FAILURE_OUTCOMES)
});

/**
 * `approvalChecks` became `guardrails`. For one transition release a config that still has the
 * old key loads as if each check were the guardrail it became: the check's id is the
 * guardrail's name, it is bound to `approval_request.before_create` with the request kind it
 * applied to as filter, and judged by the same model with the same instruction. A config with
 * both keys is refused, because which one is meant cannot be told.
 *
 * Delete this file and its two callers in the release after the transition release, which
 * refuses the old key instead.
 */
export function withApprovalChecksAsGuardrails(input: unknown): unknown {
  if (!isRecord(input) || !(REMOVED_KEY in input)) {
    return input;
  }
  const { [REMOVED_KEY]: removed, ...rest } = input;
  if (REPLACING_KEY in rest) {
    throw new AppError("VALIDATION_FAILED", APPROVAL_CHECKS_WITH_GUARDRAILS_REFUSAL, {
      issues: [{ path: [REMOVED_KEY], message: APPROVAL_CHECKS_WITH_GUARDRAILS_REFUSAL }]
    });
  }
  const parsed = z.array(approvalCheckSchema).safeParse(removed);
  if (!parsed.success) {
    throw invalidConfigError(
      "Client instance config is invalid",
      parsed.error.issues.map((issue) => ({ ...issue, path: [REMOVED_KEY, ...issue.path] }))
    );
  }
  const guardrails: Record<string, ReleaseGuardrailConfig> = {};
  for (const [index, check] of parsed.data.entries()) {
    const path = [REMOVED_KEY, index, "id"];
    if (!GUARDRAIL_NAME_PATTERN.test(check.id) || check.id.length > GUARDRAIL_NAME_MAX_LENGTH) {
      throw invalidConfigError("Client instance config is invalid", [
        {
          path,
          message: `The approval check '${check.id}' becomes the guardrail of that name, which it cannot be. ${GUARDRAIL_NAME_RULE}, at most ${GUARDRAIL_NAME_MAX_LENGTH} characters. Move the check into 'guardrails' under a name that fits`
        }
      ]);
    }
    if (Object.hasOwn(guardrails, check.id)) {
      throw invalidConfigError("Client instance config is invalid", [
        { path, message: `Duplicate approval check id '${check.id}'` }
      ]);
    }
    guardrails[check.id] = {
      on: "approval_request.before_create",
      filter: { kind: check.appliesTo },
      check: {
        kind: "model_judge",
        modelBindingId: check.modelBindingId,
        instruction: check.instruction
      },
      outcome: check.onFail
    };
  }
  return { ...rest, [REPLACING_KEY]: guardrails };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
