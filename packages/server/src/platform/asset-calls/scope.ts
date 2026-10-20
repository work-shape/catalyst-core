import {
  AppError,
  operationDenialError,
  type AuditRecorder,
  type Conversation,
  type ConversationSubject,
  type OperationAuthorization,
  type ToolExecutionContext
} from "@work-shape/catalyst-core";
import {
  PLATFORM_ASSET_TOOLS,
  type PlatformAssetCalls,
  type PlatformAssetPut
} from "@work-shape/catalyst-tool-execution";
import { PageApps } from "../../apps/page-apps";
import type { AssetCall } from "../../assets/asset-access";
import { readDefinitionName } from "../../asset-kinds/shared";
import { AssetWorkflow } from "../../assets/asset-service";
import { assetTitle } from "../../assets/asset-reference-labels";
import { createPlatformAssetPolicy } from "../platform-asset-policy";
import {
  CREATED_FROM_CHAT,
  accessOf,
  notOfConversation,
  ownerOf,
  subjectUnavailable
} from "../../conversations/platform-asset-subject";
import type { AssetWorkflowOptions } from "../../types";

// What the families of the agent's asset calls share: the conversation a call came from, the
// call as the asset operations take one, where an asset is found and which asset a check or a
// save reaches. Each family (subject, put, app-save, skill, discovery) is a file of its own over
// this scope, joined in `../platform-asset-calls.ts`.

/** The module whose switch turns changing assets through `assets.put` on and off. */
export const ASSET_WRITE_OPERATION = "assets.put";

/** The refusal of a call that names no asset in a conversation about none yet. */
export const withoutSubject = () =>
  new AppError(
    "CONFLICT",
    `This conversation is about no asset yet. Open the one to work on with ${PLATFORM_ASSET_TOOLS.open.name}, naming its kind and its name, and then change it. To make a new one, save it with ${PLATFORM_ASSET_TOOLS.put.name}, leaving 'expectedRevision' out and naming its 'kind' and 'name'`,
    { reason: "conversation_without_subject" },
    { exposeMessage: true }
  );

export const sameSubject = (left: ConversationSubject, right: ConversationSubject | undefined) =>
  right !== undefined && left.kind === right.kind && left.name === right.name;

/** The asset a save with a revision names by kind and name, where it names a whole one. */
export const namedBy = (input: {
  kind?: string;
  name?: string;
}): ConversationSubject | undefined =>
  input.kind !== undefined && input.name !== undefined
    ? { kind: input.kind, name: input.name }
    : undefined;

/** What every family of the asset calls reads and calls. */
export type AssetCallScope = ReturnType<typeof createAssetCallScope>;

export function createAssetCallScope(options: AssetWorkflowOptions) {
  const workflow = new AssetWorkflow(options);
  const { centralFloor, putFloor } = createPlatformAssetPolicy(options, workflow);
  const titleOf = assetTitle.bind(undefined, options.configAssets.kinds.kinds);

  const pageApps = new PageApps(options);

  /** The conversation the call came from, where it came from one. */
  async function conversationOfCall(
    context: ToolExecutionContext
  ): Promise<Conversation | undefined> {
    const conversationId = context.toolRequest?.conversationId;
    return conversationId
      ? options.stores.conversations.getConversation(options.clientInstanceId, conversationId)
      : undefined;
  }

  /** The conversation the call came from. Refuses a call that came from none. */
  async function conversationOf(context: ToolExecutionContext): Promise<Conversation> {
    const conversation = await conversationOfCall(context);
    if (!conversation) {
      throw new AppError(
        "CONFLICT",
        "An asset is read and saved in a conversation, and this call came from none",
        { reason: "call_without_conversation" },
        { exposeMessage: true }
      );
    }
    return conversation;
  }

  /** The call as the asset operations take one. */
  async function callOf(context: ToolExecutionContext): Promise<AssetCall> {
    const runId = context.operationRun?.id;
    // The audit rows of the call carry its run, as those of a call of the API do.
    const audit: AuditRecorder = {
      record: (input) =>
        options.auditRecorder.record({
          ...input,
          correlationId: context.correlationId,
          metadata: { ...input.metadata, ...(runId ? { operationRunId: runId } : {}) }
        })
    };
    return {
      actor: context.user,
      access: await accessOf(options, context.user),
      audit,
      correlationId: context.correlationId,
      ...(runId ? { runId } : {})
    };
  }

  /**
   * Where the operations find an asset. An asset of a workspace, such as an App, is read and
   * saved in a conversation of that workspace, and is missing from every other one.
   */
  async function addressOf(
    conversation: Conversation,
    subject: ConversationSubject
  ): Promise<ConversationSubject & { workspaceId?: string }> {
    const row = await options.configAssets.store.getConfigAsset({
      clientInstanceId: options.clientInstanceId,
      kind: subject.kind,
      name: subject.name
    });
    if (row?.scope.kind !== "workspace") return subject;
    if (row.scope.workspaceId !== conversation.collaborationWorkspaceId) {
      throw subjectUnavailable();
    }
    return { ...subject, workspaceId: row.scope.workspaceId };
  }

  /** Whether the conversation created the asset `named` and it is still the one it created. */
  const createdHere = (conversation: Conversation, named: ConversationSubject) =>
    options.stores.conversations.createdAsset({
      clientInstanceId: options.clientInstanceId,
      conversationId: conversation.id,
      kind: named.kind,
      name: named.name
    });

  /**
   * The asset a check or a save reaches, where the operations find it, and the call: the
   * subject where the call names none or names the subject, else a draft this conversation
   * created. Any other asset is refused, whatever the model names.
   */
  async function bound(
    context: ToolExecutionContext,
    named?: ConversationSubject
  ): Promise<{
    conversation: Conversation;
    subject: ConversationSubject;
    address: ConversationSubject & { workspaceId?: string };
    call: AssetCall;
  }> {
    const conversation = await conversationOf(context);
    let target = conversation.subject;
    if (named !== undefined && !sameSubject(named, target)) {
      if (!(await createdHere(conversation, named))) {
        throw notOfConversation(conversation.subject, named);
      }
      target = named;
    }
    if (!target) throw withoutSubject();
    return {
      conversation,
      subject: target,
      address: await addressOf(conversation, target),
      call: await callOf(context)
    };
  }

  /**
   * The asset a save writes, for its policy and its guardrails: the asset a save without a
   * revision creates, the created draft a save names, or the subject. Nothing where the save
   * names none of them, which the save itself refuses.
   */
  async function putTarget(
    conversation: Conversation,
    input: PlatformAssetPut
  ): Promise<(ConversationSubject & { workspaceId?: string }) | undefined> {
    if (input.expectedRevision === undefined) {
      const kind = creatableKinds().find((candidate) => candidate.kind === input.kind);
      if (kind === undefined || input.name === undefined) return undefined;
      return { kind: kind.kind, name: input.name, ...ownerOf(kind, conversation) };
    }
    const named = namedBy(input);
    if (named !== undefined && !sameSubject(named, conversation.subject)) {
      if (!(await createdHere(conversation, named))) return undefined;
      return addressOf(conversation, named).catch(() => undefined);
    }
    return conversation.subject;
  }

  /** Reads an asset of the conversation, as the agent reads one. */
  async function readAsset(
    context: ToolExecutionContext,
    conversation: Conversation,
    asset: ConversationSubject
  ): ReturnType<PlatformAssetCalls["get"]> {
    const address = await addressOf(conversation, asset);
    const call = await callOf(context);
    allowed(await workflow.reads.authorizeGet(call.access, address));
    const read = await workflow.reads.get(call, address);
    const proposed =
      asset.kind === "agent" &&
      call.access.authorize("agent.write", {
        kind: "agent",
        name: asset.name,
        assetId: read.id,
        ...(address.workspaceId ? { workspaceId: address.workspaceId } : {})
      }).allowed
        ? await workflow.agentDrafts.get(call, address)
        : undefined;
    const published =
      asset.kind === "agent"
        ? read.revision
        : "publishedRevision" in read
          ? read.publishedRevision
          : undefined;
    const revision = read.revision;
    return {
      kind: read.kind,
      name: read.name,
      config: proposed?.config ?? read.config ?? {},
      revision,
      ...(read.saveApproval ? { saveApproval: read.saveApproval } : {}),
      ...(asset.kind === "agent" ? { draftRevision: proposed?.revision ?? null } : {}),
      ...(published === undefined ? {} : { publishedRevision: published }),
      shows: !proposed && published !== undefined && published === revision ? "published" : "draft",
      ...(address.workspaceId === undefined ? {} : { workspaceId: address.workspaceId })
    };
  }

  /** The kinds that exist here: a kind of a module that is off does not. */
  const existingKinds = () =>
    options.configAssets.kinds.kinds.filter(
      (kind) => options.modules.offModuleOf("kind", kind.kind) === undefined
    );

  const allowed = (decision: OperationAuthorization): void => {
    if (!decision.allowed) {
      throw operationDenialError({
        kind: "forbidden",
        action: decision.action,
        reason: decision.reason
      });
    }
  };

  /** What a save writes: its config, or the files of a kind written as files. */
  const contentOf = (input: PlatformAssetPut) => ({
    ...(input.config === undefined ? {} : { config: input.config }),
    ...(input.files === undefined ? {} : { files: input.files })
  });

  /** The kinds a first save of a conversation creates, as far as they exist here. */
  const creatableKinds = () =>
    existingKinds().filter((kind) => CREATED_FROM_CHAT.includes(kind.kind));

  /** The one issue of a config that names another asset than the conversation is about. */
  const otherName = (subject: ConversationSubject, config: Record<string, unknown>) =>
    readDefinitionName(config) === subject.name
      ? undefined
      : {
          path: "name",
          code: "subject_mismatch",
          message: `The config names another asset than this conversation is about. 'name' is '${subject.name}'`
        };

  return {
    options,
    workflow,
    centralFloor,
    putFloor,
    titleOf,
    pageApps,
    conversationOfCall,
    conversationOf,
    callOf,
    addressOf,
    createdHere,
    bound,
    putTarget,
    readAsset,
    allowed,
    contentOf,
    creatableKinds,
    otherName
  };
}
