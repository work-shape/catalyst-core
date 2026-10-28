import {
  AppError,
  isAuthenticatedServicePrincipal,
  moduleOffError,
  type AgentDraftAuthor,
  type AgentProposal,
  type OperationAuthorization
} from "@work-shape/catalyst-core";
import type { AssetWorkflowOptions } from "../types";
import { decide, type AssetCall } from "./asset-access";
import { readRevisionFiles } from "./asset-files";
import { requireActive, type AssetAddress, type AssetTarget } from "./asset-target";
import { writesSharedDraft } from "./shared-drafts";

interface SkillDraftHost {
  target(address: AssetAddress): Promise<AssetTarget>;
  /** Writes the draft as the skill's new live revision and consumes it, under one lock. */
  publish(
    call: AssetCall,
    target: AssetTarget,
    draft: AgentProposal
  ): Promise<{ revision: number }>;
}

/**
 * Reads and decisions of the one shared draft of a skill the instance or a Shared Workspace owns
 * (SKILL-DRAFT-1). It lives in the store of agents' drafts. Writes use the ordinary asset writer,
 * which sends a write of such a skill to its draft; a skill of a Personal Workspace has none.
 */
export class SkillDraftWorkflow {
  constructor(
    private readonly options: AssetWorkflowOptions,
    private readonly host: SkillDraftHost
  ) {}

  /** The draft, and that there is one, is the business of holders of the skill's write right. */
  async authorize(
    access: AssetCall["access"],
    input: { name: string; workspaceId?: string }
  ): Promise<OperationAuthorization> {
    const target = await this.host.target({ ...input, kind: "skill" });
    if (!access.authorize("skill.write", target.resource).allowed)
      throw new AppError("NOT_FOUND", "The skill draft is not available");
    return { allowed: true };
  }

  async get(call: AssetCall, input: { name: string; workspaceId?: string; files?: boolean }) {
    await this.authorize(call.access, input);
    const target = await this.host.target({ ...input, kind: "skill" });
    const live = requireActive(target);
    const draft = await this.pending(live.id);
    if (!draft) return null;
    return {
      skill: live.name,
      revision: draft.revision,
      baseRevision: draft.baseRevision,
      liveRevision: live.revision,
      stale: draft.baseRevision !== live.revision,
      config: draft.config,
      author: await this.namedAuthor(draft.author),
      updatedAt: draft.updatedAt,
      ...(input.files
        ? await readRevisionFiles(this.options, target.kind, {
            assetId: live.id,
            config: draft.config,
            ...(draft.fileSetId ? { fileSetId: draft.fileSetId } : {})
          })
        : {})
    };
  }

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

  /**
   * `skill.publish` on the skill. A person's right: a service principal publishes no skill, as it
   * publishes no agent. Where asset management is off only a draft a release wrote is published.
   */
  async authorizePublish(
    call: Pick<AssetCall, "actor" | "access">,
    input: AssetAddress
  ): Promise<OperationAuthorization> {
    const target = await this.host.target(input);
    if (isAuthenticatedServicePrincipal(call.actor))
      return { allowed: false, action: "skill.publish", reason: "user_only" };
    const decision = decide(call.access, "skill.publish", target.resource);
    if (!decision.allowed) return decision;
    const draft = target.asset ? await this.pending(target.asset.id) : undefined;
    if (!this.options.modules.isEnabled("assetManagement") && !draft?.author.release)
      throw moduleOffError("assetManagement");
    return decision;
  }

  /**
   * Makes the draft revision the caller read the skill's live revision. Every agent that uses the
   * skill reads it from then on. A newer draft, or a live revision written after the draft's
   * base, refuses it.
   */
  async publish(call: AssetCall, input: AssetAddress & { revision: number }) {
    const target = await this.host.target(input);
    if (isAuthenticatedServicePrincipal(call.actor))
      throw new AppError("FORBIDDEN", "A service principal cannot publish a skill");
    call.access.require("skill.publish", target.resource);
    const live = requireActive(target);
    if (!(await writesSharedDraft(this.options, "skill", target.scope)))
      throw new AppError(
        "VALIDATION_FAILED",
        "A skill of a personal workspace is live on save: it has no draft to publish",
        { reason: "no_draft" }
      );
    const draft = await this.pending(live.id);
    if (draft?.revision !== input.revision) throw draftChanged();
    if (draft.baseRevision !== live.revision)
      throw new AppError("CONFLICT", "The live skill changed since the draft was written", {
        reason: "stale_base"
      });
    const written = await this.host.publish(call, target, draft);
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
    const target = await this.host.target({ ...input, kind: "skill" });
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
        "The skill draft changed. Read it again before discarding",
        { reason: "draft_changed" }
      );
    }
    return { discarded: true as const };
  }

  private pending(skillId: string) {
    return this.options.stores.agentProposals.get({
      clientInstanceId: this.options.clientInstanceId,
      agentId: skillId
    });
  }
}

function draftChanged(): AppError {
  return new AppError(
    "REVISION_CONFLICT",
    "The skill draft changed. Read it again before publishing",
    { reason: "draft_changed" }
  );
}
