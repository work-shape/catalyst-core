import {
  AppError,
  INSTANCE_ASSET_SCOPE,
  asCollaborationWorkspaceId,
  assetScopesEqual,
  assetNameIssue,
  auditActorFromIdentity,
  type AccessResource,
  type ActorAccess,
  type AssetScope,
  type ConfigAssetRecord,
  type JsonObject
} from "@work-shape/catalyst-core";
import { accessResource, type AssetCall } from "./asset-access";
import type { WorkflowAssetKind } from "../asset-kinds/shared";
import {
  currentRevisionOf,
  nameOnlyConflict,
  readsHistory,
  revisionConflictOf
} from "./asset-revision";
import { assertScopeCanOwn } from "./config-asset-writer";
import type { AssetWorkflowOptions } from "../types";

// What the address of a call comes to, and what every write asks of it before it writes.

/** One asset as a call names it. Without a workspace it is one of the instance's own. */
export interface AssetAddress {
  kind: string;
  name: string;
  workspaceId?: string;
}

/** What a call's address comes to once the store is read. */
export interface AssetTarget {
  kind: WorkflowAssetKind;
  name: string;
  scope: AssetScope;
  /** The row that carries the name in the addressed scope, a deleted one included. */
  asset?: ConfigAssetRecord;
  /** An asset of another scope carries the name. The call never reads or writes it. */
  elsewhere: boolean;
  /** That asset, as far as the caller's right to read it is decided on. */
  other?: Pick<ConfigAssetRecord, "id" | "scope">;
  /** What the caller's right is decided on. */
  resource: AccessResource;
  /** The address the target was read for. */
  address: AssetAddress;
}

export function scopeOf(workspaceId: string | undefined): AssetScope {
  return workspaceId === undefined
    ? INSTANCE_ASSET_SCOPE
    : { kind: "workspace", workspaceId: asCollaborationWorkspaceId(workspaceId) };
}

/** Resolves a name once, keeping another owner's row out of the requested scope. */
export async function resolveAssetTarget(
  options: Pick<AssetWorkflowOptions, "clientInstanceId" | "configAssets">,
  kind: WorkflowAssetKind,
  address: AssetAddress
): Promise<AssetTarget> {
  const scope = scopeOf(address.workspaceId);
  const row =
    address.name === ""
      ? undefined
      : await options.configAssets.store.getConfigAsset({
          clientInstanceId: options.clientInstanceId,
          kind: kind.kind,
          name: address.name
        });
  // A deleted asset keeps its row, its revisions and the deny rows on it, so its history and
  // its name are decided with the same id as before the delete. A row of another scope is
  // not this call's asset: its id is no part of what the right is decided on.
  const asset = row && assetScopesEqual(row.scope, scope) ? row : undefined;
  return {
    kind,
    name: address.name,
    scope,
    ...(asset ? { asset } : {}),
    elsewhere: row !== undefined && asset === undefined,
    ...(row !== undefined && asset === undefined
      ? { other: { id: row.id, scope: row.scope } }
      : {}),
    resource: accessResource(kind.kind, address.name, scope, asset?.id),
    address
  };
}

export function requireActive(target: AssetTarget): ConfigAssetRecord & { config: JsonObject } {
  const { asset } = target;
  if (!asset || asset.status !== "active" || asset.config === null) {
    throw notFound(target);
  }
  return { ...asset, config: asset.config };
}

export function notFound(target: Pick<AssetTarget, "kind" | "name">): AppError {
  return new AppError("NOT_FOUND", `Config ${target.kind.kind} '${target.name}' was not found`);
}

/**
 * A name belongs to one owner. A write that means another one is refused, never moved. Whether
 * the owner the call names can own the kind at all is asked first, so that refusal is the same
 * whether or not another owner holds the name.
 *
 * Only a caller who may read the asset of the other owner is told that it is there. Everyone
 * else is answered as a write against another revision is answered a caller who reads nothing:
 * with the name alone. A name is unique on the instance, so that much cannot be kept back.
 */
export function requireOwnScope(target: AssetTarget, access: ActorAccess): void {
  assertScopeCanOwn(target.kind, target.scope);
  if (!target.elsewhere) {
    return;
  }
  if (readsOther(access, target)) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Config ${target.kind.kind} '${target.name}' belongs to another scope`,
      { reason: "invalid_scope" }
    );
  }
  throw nameOnlyConflict(target);
}

/** Whether the caller may read the asset of another owner that carries the name. */
export function readsOther(
  access: ActorAccess,
  target: Pick<AssetTarget, "kind" | "name" | "other">
): boolean {
  const { other, kind, name } = target;
  return (
    other !== undefined &&
    access.authorize(kind.actions.read, accessResource(kind.kind, name, other.scope, other.id))
      .allowed
  );
}

/**
 * Whether the caller reads the asset the call addresses. Who does not is told nothing the
 * store holds of it: neither that it is there, nor that it is gone, nor what it is.
 */
export function readsTarget(access: ActorAccess, target: AssetTarget): boolean {
  return readsHistory(access, target);
}

/**
 * A create of a kind whose name is its id: refused where any asset of the kind carries the
 * name, whoever owns it. The id is unique on the instance, so the refusal tells nothing more.
 */
export function requireFreeName(target: AssetTarget): void {
  if (target.asset?.status === "active" || target.elsewhere) {
    throw new AppError(
      "CONFLICT",
      `The ${target.kind.kind} id '${target.name}' is taken on this instance`,
      { reason: `${target.kind.kind}_id_taken`, kind: target.kind.kind, name: target.name }
    );
  }
}

/**
 * A fresh create (`expectedRevision: null`) cannot take any stored name: names are unique
 * per instance and kind, and deletion keeps the revision. The check asks the same write
 * right as that create. Its refusal repeats only the submitted kind and name, through the
 * same generic conflict as a non-reader's create: no title, owner, workspace, revision or
 * deleted state. Active and deleted names therefore give a non-reader identical answers.
 * Restoring a deleted asset names its deletion revision; that is not a fresh create.
 */
export function nameCheckOf(
  target: AssetTarget
):
  | { available: true }
  | { available: false; reason: "name_invalid" | "name_taken"; message: string } {
  const issue = assetNameIssue(target.kind, target.name);
  if (issue) return { available: false, reason: "name_invalid", message: issue.message };
  const held = target.elsewhere || currentRevisionOf(target.asset) !== null;
  return held
    ? {
        available: false,
        reason: "name_taken",
        message: nameOnlyConflict(target).message
      }
    : { available: true };
}

/**
 * Refuses a write made against another revision than the name is at. `null` expects a name
 * that was never stored: a deleted asset is created again only by a write that names the
 * revision of its delete.
 */
export async function requireExpectedRevision(
  options: Pick<AssetWorkflowOptions, "clientInstanceId" | "configAssets">,
  call: AssetCall,
  target: AssetTarget,
  expected: number | null
): Promise<void> {
  if (currentRevisionOf(target.asset) !== expected) {
    throw await revisionConflictOf(options, call.access, target);
  }
}

/**
 * The delete of an asset that is not at the revision the call names, or not there at all. A
 * caller who reads the asset is told which: that it was not found, or what it is at. One who
 * does not is answered the same for both, with the name alone, so a delete tells such a
 * caller nothing of whether an asset exists.
 */
export async function requireDeletable(
  options: Pick<AssetWorkflowOptions, "clientInstanceId" | "configAssets">,
  call: AssetCall,
  target: AssetTarget,
  expected: number
): Promise<ConfigAssetRecord & { config: JsonObject }> {
  const { asset } = target;
  const active = asset?.status === "active" && asset.config !== null;
  if (!active && readsTarget(call.access, target)) {
    throw notFound(target);
  }
  if (!asset || !active || asset.config === null || asset.revision !== expected) {
    throw await revisionConflictOf(options, call.access, target);
  }
  return { ...asset, config: asset.config };
}

/**
 * Asks the kind whether the stored asset takes a write at all. A caller who reads the asset
 * is asked once the right is held and before the write is read, so a stale revision or a
 * config that would not validate answers the same refusal. A caller who does not read it is
 * asked with `always` only once the revision the call names is the asset's: the refusal
 * depends on what is stored, which a write against another revision is told nothing of.
 */
export function assertStoredWritable(target: AssetTarget, access: ActorAccess | "always"): void {
  if (target.asset?.status !== "active") return;
  if (access === "always" || readsTarget(access, target)) {
    target.kind.assertStoredWritable?.({ current: target.asset.config });
  }
}

/** One audit row of a write to an asset, through the recorder of the call's Operation Run. */
export async function recordAssetEvent(
  call: AssetCall,
  type: string,
  metadata: JsonObject
): Promise<void> {
  // The recorder of the Operation Run: the row names the run that wrote it.
  const auditRecorder = call.audit;
  await auditRecorder.record({
    type,
    status: "success",
    actor: auditActorFromIdentity(call.actor),
    correlationId: call.correlationId,
    metadata
  });
}

/**
 * Records what a committed write of assets is recorded with. From the commit on the write has
 * happened: a row that cannot be written is logged and the others are still tried, and the
 * call is answered with what it wrote, as the operation layer answers a call it could not
 * record. An error here would tell the caller that nothing was written.
 */
export async function recordCommitted(
  options: Pick<AssetWorkflowOptions, "logger">,
  call: AssetCall,
  records: readonly (() => Promise<void>)[]
): Promise<void> {
  for (const record of records) {
    try {
      await record();
    } catch (error) {
      options.logger.error(
        { correlationId: call.correlationId, error: error instanceof Error ? error.message : "" },
        "An asset write was committed but recording it failed"
      );
    }
  }
}
