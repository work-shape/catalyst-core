import { AppError, type AgentAvailability, type AgentProposal } from "@work-shape/catalyst-core";
import type { AssetWorkflowOptions } from "../types";
import { transactionalAssetCall, type AssetCall } from "./asset-access";
import type { AssetTarget } from "./asset-target";
import { makeAgentDependenciesAvailable } from "./agent-dependency-availability";
import { authorizeInteractiveWrite } from "./asset-write-rules";

/** Publish and explicit dependency availability share one lock, transaction and audit store. */
export async function publishAgentDraft(
  options: AssetWorkflowOptions,
  call: AssetCall,
  target: AssetTarget,
  draft: AgentProposal,
  consent: { makeDependenciesAvailable?: boolean; expectedAvailability?: AgentAvailability | null },
  write: (options: AssetWorkflowOptions, call: AssetCall) => Promise<{ revision: number }>
): Promise<{ revision: number }> {
  const publish = async (within: AssetWorkflowOptions, called: AssetCall) => {
    await authorizeInteractiveWrite(
      within,
      called.actor,
      called,
      called.audit,
      draft.author.release
    );
    return write(within, called);
  };
  if (!consent.makeDependenciesAvailable) return publish(options, call);
  const { expectedAvailability } = consent;
  if (expectedAvailability === undefined)
    throw new AppError(
      "PRECONDITION_REQUIRED",
      "Read the agent's workspace availability again before making its dependencies available"
    );
  return options.stores.transaction(async (stores) => {
    const within = {
      ...options,
      stores,
      configAssets: { ...options.configAssets, store: stores.configAssets }
    };
    const availability = await stores.configAssets.listAgentAvailability({
      clientInstanceId: options.clientInstanceId,
      agentName: target.name
    });
    const reviewed = availability.get(target.name);
    if (reviewed)
      await stores.configAssets.setAgentAvailability({
        clientInstanceId: options.clientInstanceId,
        agentName: target.name,
        expectedAssetId: target.asset?.id,
        expectedAvailability,
        availability: reviewed
      });
    else if (expectedAvailability !== null)
      throw new AppError(
        "CONFLICT",
        "The agent's workspace availability changed. Read it again before publishing"
      );
    const called = transactionalAssetCall(call, options.clientInstanceId, stores.audit);
    await makeAgentDependenciesAvailable(within, called, draft.config, reviewed);
    // The writer compares the live and draft revisions under the same lock again.
    return publish(within, called);
  });
}
