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
import { AssetWorkflow } from "./asset-workflow";
import type { AssetWorkflowOptions } from "./types";

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
 * not have, an asset that does not exist and one the caller holds no read right on are told
 * the same way, so the refusal says nothing of what is stored. An asset of a kind without a
 * draft, such as an agent, may be a subject: the agent reads it, and its tools save drafts only.
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
    decision = await new AssetWorkflow(options).authorizeRead(await accessOf(options, actor), {
      kind: subject.kind,
      name: subject.name,
      ...(asset?.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {})
    });
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
 * The kinds the agent's first save of a conversation creates (NAV-2): each has a page the
 * person is taken to. An App is made from a Page (`page.save_as_app`), a Connection by a
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

/** The refusal of a first save in a conversation that is about an asset already. */
export const subjectTaken = (subject: ConversationSubject) =>
  new AppError(
    "VALIDATION_FAILED",
    `This conversation is about the ${subject.kind} '${subject.name}': a save of it sends the revision you read as 'expectedRevision'. A new asset is made in a conversation about none: ask the person to start a new one`,
    { reason: "conversation_has_subject" },
    { exposeMessage: true }
  );

/** The refusal of a first save that names no kind it creates, or no name. */
export const createUnnamed = (kinds: readonly string[]) =>
  new AppError(
    "VALIDATION_FAILED",
    `A first save creates an asset: name its 'kind', one of ${kinds.join(", ")}, and its 'name'`,
    { reason: "create_unnamed" },
    { exposeMessage: true }
  );
