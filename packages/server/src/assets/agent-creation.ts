import {
  AppError,
  asCollaborationWorkspaceId,
  type AgentAvailability
} from "@work-shape/catalyst-core";
import { configValuesEqual } from "../asset-kinds/shared";
import type { AssetWorkflowOptions } from "../types";
import {
  recordHandover,
  transactionalAssetCall,
  withoutHandover,
  type AssetCall
} from "./asset-access";
import { makeAgentDependenciesAvailable } from "./agent-dependency-availability";

/** Create and explicitly extend dependencies in one transaction, so either both happen or neither. */
export async function createAgentWithDependencies<T>(
  options: AssetWorkflowOptions,
  call: AssetCall,
  input: {
    config?: Record<string, unknown>;
    kind: string;
    name: string;
    expectedAvailability?: Omit<AgentAvailability, "collaborationWorkspaceIds"> & {
      collaborationWorkspaceIds: string[];
    };
  },
  create: (within: AssetWorkflowOptions, called: AssetCall) => Promise<T>
): Promise<T> {
  if (input.kind !== "agent" || input.config === undefined)
    throw new AppError(
      "VALIDATION_FAILED",
      "Dependency availability is only set when creating an agent"
    );
  return options.stores.transaction(async (stores) => {
    const within = {
      ...options,
      stores,
      configAssets: { ...options.configAssets, store: stores.configAssets }
    };
    const existing = await stores.configAssets.getConfigAsset({
      clientInstanceId: options.clientInstanceId,
      kind: "agent",
      name: input.name
    });
    if (existing?.status === "active")
      throw new AppError(
        "VALIDATION_FAILED",
        "Set an existing agent's dependency availability when saving availability or publishing"
      );
    const called = transactionalAssetCall(call, options.clientInstanceId, stores.audit);
    if (input.expectedAvailability === undefined)
      throw new AppError(
        "PRECONDITION_REQUIRED",
        "Review the new agent's workspace availability before making its dependencies available",
        { reason: "dependency_availability_review_required" }
      );
    await makeAgentDependenciesAvailable(within, called, input.config, {
      ...input.expectedAvailability,
      collaborationWorkspaceIds: input.expectedAvailability.collaborationWorkspaceIds.map(
        asCollaborationWorkspaceId
      )
    });
    // Widen first inside this transaction so the create's warnings reflect the consent.
    const result = await create(within, withoutHandover(called));
    await recordHandover(called);
    const availability = await stores.configAssets.listAgentAvailability({
      clientInstanceId: options.clientInstanceId,
      agentName: input.name
    });
    if (!configValuesEqual(availability.get(input.name), input.expectedAvailability))
      throw new AppError(
        "CONFLICT",
        "The new agent's workspace availability differs from the review. Review it again before creating the agent",
        { reason: "dependency_availability_changed" }
      );
    return result;
  });
}
