import {
  AppError,
  asConversationId,
  getSubjectUserId,
  isAppError,
  isAuthenticatedServicePrincipal,
  type ActorAccess,
  type AgentProposal,
  type AgentProposalSource,
  type AuthenticatedIdentity,
  type ConfigAssetRecord,
  type Conversation,
  type ConversationSubject,
  type OperationAuthorization,
  type OperationBeforeEvent
} from "@work-shape/catalyst-core";
import type { PlatformAssetCalls, PlatformAssetPut } from "@work-shape/catalyst-tool-execution";
import { assetWriteEvent } from "../guardrails/asset-guardrail-events";
import type { AssetWorkflowOptions } from "../types";
import type { AssetCall } from "./asset-access";
import { AssetWorkflow } from "./asset-service";
import { findDefinition, validateAssetSet, withDefinition } from "./asset-set";
import {
  assertUpsertWithinLimits,
  findChangedAgentRefusals,
  loadStoredAssets,
  toJsonObject
} from "./asset-write-rules";

// The pending change proposal of an agent (TRY-1a; platform-access.md, "Agents: the proposal is
// the draft"). An agent's save of an agent that exists writes no live revision: it writes the
// next revision of its conversation's proposal for that agent, and a read in that conversation
// answers the proposal. A person applies the proposal, which is their own save of the agent with
// its rights, guardrails, revision and audit, or discards it. A proposal based on a revision that
// is no longer the agent's live one is stale: Apply refuses it, a read in the conversation answers
// the live agent again, and the agent's next save there bases the proposal on that.

/** The kind whose saves by an agent are proposals once an asset of it exists. */
export const PROPOSED_KIND = "agent";

type PlatformAssetWrite = Awaited<ReturnType<PlatformAssetCalls["put"]>>;

/** The agent and the Build conversation a call of a person names. */
interface ProposalAddress {
  name: string;
  conversationId: string;
}

/** The proposal as the person reads it beside the live agent. */
export interface AgentProposalView {
  agent: string;
  conversationId: string;
  revision: number;
  baseRevision: number;
  liveRevision: number;
  /** The agent's live revision is another than the proposal is based on: Apply refuses it. */
  stale: boolean;
  config: AgentProposal["config"];
  updatedAt: string;
}

const sourceOf = (conversationId: string): AgentProposalSource => ({
  kind: "conversation",
  conversationId: asConversationId(conversationId)
});

const conversationUnavailable = () =>
  new AppError("NOT_FOUND", "Conversation is not available", undefined, { exposeMessage: true });

const agentUnavailable = () =>
  new AppError(
    "NOT_FOUND",
    "The agent is not available",
    { reason: "agent_unavailable" },
    { exposeMessage: true }
  );

const noProposal = () =>
  new AppError(
    "NOT_FOUND",
    "This conversation has no pending change proposal for the agent",
    { reason: "no_proposal" },
    { exposeMessage: true }
  );

/** The refusal of an Apply on a base that is no longer the agent's live revision. */
const staleBase = () =>
  new AppError(
    "CONFLICT",
    "The agent was changed since this proposal was based on it, so the proposal cannot be applied. The agent prepares a new one",
    { reason: "stale_base" },
    { exposeMessage: true }
  );

export class AgentProposals {
  private readonly options: AssetWorkflowOptions;
  private readonly workflow: AssetWorkflow;

  constructor(options: AssetWorkflowOptions) {
    this.options = options;
    this.workflow = new AssetWorkflow(options);
  }

  /**
   * What a read of `asset` answers in `conversation` in place of the live agent: the newest
   * revision of the conversation's proposal for it, where one is pending and not stale.
   */
  async head(
    conversation: Conversation,
    asset: ConversationSubject
  ): Promise<
    { config: AgentProposal["config"]; revision: number; liveRevision: number } | undefined
  > {
    if (asset.kind !== PROPOSED_KIND) return undefined;
    const live = await this.live(asset.name);
    if (!live) return undefined;
    const proposal = await this.pending(live, conversation.id);
    if (proposal?.baseRevision !== live.revision) return undefined;
    return { config: proposal.config, revision: proposal.revision, liveRevision: live.revision };
  }

  /**
   * The agent's save of the agent `address` names in `conversation`: the next revision of the
   * conversation's proposal for it, on the agent's live revision. The caller asked the rights of
   * a save of the agent; this asks its checks, and leaves the agent as it is. `expectedRevision` is the
   * revision a read in the conversation answered: the proposal's, or the live agent's where none
   * is pending or the pending one is stale.
   */
  async save(
    call: AssetCall,
    conversation: Conversation,
    address: ConversationSubject & { workspaceId?: string },
    input: PlatformAssetPut
  ): Promise<PlatformAssetWrite> {
    if (input.config === undefined || input.files !== undefined) {
      return {
        saved: false,
        issues: [{ path: "config", message: "An agent is saved as its config. It holds no files" }]
      };
    }
    const live = await this.live(address.name);
    if (!live) throw agentUnavailable();
    const config = toJsonObject(input.config);
    const { issues } = await this.workflow.validate(call, { ...address, config });
    if (issues.length > 0) {
      return {
        saved: false,
        issues: issues.map((issue) => ({
          path: (issue.path ?? []).join("."),
          message: issue.message,
          ...(issue.code === undefined ? {} : { code: issue.code })
        }))
      };
    }
    const refusal = await this.editingRefusal(call, live, config);
    if (refusal !== undefined) {
      return {
        saved: false,
        issues: [
          {
            path: "config",
            message: `${refusal}. A person may not change it outside a release, so the proposal leaves it as it is`
          }
        ]
      };
    }
    const pending = await this.pending(live, conversation.id);
    const expected = pending?.baseRevision === live.revision ? pending.revision : live.revision;
    const saved =
      input.expectedRevision === expected
        ? await this.options.stores.agentProposals.save({
            clientInstanceId: this.options.clientInstanceId,
            agentId: live.id,
            source: sourceOf(conversation.id),
            baseRevision: live.revision,
            expectedRevision: pending?.revision ?? null,
            config,
            savedAt: new Date().toISOString()
          })
        : undefined;
    if (!saved) {
      return {
        saved: false,
        conflict: "REVISION_CONFLICT",
        message: `The revision you read is no longer the one to save on: read the agent again in this conversation, apply your change to what it answers and save with its revision`
      };
    }
    return { saved: true, revision: saved.revision, publishedRevision: live.revision };
  }

  /** The right to read a proposal: the read right on the agent. */
  async authorizeRead(
    actor: AuthenticatedIdentity,
    access: ActorAccess,
    input: ProposalAddress
  ): Promise<OperationAuthorization> {
    const { address } = await this.locate(actor, input);
    return this.workflow.authorizeRead(access, address);
  }

  /**
   * The rights to apply or discard a proposal: those of a save of the agent with the proposed
   * definition, the write right among them. A discard asks the write right alone.
   */
  async authorizeChange(
    actor: AuthenticatedIdentity,
    access: ActorAccess,
    input: ProposalAddress,
    change: "apply" | "discard"
  ): Promise<OperationAuthorization> {
    const { address, proposal } = await this.locate(actor, input);
    if (change === "discard" || !proposal) return this.workflow.authorizeWrite(access, address);
    return this.workflow.authorizeRevisionWrite(
      access,
      { ...address, config: proposal.config, expectedRevision: proposal.baseRevision },
      "write"
    );
  }

  /** What the policy is asked about: the agent, as for a save of it. */
  async policyTargets(input: { name: string }) {
    const live = await this.live(input.name);
    return this.workflow.policyTargets({
      kind: PROPOSED_KIND,
      name: input.name,
      ...(live?.scope.kind === "workspace" ? { workspaceId: live.scope.workspaceId } : {})
    });
  }

  /** The proposal of the person's own conversation for the agent, or nothing. */
  async get(call: AssetCall, input: ProposalAddress): Promise<AgentProposalView | null> {
    const { live, proposal } = await this.locate(call.actor, input);
    if (!live) throw agentUnavailable();
    if (!proposal) return null;
    return {
      agent: live.name,
      conversationId: input.conversationId,
      revision: proposal.revision,
      baseRevision: proposal.baseRevision,
      liveRevision: live.revision,
      stale: proposal.baseRevision !== live.revision,
      config: proposal.config,
      updatedAt: proposal.updatedAt
    };
  }

  /**
   * `asset.before_write` of the definition an Apply writes: the proposal's revision the person
   * names. A proposal that is not at it has no event; the Apply itself refuses it.
   */
  async applyEvents(
    input: ProposalAddress & { revision: number }
  ): Promise<OperationBeforeEvent[]> {
    const live = await this.live(input.name);
    const proposal = live ? await this.pending(live, input.conversationId) : undefined;
    if (proposal?.revision !== input.revision) return [];
    return [assetWriteEvent({ kind: PROPOSED_KIND, name: input.name, config: proposal.config })];
  }

  /**
   * Applies the proposal at the revision the person read: the person's own save of the agent on
   * the proposal's base, after which the proposal is gone. A base that is no longer the agent's
   * live revision is refused with `stale_base`, and the proposal stays.
   */
  async apply(call: AssetCall, input: ProposalAddress & { revision: number }) {
    const { live, address, proposal } = await this.locate(call.actor, input);
    if (!live) throw agentUnavailable();
    if (!proposal) throw noProposal();
    if (proposal.revision !== input.revision) {
      throw new AppError(
        "REVISION_CONFLICT",
        "The agent changed its proposal since you read it. Read it again before you apply it",
        { reason: "proposal_changed" },
        { exposeMessage: true }
      );
    }
    let written: Awaited<ReturnType<AssetWorkflow["put"]>>;
    try {
      written = await this.workflow.put(call, {
        ...address,
        config: proposal.config,
        expectedRevision: proposal.baseRevision
      });
    } catch (error) {
      // The agent has another live revision than the proposal's base: the write on that base
      // is refused, and the proposal stays.
      if (isAppError(error) && error.code === "REVISION_CONFLICT") throw staleBase();
      throw error;
    }
    // A save the agent made meanwhile is a newer revision, which stays pending on a stale base.
    await this.options.stores.agentProposals.remove({
      clientInstanceId: this.options.clientInstanceId,
      agentId: live.id,
      source: proposal.source,
      revision: proposal.revision
    });
    return written;
  }

  /** Drops the proposal of the person's own conversation for the agent. */
  async discard(call: AssetCall, input: ProposalAddress): Promise<{ discarded: true }> {
    const { live } = await this.locate(call.actor, input);
    if (!live) throw agentUnavailable();
    const removed = await this.options.stores.agentProposals.remove({
      clientInstanceId: this.options.clientInstanceId,
      agentId: live.id,
      source: sourceOf(input.conversationId)
    });
    if (!removed) throw noProposal();
    return { discarded: true };
  }

  /**
   * The agent and the proposal a person's call names. The conversation is their own, as a Build
   * conversation is: one of anybody else, and one that is gone, is answered as missing. An agent
   * a workspace owns is found from a conversation of that workspace only.
   */
  private async locate(actor: AuthenticatedIdentity, input: ProposalAddress) {
    const conversation = await this.options.stores.conversations.getConversation(
      this.options.clientInstanceId,
      asConversationId(input.conversationId)
    );
    if (
      isAuthenticatedServicePrincipal(actor) ||
      conversation?.status !== "active" ||
      conversation.createdByUserId !== getSubjectUserId(actor)
    ) {
      throw conversationUnavailable();
    }
    const live = await this.live(input.name);
    const workspaceId = live?.scope.kind === "workspace" ? live.scope.workspaceId : undefined;
    if (workspaceId !== undefined && workspaceId !== conversation.collaborationWorkspaceId) {
      throw agentUnavailable();
    }
    const address = {
      kind: PROPOSED_KIND,
      name: input.name,
      ...(workspaceId === undefined ? {} : { workspaceId })
    };
    const proposal = live ? await this.pending(live, conversation.id) : undefined;
    return { live, address, proposal };
  }

  /**
   * What the instance's editing policy for agents refuses of the proposed definition, asked as
   * Apply asks it: a field a person may not change outside a release, or a model setting
   * without its right. The agent is told at once instead of at Apply.
   */
  private async editingRefusal(
    call: AssetCall,
    { name, scope }: ConfigAssetRecord,
    config: AgentProposal["config"]
  ): Promise<string | undefined> {
    const kinds = this.options.configAssets.kinds;
    const kind = kinds.require(PROPOSED_KIND);
    const stored = await loadStoredAssets(this.options);
    const current = findDefinition(stored.set, PROPOSED_KIND, name);
    const definition = kind.prepareInteractiveUpsert({
      current,
      next: config,
      principalId: call.actor.id
    });
    const validated = validateAssetSet(
      kinds.kinds,
      withDefinition(stored.set, PROPOSED_KIND, name, definition),
      stored.set
    );
    // The lists the save of the agent is held to, and what of them it would break; validating
    // the proposal asked them already, so only the editing policy is left to ask.
    const lists = await findChangedAgentRefusals(this.options, call.access, stored.set, validated, {
      names: [name],
      scope: scope.kind === "workspace" ? { workspaceId: scope.workspaceId } : {}
    });
    try {
      assertUpsertWithinLimits(call.access, "put", kind, {
        ...lists,
        name,
        current,
        next: findDefinition(validated, PROPOSED_KIND, name)
      });
      return undefined;
    } catch (error) {
      if (isAppError(error) && error.code === "FORBIDDEN") return error.message;
      throw error;
    }
  }

  /** The agent `name`, where it exists. */
  private async live(name: string): Promise<ConfigAssetRecord | undefined> {
    const row = await this.options.configAssets.store.getConfigAsset({
      clientInstanceId: this.options.clientInstanceId,
      kind: PROPOSED_KIND,
      name
    });
    return row?.status === "active" ? row : undefined;
  }

  private pending(live: ConfigAssetRecord, conversationId: string) {
    return this.options.stores.agentProposals.get({
      clientInstanceId: this.options.clientInstanceId,
      agentId: live.id,
      source: sourceOf(conversationId)
    });
  }
}
