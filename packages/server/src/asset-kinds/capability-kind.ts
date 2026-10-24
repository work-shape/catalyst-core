import type { CapabilityAssetKind } from "@work-shape/catalyst-core";
import type { WorkflowAssetKind } from "./shared";

/**
 * A capability's kind as the asset workflow registers it. What the kind does not answer is
 * answered as for a kind with no default asset, no workspace availability, no references and
 * no editing policy of its own: an interactive save is taken as sent, and asks no right beside
 * the kind's own.
 */
export function workflowAssetKindOf(kind: CapabilityAssetKind): WorkflowAssetKind {
  return {
    holdsInstanceDefault: false,
    hasWorkspaceAvailability: false,
    references: () => [],
    prepareInteractiveUpsert: ({ next }) => next,
    missingUpsertRight: () => undefined,
    assertInteractiveUpsertAllowed: () => undefined,
    assertInteractiveDeleteAllowed: () => undefined,
    ...kind
  };
}
