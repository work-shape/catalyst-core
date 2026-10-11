import {
  AppError,
  asCollaborationWorkspaceId,
  INSTANCE_ASSET_SCOPE,
  liveRevisionId,
  type AccessResource,
  type ActorAccess,
  type AssetScope,
  type AuditRecorder,
  type AuthenticatedIdentity,
  type OperationAuthorization,
  type ServedFileSetAsset
} from "@vivd-catalyst/core";
import { z } from "zod";
import type { WorkflowAssetKind } from "./asset-kinds/shared";
import type { AssetSetIssue } from "./asset-set";

/** What an asset operation knows about its caller: the call of the Operation Run. */
export interface AssetCall {
  actor: AuthenticatedIdentity;
  access: ActorAccess;
  /** Writes audit rows that carry the run's id. */
  audit: AuditRecorder;
  correlationId: string;
}

/** What a right on one asset is decided on: its kind, its name, its id and its owner. */
export function accessResource(
  kind: string,
  name: string,
  scope: AssetScope,
  assetId: string | undefined
): AccessResource {
  return {
    kind,
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
    asset.id
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

/** The refusal of a write that was made against another revision than the current one. */
export function conflict(kind: string, name: string, currentRevision: number | null): AppError {
  return new AppError(
    "CONFLICT",
    currentRevision === null
      ? `Config ${kind} '${name}' does not exist`
      : `Config ${kind} '${name}' is at revision ${currentRevision}`,
    { kind, name, currentRevision }
  );
}

const issuesDetailsSchema = z.object({
  issues: z.array(z.object({ message: z.string(), path: z.array(z.unknown()).optional() }))
});

/** The issues an error carries, or its message where it carries none. */
export function errorIssues(error: AppError): AssetSetIssue[] {
  const details = issuesDetailsSchema.safeParse(error.details);
  return details.success && details.data.issues.length > 0
    ? details.data.issues.map(({ message }) => ({ message }))
    : [{ message: error.message }];
}
