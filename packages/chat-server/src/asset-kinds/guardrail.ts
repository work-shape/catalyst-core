import { guardrailConfigSchema } from "@vivd-catalyst/config-schema";
import {
  AppError,
  GUARDRAIL_ACTIONS,
  GUARDRAIL_ASSET_KIND,
  GUARDRAIL_NAME_MAX_LENGTH,
  GUARDRAIL_NAME_PATTERN,
  GUARDRAIL_NAME_RULE,
  GUARDRAIL_READ_ONLY_REASON,
  defineAssetKind
} from "@vivd-catalyst/core";
import type { WorkflowAssetKind } from "./shared";

/**
 * The refusal of every write of a Guardrail through the asset operations. Until guardrails are
 * written as assets, release config defines them and the release seed alone writes them, to
 * the store and through no operation.
 */
function readOnly(): AppError {
  return new AppError(
    "FORBIDDEN",
    `${GUARDRAIL_READ_ONLY_REASON}: a Guardrail is defined in release config and is read-only here. Change it in release config`,
    { reason: GUARDRAIL_READ_ONLY_REASON }
  );
}

/**
 * The Guardrail kind: a check bound to a before-event, with the outcome of a hit. Build lists
 * it and shows its hits. It is no part of the release bundle and offered in no workspace list.
 */
export function createGuardrailAssetKind(): WorkflowAssetKind {
  return {
    ...defineAssetKind({
      kind: GUARDRAIL_ASSET_KIND,
      plural: "guardrails",
      schema: guardrailConfigSchema,
      nameRule: {
        pattern: GUARDRAIL_NAME_PATTERN,
        maxLength: GUARDRAIL_NAME_MAX_LENGTH,
        description: GUARDRAIL_NAME_RULE
      },
      actions: { ...GUARDRAIL_ACTIONS },
      // A Guardrail refers to no other asset: its model binding is release config's own.
      validate: () => [],
      validateWrite(context, guardrails) {
        if (guardrails.some((guardrail) => context.changes(GUARDRAIL_ASSET_KIND, guardrail.name))) {
          throw readOnly();
        }
        return [];
      },
      summarize: (guardrail) => ({
        name: guardrail.name,
        title: guardrail.displayName,
        ...(guardrail.description === undefined ? {} : { description: guardrail.description }),
        attributes: {
          event: guardrail.on,
          checkKind: guardrail.check.kind,
          outcome: guardrail.outcome,
          origin: guardrail.origin,
          ...(guardrail.filter?.kind === undefined ? {} : { appliesTo: guardrail.filter.kind }),
          ...(guardrail.filter?.operation === undefined
            ? {}
            : { operation: guardrail.filter.operation }),
          ...(guardrail.filter?.origin === undefined
            ? {}
            : { callOrigin: guardrail.filter.origin }),
          ...(guardrail.filter?.agent === undefined ? {} : { agent: guardrail.filter.agent })
        }
      })
    }),
    holdsInstanceDefault: false,
    hasWorkspaceAvailability: false,
    prepareInteractiveUpsert: ({ next }) => next,
    missingUpsertRight: () => undefined,
    assertStoredWritable() {
      throw readOnly();
    },
    assertInteractiveUpsertAllowed() {
      throw readOnly();
    },
    assertInteractiveDeleteAllowed() {
      throw readOnly();
    }
  };
}
