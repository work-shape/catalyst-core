import {
  AppError,
  DATA_STORE_ASSET_KIND,
  WORKFLOW_ASSET_KIND,
  createAuthorizer,
  type ActorAccess,
  type AuthenticatedIdentity,
  type ConfigAssetRecord,
  type Conversation,
  type ConversationSubject,
  type OperationAuthorization
} from "@work-shape/catalyst-core";
import { AssetWorkflow } from "../assets/asset-service";
import { accessResource, readsAssetDraft } from "../assets/asset-access";
import type { AssetWorkflowOptions } from "../types";

// Which asset a conversation of the agent may be about, and which one its first save creates:
// the rules the agent's asset tools and the creation of a conversation ask alike.

type AssetOptions = Pick<
  AssetWorkflowOptions,
  "clientInstanceId" | "stores" | "authorizer" | "auditRecorder" | "configAssets" | "modules"
>;

export const accessOf = (
  options: AssetOptions,
  actor: AuthenticatedIdentity
): Promise<ActorAccess> =>
  (options.authorizer ?? createAuthorizer(options.stores.access)).forActor(actor);

/** One refusal for a subject that does not exist and for one its caller may not read. */
export const subjectUnavailable = () =>
  new AppError(
    "NOT_FOUND",
    "The subject of the conversation is not available",
    { reason: "subject_unavailable" },
    { exposeMessage: true }
  );

/**
 * Refuses a conversation about an asset its creator may not read. A kind the instance does
 * not have, an asset that does not exist and one the caller cannot read are told the same
 * way, so the refusal says nothing of what is stored. Workflow draft readers follow the
 * decision of assets.get, including its writers and publishers. An asset of a kind without a
 * draft, such as an agent, may be a subject: the agent reads it, and its tools save drafts only,
 * or an agent's change proposal.
 * The right is asked where the asset is: an asset a workspace owns is read with a right in
 * that workspace, as `assets.get` naming the workspace reads it.
 */
export async function requireReadableSubject(
  options: AssetWorkflowOptions,
  actor: AuthenticatedIdentity,
  subject: ConversationSubject
): Promise<void> {
  let decision: OperationAuthorization;
  let asset: ConfigAssetRecord | undefined;
  try {
    asset = await options.configAssets.store.getConfigAsset({
      clientInstanceId: options.clientInstanceId,
      kind: subject.kind,
      name: subject.name
    });
    const workflow = new AssetWorkflow(options);
    const access = await accessOf(options, actor);
    const address = {
      kind: subject.kind,
      name: subject.name,
      ...(asset?.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {})
    };
    // A Workflow builder reads its draft with assets.get's decision. Use alone still opens
    // no subject conversation: everyone else needs the ordinary read right, as before.
    const kind = options.configAssets.kinds.get(subject.kind);
    const readsDraft =
      subject.kind === WORKFLOW_ASSET_KIND &&
      asset !== undefined &&
      kind !== undefined &&
      readsAssetDraft(kind, access, accessResource(asset.kind, asset.name, asset.scope, asset.id));
    decision = await (readsDraft
      ? workflow.reads.authorizeGet(access, { ...address, revision: "draft" })
      : workflow.authorizeRead(access, address));
  } catch {
    // The kind is unknown here, or of a module that is off.
    throw subjectUnavailable();
  }
  if (!decision.allowed) throw subjectUnavailable();
  if (asset?.status !== "active") throw subjectUnavailable();
}

/**
 * Refuses to open or read an asset in a transcript that others read. A member of a Shared
 * Workspace need not hold the read right on the asset, so a conversation about one is its
 * creator's alone, as `createConversation` makes it.
 */
export async function requireOwnTranscript(
  options: Pick<AssetWorkflowOptions, "clientInstanceId" | "stores">,
  conversation: Conversation
): Promise<void> {
  if (conversation.visibility === "private") return;
  const workspace = await options.stores.workspaces.getWorkspace(
    options.clientInstanceId,
    conversation.collaborationWorkspaceId
  );
  if (workspace?.kind === "personal") return;
  throw new AppError(
    "CONFLICT",
    "This conversation is shared with its workspace, and an asset is opened and read only in a conversation of the person's own. Ask the person to start a new conversation, or to open the asset's page and choose Edit with the agent",
    { reason: "subject_conversation_shared" },
    { exposeMessage: true }
  );
}

/** Whether an asset belongs to the whole instance, which only a person's step makes a subject. */
export async function ofInstance(
  options: AssetWorkflowOptions,
  named: ConversationSubject
): Promise<boolean> {
  const row = await options.configAssets.store.getConfigAsset({
    clientInstanceId: options.clientInstanceId,
    kind: named.kind,
    name: named.name
  });
  return row?.scope.kind !== "workspace";
}

/**
 * The kinds the agent's save creates (NAV-2, BUILD-ALL-1): each has a page. The first create of
 * a conversation about no asset takes the person there; a later one leaves them where they are. An App is made from what the preview shows (`app.save`), a Connection by a
 * person in its dialog.
 */
export const CREATED_FROM_CHAT: readonly string[] = [
  WORKFLOW_ASSET_KIND,
  DATA_STORE_ASSET_KIND,
  "agent",
  "skill"
];

/**
 * Who owns an asset a conversation creates: the conversation's workspace, where the kind can
 * be owned by one, else the instance (WS-OWN-1a; a Workflow belongs to the instance).
 */
export const ownerOf = (
  kind: { owners: readonly string[] },
  conversation: Conversation
): { workspaceId?: string } =>
  kind.owners.includes("workspace") ? { workspaceId: conversation.collaborationWorkspaceId } : {};

/**
 * The refusal of a change of an asset that is neither the conversation's subject nor a draft
 * the conversation created (BUILD-ALL-1). It says nothing of whether the asset exists.
 */
export const notOfConversation = (
  subject: ConversationSubject | undefined,
  named: ConversationSubject
) =>
  new AppError(
    "CONFLICT",
    `${subject ? `This conversation is about the ${subject.kind} '${subject.name}'` : "This conversation is about no asset yet"}, and it did not create the ${named.kind} '${named.name}'. A save reaches the asset the conversation is about and the drafts this conversation created. To change an asset that existed before, open it with platform.assets.open first`,
    { reason: "asset_not_of_conversation" },
    { exposeMessage: true }
  );

/** The refusal of a save without a revision that names no kind it creates, or no name. */
export const createUnnamed = (kinds: readonly string[]) =>
  new AppError(
    "VALIDATION_FAILED",
    `A save without 'expectedRevision' creates an asset: name its 'kind', one of ${kinds.join(", ")}, and its 'name'`,
    { reason: "create_unnamed" },
    { exposeMessage: true }
  );
