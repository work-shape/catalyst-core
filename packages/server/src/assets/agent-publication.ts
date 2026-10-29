import {
  AppError,
  asCollaborationWorkspaceId,
  auditActorFromIdentity,
  type AgentAvailability,
  type AgentProposal
} from "@work-shape/catalyst-core";
import type { AssetWorkflowOptions } from "../types";
import {
  recordHandover,
  transactionalAssetCall,
  withoutHandover,
  type AssetCall
} from "./asset-access";
import type { AssetTarget } from "./asset-target";
import { makeAgentDependenciesAvailable } from "./agent-dependency-availability";
import { authorizeInteractiveWrite } from "./asset-write-rules";
import { firstOffering, firstVersionOffering } from "../approvals/agent-publish-review";

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
  const offers = await firstOffering(options, target.asset);
  // A hand-over the publish confirmed is recorded in its transaction (DS-13c).
  if (!consent.makeDependenciesAvailable && offers === undefined && !call.handover?.length)
    return publish(options, call);
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
          availability: reviewed,
          keepAwaitingFirstPublish: true
        });
      else if (expectedAvailability !== null)
        throw new AppError(
          "CONFLICT",
          "The agent's workspace availability changed. Read it again before publishing"
        );
      await makeAgentDependenciesAvailable(within, called, draft.config, reviewed);
    }
    // The writer compares the live and draft revisions under the same lock again.
    const written = await publish(within, withoutHandover(called));
    if (offers !== undefined) await offerInOwnWorkspace(within, called, target, offers);
    await recordHandover(called);
    return written;
  });
}

/**
 * The publish of a first version without a draft (access check 11): an agent made in a shared
 * workspace by someone who may not approve its publish starts offered nowhere, and its first
 * publish offers version 1 as it is stored in that workspace. Nothing where the publish is not
 * that one.
 */
export async function publishFirstVersion(
  options: AssetWorkflowOptions,
  call: AssetCall,
  target: AssetTarget,
  revision: number
): Promise<{ revision: number } | undefined> {
  const { asset } = target;
  const offers = await firstVersionOffering(options, asset, revision);
  if (!asset || offers === undefined) return undefined;
  await options.stores.transaction(async (stores) => {
    const within = {
      ...options,
      stores,
      configAssets: { ...options.configAssets, store: stores.configAssets }
    };
    const called = transactionalAssetCall(call, options.clientInstanceId, stores.audit);
    // Version 1 as it was checked: a revision written meanwhile refuses the offering.
    await offerInOwnWorkspace(within, called, target, offers, revision);
    await recordHandover(called);
  });
  return { revision: asset.revision };
}

/**
 * Offers the agent in its own workspace, under the lock of its publish, where it still awaits
 * its first publish: an availability somebody set meanwhile stays as they set it.
 */
async function offerInOwnWorkspace(
  within: AssetWorkflowOptions,
  call: AssetCall,
  target: AssetTarget,
  workspaceId: string,
  expectedRevision?: number
): Promise<void> {
  const { clientInstanceId } = within;
  const current = (
    await within.configAssets.store.listAgentAvailability({
      clientInstanceId,
      agentName: target.name
    })
  ).get(target.name);
  // Only while it awaits its first publish; the store compares that again under its lock.
  if (
    !(await within.configAssets.store.agentAwaitsFirstPublish({
      clientInstanceId,
      agentName: target.name
    }))
  )
    return;
  const availability = await within.configAssets.store.setAgentAvailability({
    clientInstanceId,
    agentName: target.name,
    kind: "agent",
    ...(target.asset ? { expectedAssetId: target.asset.id } : {}),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    expectedAvailability: current ?? null,
    expectAwaitingFirstPublish: true,
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
