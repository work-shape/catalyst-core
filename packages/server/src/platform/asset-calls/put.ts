import { AppError, moduleOffError, type ToolExecutionContext } from "@work-shape/catalyst-core";
import {
  platformAssetWriteRefusal,
  type PlatformAssetCalls,
  type PlatformAssetPut
} from "@work-shape/catalyst-tool-execution";
import { assetWriteEvent } from "../../guardrails/asset-guardrail-events";
import { authorizePlatformAssetPut } from "../platform-asset-preflight";
import {
  accessOf,
  createUnnamed,
  ownerOf,
  requireInstanceCreate,
  requireOwnTranscript,
  subjectUnavailable
} from "../../conversations/platform-asset-subject";
import { type AssetCallScope, namedBy, ASSET_WRITE_OPERATION } from "./scope";

/** The kind a save proposes a change of, instead of writing a draft. */
const PROPOSED_KIND = "agent";

/** Saving the subject, a draft the conversation created, or a new asset, and what a save asks first. */
export function putCalls(
  scope: AssetCallScope
): Pick<PlatformAssetCalls, "authorizePut" | "put" | "putPolicyFloor" | "putBeforeEvents"> {
  const {
    options,
    workflow,
    putFloor,
    titleOf,
    conversationOf,
    callOf,
    bound,
    putTarget,
    readAsset,
    allowed,
    contentOf,
    creatableKinds,
    otherName
  } = scope;
  /**
   * A save without a revision: it creates the asset the call names, as `assets.put` with no
   * revision creates one, with the right, the checks and the audit of the person, and notes it
   * as this conversation's own. In a conversation about no asset yet it becomes the subject: the
   * save is the person's step that makes even an asset of the instance the subject, since nothing
   * existed that it could reach (manager, 2026-10-14). In a conversation about an asset it stays
   * a draft beside the subject, which the conversation may keep saving and moves nobody
   * (BUILD-ALL-1). An agent made so is offered nowhere.
   */
  async function create(
    context: ToolExecutionContext,
    input: PlatformAssetPut
  ): ReturnType<PlatformAssetCalls["put"]> {
    const conversation = await conversationOf(context);
    const beside = conversation.subject !== undefined;
    const kind = creatableKinds().find((candidate) => candidate.kind === input.kind);
    if (input.name === undefined || kind === undefined) {
      throw createUnnamed(creatableKinds().map((each) => each.kind));
    }
    // The new asset is the conversation's own, which a conversation others read never has.
    await requireOwnTranscript(options, conversation);
    const off = options.modules.offModuleOf("operation", ASSET_WRITE_OPERATION);
    if (off !== undefined) throw moduleOffError(off);
    const named = { kind: kind.kind, name: input.name };
    const mismatch = input.config === undefined ? undefined : otherName(named, input.config);
    if (mismatch) return { saved: false, issues: [mismatch] };
    const call = await callOf(context);
    // A conversation started under Studio's scope "Instance" creates for the instance only
    // where the person may: else nothing is created, also not in its workspace.
    await requireInstanceCreate(options, {
      actor: call.actor,
      access: call.access,
      conversation,
      kind,
      name: named.name,
      correlationId: context.correlationId
    });
    const write = {
      ...named,
      ...ownerOf(kind, conversation),
      ...contentOf(input),
      expectedRevision: null,
      ...(kind.hasWorkspaceAvailability ? { availableIn: "nowhere" as const } : {})
    };
    let revision: number;
    try {
      allowed(await workflow.authorizeRevisionWrite(call.access, write, "write"));
      revision = (await workflow.put(call, write)).revision;
    } catch (error) {
      const refused = platformAssetWriteRefusal(error);
      if (refused) return refused;
      throw error;
    }
    const row = await options.configAssets.store.getConfigAsset({
      clientInstanceId: options.clientInstanceId,
      ...named
    });
    if (row) {
      await options.stores.conversations.recordCreatedAsset({
        clientInstanceId: options.clientInstanceId,
        conversationId: conversation.id,
        assetId: row.id,
        revision,
        createdAt: new Date().toISOString()
      });
    }
    if (!beside) {
      await options.stores.conversations.setConversationSubject({
        clientInstanceId: options.clientInstanceId,
        conversationId: conversation.id,
        subject: named
      });
    }
    const read = await readAsset(context, conversation, named);
    return {
      saved: true,
      revision,
      created: true,
      kind: named.kind,
      name: named.name,
      title: titleOf(named.kind, named.name, read.config, context.locale),
      ...ownerOf(kind, conversation),
      ...(beside ? { besideSubject: true as const } : {})
    };
  }

  return {
    async authorizePut(input, context) {
      // Draft saves keep their structured validation result. Live creates must pass before Allow.
      if (input.expectedRevision !== undefined) return { allowed: true };
      if (context.origin.kind !== "agent") return { allowed: false, reason: "user_only" };
      const conversation = await options.stores.conversations.getConversation(
        options.clientInstanceId,
        context.origin.conversationId
      );
      if (!conversation) throw subjectUnavailable();
      const target = await putTarget(conversation, input);
      if (!target || options.configAssets.kinds.get(target.kind)?.lifecycle === "draft_published")
        return { allowed: true };
      await requireOwnTranscript(options, conversation);
      // Asked of the person's own rights before the confirmation, as the save asks it again.
      await requireInstanceCreate(options, {
        actor: context.actor,
        access: await accessOf(options, context.actor),
        conversation,
        kind: options.configAssets.kinds.require(target.kind),
        name: target.name,
        correlationId: context.correlationId
      });
      return authorizePlatformAssetPut(options, workflow, target, input, context);
    },

    async put(context, input) {
      if (input.expectedRevision === undefined) return create(context, input);
      // The save reaches the subject, or a draft this conversation created where the save names
      // one, and no other asset the model names. An asset of the instance is the subject only
      // where a person's step, or this conversation's own first save, made it.
      const { conversation, subject, address, call } = await bound(context, namedBy(input));
      const kind = options.configAssets.kinds.kinds.find(
        (candidate) => candidate.kind === subject.kind
      );
      // A Page is saved with its own tool, and a kind of a module that is off is none here.
      if (kind === undefined) throw subjectUnavailable();
      // A kind without a draft is live with every write. This tool moves a draft and nothing
      // else; an agent's save of an agent writes the conversation's proposal instead.
      const proposes = kind.kind === PROPOSED_KIND;
      if (kind.lifecycle !== "draft_published" && !proposes) {
        throw new AppError(
          "VALIDATION_FAILED",
          `An asset of the kind '${subject.kind}' has no draft: a save of it would be live at once, and this tool saves drafts only`,
          { reason: "no_draft" },
          { exposeMessage: true }
        );
      }
      const off = options.modules.offModuleOf("operation", ASSET_WRITE_OPERATION);
      if (off !== undefined) throw moduleOffError(off);
      const mismatch = input.config === undefined ? undefined : otherName(subject, input.config);
      if (mismatch) return { saved: false, issues: [mismatch] };
      const write = {
        ...address,
        ...contentOf(input),
        expectedRevision: input.expectedRevision,
        expectedDraftRevision: input.expectedDraftRevision ?? null
      };
      try {
        allowed(await workflow.authorizeRevisionWrite(call.access, write, "write"));

        const written = await workflow.put(
          { ...call, buildConversationId: conversation.id },
          write
        );
        return proposes
          ? {
              saved: true,
              revision:
                "publishedRevision" in written
                  ? (written.publishedRevision ?? written.revision)
                  : written.revision,
              draftRevision: written.revision,
              publishedRevision:
                "publishedRevision" in written ? written.publishedRevision : undefined
            }
          : { saved: true, revision: written.revision };
      } catch (error) {
        const refused = platformAssetWriteRefusal(error);
        if (refused) return refused;
        throw error;
      }
    },

    async putPolicyFloor(conversationId, input) {
      const conversation = await options.stores.conversations.getConversation(
        options.clientInstanceId,
        conversationId
      );
      if (!conversation) return undefined;
      // A create asks what a setting asks of the asset it names, where it would be, as
      // `assets.put` of the API asks it: in the workspace that would own it. A save the call
      // itself refuses asks nothing here.
      const target = await putTarget(conversation, input);
      return target ? putFloor(target, input.expectedRevision !== undefined) : undefined;
    },

    async putBeforeEvents(conversationId, input) {
      const conversation = await options.stores.conversations.getConversation(
        options.clientInstanceId,
        conversationId
      );
      if (!conversation) return [];
      // A create names the asset it creates, a save of a created draft names that draft, and
      // any other save writes the subject. A save the call itself refuses has no event.
      const target = await putTarget(conversation, input);
      if (!target) return [];
      return [assetWriteEvent({ kind: target.kind, name: target.name, ...contentOf(input) })];
    }
  };
}
