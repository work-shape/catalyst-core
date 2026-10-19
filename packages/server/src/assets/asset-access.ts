import {
  asCollaborationWorkspaceId,
  INSTANCE_ASSET_SCOPE,
  liveRevisionId,
  type AccessResource,
  type AppError,
  type ActorAccess,
  type AssetScope,
  type AuditRecorder,
  type AuditEventStore,
  type ClientInstanceId,
  type AuthenticatedIdentity,
  type CollaborationWorkspaceId,
  type ConversationId,
  type ConfigAssetKey,
  type OperationAuthorization,
  type OperationCallRuntime,
  type OperationRunId,
  type ServedFileSetAsset
} from "@work-shape/catalyst-core";
import { z } from "zod";
import type { WorkflowAssetKind } from "../asset-kinds/shared";
import type { AssetSetIssue } from "./asset-set";

/** What an asset operation knows about its caller: the call of the Operation Run. */
export interface AssetCall {
  actor: AuthenticatedIdentity;
  buildConversationId?: ConversationId;
  access: ActorAccess;
  /** Writes audit rows that carry the run's id. */
  audit: AuditRecorder;
  correlationId: string;
  /**
   * The Operation Run of the call. A save to a repository is keyed by it, so a call that has
   * none cannot write an asset that has a repository.
   */
  runId?: OperationRunId;
  /** The workspace the call is made in: the conversation's for a call of an agent. */
  workspaceId?: CollaborationWorkspaceId;
  /** The language the request names, where a person's request made the call. */
  runtime?: Pick<OperationCallRuntime, "locale">;
}

/** Mutation events inside an asset transaction commit with the state they describe. */
export function transactionalAssetCall(
  call: AssetCall,
  clientInstanceId: ClientInstanceId,
  audit: AuditEventStore
): AssetCall {
  return {
    ...call,
    audit: {
      record: (input) =>
        audit.appendAuditEvent({
          ...input,
          clientInstanceId,
          metadata: { ...input.metadata, ...(call.runId ? { operationRunId: call.runId } : {}) }
        })
    }
  };
}

/** What a right on one asset is decided on: its kind, its name, its id and its owner. */
export function accessResource(
  kind: string,
  name: string,
  scope: AssetScope,
  assetId: string | undefined,
  appAvailability?: AccessResource["appAvailability"]
): AccessResource {
  return {
    kind,
    ...(appAvailability ? { appAvailability } : {}),
    ...(name === "" ? {} : { name }),
    ...(assetId === undefined ? {} : { assetId }),
    ...(scope.kind === "workspace" ? { workspaceId: scope.workspaceId } : {})
  };
}

export function decide(
  access: ActorAccess,
  action: string,
  resource: AccessResource
): OperationAuthorization {
  const decision = access.authorize(action, resource);
  return decision.allowed ? { allowed: true } : { allowed: false, action, reason: decision.reason };
}

/**
 * The right to delete, and no deny on reading or writing the asset: the delete right is no
 * way around a deny on either.
 */
export function deleteDecision(
  access: ActorAccess,
  target: { kind: WorkflowAssetKind; resource: AccessResource }
): OperationAuthorization {
  const { actions } = target.kind;
  const right = decide(access, actions.delete, target.resource);
  if (!right.allowed) return right;
  for (const action of [actions.read, actions.write]) {
    const decision = access.authorize(action, target.resource);
    if (!decision.allowed && decision.reason === "denied") {
      return { allowed: false, action, reason: "denied" };
    }
  }
  return { allowed: true };
}

/**
 * Whether a holder is served a file set of an asset. Whoever writes the asset is served every
 * revision of it. Its users are served the one revision `liveRevisionId` names and no other:
 * a draft, and a revision that was published once, are for its writers alone.
 */
export function mayOpenAssetFileSet(
  kind: WorkflowAssetKind | undefined,
  access: ActorAccess,
  asset: ServedFileSetAsset
): boolean {
  if (!kind) {
    return false;
  }
  const resource = accessResource(
    kind.kind,
    asset.name,
    asset.workspaceId === undefined
      ? INSTANCE_ASSET_SCOPE
      : { kind: "workspace", workspaceId: asCollaborationWorkspaceId(asset.workspaceId) },
    asset.id,
    asset.appAvailability
  );
  if (access.authorize(kind.actions.write, resource).allowed) {
    return true;
  }
  const live = liveRevisionId(asset, kind);
  return (
    live !== undefined &&
    asset.revisionIds.includes(live) &&
    kind.actions.use !== undefined &&
    access.authorize(kind.actions.use, resource).allowed
  );
}

const issuesDetailsSchema = z.object({
  issues: z.array(
    z.object({
      message: z.string(),
      // A kind's own parser names a place as one text, such as `steps[1].type`.
      path: z.union([z.string(), z.array(z.union([z.string(), z.number()]))]).optional(),
      code: z.string().optional()
    })
  )
});

/**
 * The issues an error carries, each with its place and its code where the check that found
 * it names them, or the error's message where it carries none.
 */
export function errorIssues(error: AppError): AssetSetIssue[] {
  const details = issuesDetailsSchema.safeParse(error.details);
  return details.success && details.data.issues.length > 0
    ? details.data.issues.map(({ message, path, code }) => ({
        message,
        ...(path === undefined || path === "" || path.length === 0
          ? {}
          : { path: typeof path === "string" ? [path] : path }),
        ...(code === undefined ? {} : { code })
      }))
    : [{ message: error.message }];
}

/** What a chooser offers is also what a write may reference; use alone exposes no draft. */
export function listedTo(
  kind: WorkflowAssetKind,
  access: ActorAccess,
  asset: Pick<ConfigAssetKey, "kind" | "name" | "scope" | "id" | "published" | "appAvailability">
): boolean {
  const resource = accessResource(
    asset.kind,
    asset.name,
    asset.scope,
    asset.id,
    asset.appAvailability
  );
  return (
    access.authorize(kind.actions.read, resource).allowed ||
    readsAssetDraft(kind, access, resource) ||
    ((kind.lifecycle === "active" || asset.published === true) &&
      kind.actions.use !== undefined &&
      access.authorize(kind.actions.use, resource).allowed)
  );
}

/** App and Workflow builders read the same draft in the list as in assets.get. */
export function readsAssetDraft(
  kind: WorkflowAssetKind,
  access: ActorAccess,
  resource: AccessResource
): boolean {
  return (
    (kind.kind === "app" || kind.kind === "workflow") &&
    (access.authorize(kind.actions.write, resource).allowed ||
      (kind.actions.publish !== undefined &&
        access.authorize(kind.actions.publish, resource).allowed))
  );
}
