import {
  AppError,
  asUserId,
  auditActorFromUser,
  type AgentProposal,
  type ApprovalRequest,
  type ApprovalRequestContext,
  type AuthenticatedUser,
  type ConfigAssetRecord,
  type JsonObject
} from "@work-shape/catalyst-core";
import {
  applyValidatedConfigAssetMutations,
  type ConfigAssetWriterOptions
} from "../assets/config-asset-writer";

/** Draft writes and their decisions commit together: they need no live revision as a receipt. */
export async function applySkillChangeDraft(
  options: ConfigAssetWriterOptions,
  context: ApprovalRequestContext,
  user: AuthenticatedUser,
  live: ConfigAssetRecord,
  draft: AgentProposal | undefined,
  config: JsonObject,
  reverting = false
): Promise<JsonObject> {
  const store = context.transaction?.configAssets;
  if (!store?.applyConfigAssetMutations) {
    throw new AppError("INTERNAL", "A skill draft approval requires a decision transaction");
  }
  const result = await applyValidatedConfigAssetMutations(
    {
      ...options,
      configAssets: {
        ...options.configAssets,
        store: {
          ...options.configAssets.store,
          applyConfigAssetMutations: store.applyConfigAssetMutations
        }
      }
    },
    {
      clientInstanceId: options.clientInstanceId,
      baseRevisions: { [`skill:${live.name}`]: live.revision },
      actor: auditActorFromUser(user),
      mutations: [
        {
          type: "upsert",
          kind: "skill",
          name: live.name,
          scope: live.scope,
          ...(reverting ? { operation: "revert" as const } : {}),
          config,
          ...(draft?.fileSetId ? { fileSetId: draft.fileSetId } : {}),
          agentDraft: {
            expectedDraftRevision: draft?.revision ?? null,
            author: { userId: asUserId(user.id), release: false }
          }
        }
      ]
    }
  );
  const draftRevision = result.draftRevisions?.[`skill:${live.name}`];
  if (draftRevision === undefined)
    throw new AppError("INTERNAL", "The approved skill draft was not written");
  return {
    skillName: live.name,
    draftRevision,
    publishedRevision: live.revision,
    previousDraftRevision: draft?.revision ?? null
  };
}

/** The public receipt names only revisions: it never exposes another writer's draft content. */
export async function skillDraftBefore(
  options: ConfigAssetWriterOptions,
  request: ApprovalRequest,
  context?: ApprovalRequestContext
) {
  const result = request.applyResult;
  if (typeof result?.skillName !== "string" || typeof result.previousDraftRevision !== "number")
    return undefined;
  const live = await (
    context?.transaction?.configAssets ?? options.configAssets.store
  ).getConfigAsset({
    clientInstanceId: options.clientInstanceId,
    kind: "skill",
    name: result.skillName
  });
  if (!live) return undefined;
  return (context?.transaction?.agentProposals ?? options.stores.agentProposals).getRevision({
    clientInstanceId: options.clientInstanceId,
    agentId: live.id,
    revision: result.previousDraftRevision
  });
}

export async function revertSkillChangeDraft(
  options: ConfigAssetWriterOptions,
  request: ApprovalRequest,
  context: ApprovalRequestContext,
  user: AuthenticatedUser
): Promise<void> {
  const result = request.applyResult;
  if (typeof result?.skillName !== "string" || typeof result.draftRevision !== "number")
    throw new AppError("INTERNAL", "The approved skill draft was not recorded");
  const drafts = context.transaction?.agentProposals;
  const store = context.transaction?.configAssets;
  if (!drafts || !store?.applyConfigAssetMutations)
    throw new AppError("INTERNAL", "A skill draft revert requires a decision transaction");
  const live = await store.getConfigAsset({
    clientInstanceId: options.clientInstanceId,
    kind: "skill",
    name: result.skillName
  });
  if (live?.status !== "active" || live.revision !== result.publishedRevision) throw changed();
  const draft = await drafts.get({ clientInstanceId: options.clientInstanceId, agentId: live.id });
  if (draft?.revision !== result.draftRevision) throw changed();
  const before = await skillDraftBefore(options, request, context);
  if (typeof result.previousDraftRevision === "number" && !before) throw changed();
  if (before) {
    // Restore via the same writer, preserving the previous draft's folder. With no previous
    // file set the previous config's text resources are the whole folder.
    await applySkillChangeDraft(
      options,
      context,
      user,
      live,
      {
        ...draft,
        config: before.config,
        fileSetId: before.fileSetId
      },
      before.config,
      true
    );
  } else if (
    !(await drafts.remove({
      clientInstanceId: options.clientInstanceId,
      agentId: live.id,
      revision: draft.revision
    }))
  )
    throw changed();
}

function changed() {
  return new AppError(
    "CONFLICT",
    "The skill draft changed or was published; this request can no longer be reverted"
  );
}
