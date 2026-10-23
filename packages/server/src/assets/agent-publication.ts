import {
  AppError,
  asCollaborationWorkspaceId,
  auditActorFromIdentity,
  type AgentAvailability,
  type AgentProposal
} from "@work-shape/catalyst-core";
import type { AssetWorkflowOptions } from "../types";
import { transactionalAssetCall, type AssetCall } from "./asset-access";
import type { AssetTarget } from "./asset-target";
import { makeAgentDependenciesAvailable } from "./agent-dependency-availability";
import { authorizeInteractiveWrite } from "./asset-write-rules";
import { offersOnPublish } from "../approvals/agent-publish-review";

/**
 * Publish, explicit dependency availability and the first publish's offering share one lock,
 * transaction and audit store. The first publish of a workspace's agent that is offered nowhere
 * offers it in the shared workspace that owns it (WS-PUB-1b); offering it anywhere else stays an
 * instance admin's step.
 */
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
  const offers = await firstOffering(options, target);
  if (!consent.makeDependenciesAvailable && offers === undefined) return publish(options, call);
  const { expectedAvailability } = consent;
  if (consent.makeDependenciesAvailable && expectedAvailability === undefined)
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
    const called = transactionalAssetCall(call, options.clientInstanceId, stores.audit);
    if (consent.makeDependenciesAvailable) {
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
      await makeAgentDependenciesAvailable(within, called, draft.config, reviewed);
    }
    // The writer compares the live and draft revisions under the same lock again.
    const written = await publish(within, called);
    if (offers !== undefined) await offerInOwnWorkspace(within, called, target, offers);
    return written;
  });
}

/**
 * The shared workspace a publish of this agent offers it in: the one that owns it, where the
 * publish is its first and it is offered nowhere. Nothing for an instance's own agent, a later
 * publish or one owned by a Personal Workspace, which no availability names alone.
 */
async function firstOffering(
  options: AssetWorkflowOptions,
  target: AssetTarget
): Promise<string | undefined> {
  const { asset } = target;
  if (!asset || asset.status !== "active") return undefined;
  const availability = await options.configAssets.store.listAgentAvailability({
    clientInstanceId: options.clientInstanceId,
    agentName: asset.name
  });
  const workspaceId = offersOnPublish(asset, availability.get(asset.name));
  if (workspaceId === undefined) return undefined;
  const workspace = await options.stores.workspaces.getWorkspace(
    options.clientInstanceId,
    asCollaborationWorkspaceId(workspaceId)
  );
  return workspace?.kind === "shared" ? workspaceId : undefined;
}

/**
 * Offers the agent in its own workspace, under the lock of its publish, where it is still
 * offered nowhere: an availability somebody set meanwhile stays as they set it.
 */
async function offerInOwnWorkspace(
  within: AssetWorkflowOptions,
  call: AssetCall,
  target: AssetTarget,
  workspaceId: string
): Promise<void> {
  const { clientInstanceId } = within;
  const current = (
    await within.configAssets.store.listAgentAvailability({
      clientInstanceId,
      agentName: target.name
    })
  ).get(target.name);
  const nowhere =
    current === undefined ||
    (current.mode === "selected" &&
      !current.personalWorkspaces &&
      current.collaborationWorkspaceIds.length === 0);
  if (!nowhere) return;
  const availability = await within.configAssets.store.setAgentAvailability({
    clientInstanceId,
    agentName: target.name,
    kind: "agent",
    ...(target.asset ? { expectedAssetId: target.asset.id } : {}),
    expectedAvailability: current ?? null,
    availability: {
      mode: "selected",
      personalWorkspaces: false,
      collaborationWorkspaceIds: [asCollaborationWorkspaceId(workspaceId)]
    }
  });
  await call.audit.record({
    type: "config_asset.availability_set",
    status: "success",
    actor: auditActorFromIdentity(call.actor),
    correlationId: call.correlationId,
    metadata: {
      kind: "agent",
      name: target.name,
      mode: availability.mode,
      personalWorkspaces: availability.personalWorkspaces,
      collaborationWorkspaceIds: availability.collaborationWorkspaceIds,
      reason: "first_publish"
    }
  });
}
