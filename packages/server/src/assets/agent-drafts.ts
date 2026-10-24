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
import type { AgentPublishChecked } from "../approvals/agent-publish-review";
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
  /**
   * Writes `config` as the agent's new live revision over `expectedRevision`, never as a
   * draft: a pending draft takes `toolNames` along (`agents.give_tools`).
   */
  giveTools(
    call: AssetCall,
    target: AssetTarget,
    config: Record<string, unknown>,
    write: { expectedRevision: number; toolNames: readonly string[] }
  ): Promise<{ revision: number }>;
  /** Offers a first version without a draft in its workspace; nothing where that is not it. */
  publishFirstVersion(
    call: AssetCall,
    target: AssetTarget,
    revision: number
  ): Promise<{ revision: number } | undefined>;
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
    },
    checked?: AgentPublishChecked
  ) {
    const target = await this.host.target(input);
    if (isAuthenticatedServicePrincipal(call.actor))
      throw new AppError("FORBIDDEN", "A service principal cannot publish an agent");
    call.access.require("agent.publish", target.resource);
    const live = requireActive(target);
    const draft = await this.pending(live.id);
    // What its guardrails read is what goes live: the draft revision, which names one content
    // only, or the first version as it is stored. A call they were not asked about publishes
    // what there is.
    if (checked !== undefined && checked.revision !== input.revision) throw draftChanged();
    const firstVersion = checked?.firstVersion ?? !draft;
    // A held publish runs only as what it was approved as.
    if (
      checked?.approvedFirstVersion !== undefined &&
      checked.approvedFirstVersion !== firstVersion
    )
      throw draftChanged();
    if (firstVersion) {
      // A workspace's agent its approvers have not yet offered is published as it was made.
      const offered = draft
        ? undefined
        : await this.host.publishFirstVersion(call, target, input.revision);
      if (offered) return { draftRevision: offered.revision, publishedRevision: offered.revision };
      if (checked) throw draftChanged();
    }
    if (draft?.revision !== input.revision) throw draftChanged();
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

  /**
   * `agents.give_tools`: a person who may change and publish an instance's own agent gives it
   * tools, as one new live revision of what is published plus the tools. Whoever wrote a pending
   * draft keeps it; it gains the same tools. A workspace's agent is not addressed: its publish
   * waits for its approvers (WS-PUB-1b), and a give that goes live at once would pass them by.
   */
  async authorizeGiveTools(
    call: Pick<AssetCall, "actor" | "access">,
    input: { name: string }
  ): Promise<OperationAuthorization> {
    if (isAuthenticatedServicePrincipal(call.actor))
      return { allowed: false, action: "agent.publish", reason: "user_only" };
    const target = await this.host.target({ kind: "agent", name: input.name });
    // Both rights, each with its own deny: the give is a change and a publish at once.
    const write = decide(call.access, "agent.write", target.resource);
    if (!write.allowed) return write;
    return decide(call.access, "agent.publish", target.resource);
  }

  async giveTools(
    call: AssetCall,
    input: {
      name: string;
      agentId: string;
      toolNames: readonly string[];
      expectedLiveRevision: number;
    },
    checked?: AgentGiveChecked
  ) {
    if (isAuthenticatedServicePrincipal(call.actor))
      throw new AppError("FORBIDDEN", "A service principal cannot give tools to an agent");
    const target = await this.host.target({ kind: "agent", name: input.name });
    call.access.require("agent.write", target.resource);
    call.access.require("agent.publish", target.resource);
    const live = requireActive(target);
    if (live.id !== input.agentId)
      throw new AppError("CONFLICT", `Another agent carries the name '${input.name}' now`, {
        kind: "agent",
        name: input.name,
        reason: "asset_replaced"
      });
    // What its guardrails read is what goes live: the published agent at this revision, with
    // the tools added. A live change since refuses the give.
    if (
      live.revision !== input.expectedLiveRevision ||
      (checked !== undefined && checked.liveRevision !== input.expectedLiveRevision)
    )
      throw liveChanged(live.revision);
    const added = toolsToGive(live.config, input.toolNames);
    if (added.length === 0)
      return { publishedRevision: live.revision, replacedRevision: live.revision, givenTools: [] };
    const written = await this.host.giveTools(call, target, withGivenTools(live.config, added), {
      expectedRevision: live.revision,
      toolNames: added
    });
    return {
      publishedRevision: written.revision,
      replacedRevision: live.revision,
      givenTools: added
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

/** What `agents.give_tools` was checked against by its guardrails: the live revision. */
export interface AgentGiveChecked {
  liveRevision: number;
}

function liveChanged(currentRevision: number): AppError {
  return new AppError(
    "REVISION_CONFLICT",
    "The published agent changed. Read it again before giving it tools",
    { reason: "live_changed", currentRevision }
  );
}

/** The tool names of a definition, in its order. */
function toolNamesOf(config: Record<string, unknown>): string[] {
  const names = config.toolNames;
  return Array.isArray(names)
    ? names.filter((name): name is string => typeof name === "string")
    : [];
}

/** Of `toolNames`, those the definition does not hold yet, each once, in their order. */
function toolsToGive(config: Record<string, unknown>, toolNames: readonly string[]): string[] {
  const held = new Set(toolNamesOf(config));
  return [...new Set(toolNames)].filter((name) => !held.has(name));
}

/** The definition with `toolNames` added after the tools it holds. */
export function withGivenTools(
  config: Record<string, unknown>,
  toolNames: readonly string[]
): Record<string, unknown> {
  return { ...config, toolNames: [...new Set([...toolNamesOf(config), ...toolNames])] };
}

function draftChanged(): AppError {
  return new AppError(
    "REVISION_CONFLICT",
    "The agent draft changed. Read it again before publishing",
    { reason: "draft_changed" }
  );
}
