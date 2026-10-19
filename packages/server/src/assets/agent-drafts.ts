import {
  AppError,
  moduleOffError,
  asUserId,
  asCollaborationWorkspaceId,
  getSubjectUserId,
  isAuthenticatedServicePrincipal,
  type AgentDraftAuthor,
  type AgentAvailability,
  type AgentProposal,
  type OperationAuthorization
} from "@work-shape/catalyst-core";
import type { AssetWorkflowOptions } from "../types";
import {
  agentDependencyAvailability,
  authorizeAgentDependencies
} from "./agent-dependency-availability";
import { decide, type AssetCall } from "./asset-access";
import { requireActive, type AssetAddress, type AssetTarget } from "./asset-target";

/** Attribution survives deletion of the person and Build conversation. */
export function agentDraftAuthor(call: AssetCall, release = false): AgentDraftAuthor {
  return {
    ...(!isAuthenticatedServicePrincipal(call.actor)
      ? { userId: asUserId(getSubjectUserId(call.actor)) }
      : {}),
    ...(call.buildConversationId ? { conversationId: call.buildConversationId } : {}),
    release
  };
}

interface DraftHost {
  target(address: AssetAddress): Promise<AssetTarget>;
  publish(
    call: AssetCall,
    target: AssetTarget,
    draft: AgentProposal,
    makeDependenciesAvailable?: boolean,
    expectedAvailability?: AgentAvailability | null
  ): Promise<{ revision: number }>;
}

/** Reads and decisions of the one draft per agent. Writes use the ordinary asset validator. */
export class AgentDraftWorkflow {
  constructor(
    private readonly options: AssetWorkflowOptions,
    private readonly host: DraftHost
  ) {}

  async authorize(
    access: AssetCall["access"],
    input: { name: string; workspaceId?: string }
  ): Promise<OperationAuthorization> {
    const target = await this.host.target({ ...input, kind: "agent" });
    // Hide the draft, including its existence, from anyone without its write right.
    if (!access.authorize("agent.write", target.resource).allowed)
      throw new AppError("NOT_FOUND", "The agent draft is not available");
    return { allowed: true };
  }

  async get(call: AssetCall, input: { name: string; workspaceId?: string }) {
    await this.authorize(call.access, input);
    const target = await this.host.target({ ...input, kind: "agent" });
    const live = requireActive(target);
    const draft = await this.pending(live.id);
    return draft
      ? {
          agent: live.name,
          revision: draft.revision,
          baseRevision: draft.baseRevision,
          liveRevision: live.revision,
          stale: draft.baseRevision !== live.revision,
          config: draft.config,
          dependencyAvailability: await agentDependencyAvailability(
            this.options,
            call,
            draft.config,
            (
              await this.options.configAssets.store.listAgentAvailability({
                clientInstanceId: this.options.clientInstanceId,
                agentName: live.name
              })
            ).get(live.name)
          ),
          author: await this.namedAuthor(draft.author),
          updatedAt: draft.updatedAt
        }
      : null;
  }

  /**
   * The author with the name people read for them, so the agent page can say who wrote the
   * draft. Only a holder of the agent's write right reads it. A person who is gone has no name.
   */
  private async namedAuthor(
    author: AgentDraftAuthor
  ): Promise<AgentDraftAuthor & { name?: string }> {
    if (author.userId === undefined) return author;
    const user = await this.options.stores.users.getUser({
      clientInstanceId: this.options.clientInstanceId,
      userId: author.userId
    });
    return user ? { ...author, name: user.displayLabel } : author;
  }

  async authorizePublish(
    call: AssetCall,
    input: AssetAddress & { makeDependenciesAvailable?: boolean }
  ): Promise<OperationAuthorization> {
    const target = await this.host.target(input);
    if (isAuthenticatedServicePrincipal(call.actor))
      return { allowed: false, action: "agent.publish", reason: "user_only" };
    const decision = decide(call.access, "agent.publish", target.resource);
    if (!decision.allowed) return decision;
    // Only an authorized publisher may learn whether release provenance opens this path.
    const draft = target.asset ? await this.pending(target.asset.id) : undefined;
    if (!this.options.modules.isEnabled("assetManagement") && !draft?.author.release)
      throw moduleOffError("assetManagement");
    if (input.makeDependenciesAvailable && draft) {
      const availability = await this.options.configAssets.store.listAgentAvailability({
        clientInstanceId: this.options.clientInstanceId,
        agentName: input.name
      });
      return authorizeAgentDependencies(
        this.options,
        call.access,
        draft.config,
        availability.get(input.name)
      );
    }
    return decision;
  }

  async publish(
    call: AssetCall,
    input: AssetAddress & {
      revision: number;
      makeDependenciesAvailable?: boolean;
      expectedAvailability?: {
        mode: AgentAvailability["mode"];
        personalWorkspaces: boolean;
        collaborationWorkspaceIds: string[];
      } | null;
    }
  ) {
    const target = await this.host.target(input);
    if (isAuthenticatedServicePrincipal(call.actor))
      throw new AppError("FORBIDDEN", "A service principal cannot publish an agent");
    call.access.require("agent.publish", target.resource);
    const live = requireActive(target);
    const draft = await this.pending(live.id);
    if (draft?.revision !== input.revision)
      throw new AppError(
        "REVISION_CONFLICT",
        "The agent draft changed. Read it again before publishing",
        { reason: "draft_changed" }
      );
    if (draft.baseRevision !== live.revision)
      throw new AppError("CONFLICT", "The live agent changed since the draft was written", {
        reason: "stale_base"
      });
    const written = await this.host.publish(
      call,
      target,
      draft,
      input.makeDependenciesAvailable,
      input.expectedAvailability == null
        ? input.expectedAvailability
        : {
            ...input.expectedAvailability,
            collaborationWorkspaceIds: input.expectedAvailability.collaborationWorkspaceIds.map(
              asCollaborationWorkspaceId
            )
          }
    );
    return {
      draftRevision: draft.revision,
      publishedRevision: written.revision,
      replacedRevision: live.revision
    };
  }

  async discard(
    call: AssetCall,
    input: { name: string; workspaceId?: string; expectedRevision: number }
  ) {
    await this.authorize(call.access, input);
    const target = await this.host.target({ ...input, kind: "agent" });
    const live = requireActive(target);
    if (
      !(await this.options.stores.agentProposals.remove({
        clientInstanceId: this.options.clientInstanceId,
        agentId: live.id,
        revision: input.expectedRevision
      }))
    ) {
      throw new AppError(
        "REVISION_CONFLICT",
        "The agent draft changed. Read it again before discarding",
        { reason: "draft_changed" }
      );
    }
    return { discarded: true as const };
  }

  private pending(agentId: string) {
    return this.options.stores.agentProposals.get({
      clientInstanceId: this.options.clientInstanceId,
      agentId
    });
  }
}
