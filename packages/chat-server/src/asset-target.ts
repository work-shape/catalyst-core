import {
  AppError,
  auditActorFromIdentity,
  type AccessResource,
  type AssetScope,
  type ConfigAssetRecord,
  type JsonObject
} from "@vivd-catalyst/core";
import type { AssetCall } from "./asset-access";
import type { WorkflowAssetKind } from "./asset-kinds/shared";
import { currentRevisionOf, revisionConflictOf } from "./asset-revision";
import { assertScopeCanOwn } from "./config-asset-writer";
import type { ChatServerOptions } from "./types";

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
  /** What the caller's right is decided on. */
  resource: AccessResource;
  /** The address the target was read for. */
  address: AssetAddress;
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
 * whether or not another owner holds the name: it tells nothing of an asset the caller may not
 * read.
 */
export function requireOwnScope(target: AssetTarget): void {
  assertScopeCanOwn(target.kind, target.scope);
  if (target.elsewhere) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Config ${target.kind.kind} '${target.name}' belongs to another scope`,
      { reason: "invalid_scope" }
    );
  }
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
 * Refuses a write made against another revision than the name is at. `null` expects a name
 * that was never stored: a deleted asset is created again only by a write that names the
 * revision of its delete.
 */
export async function requireExpectedRevision(
  options: Pick<ChatServerOptions, "clientInstanceId" | "configAssets">,
  call: AssetCall,
  target: AssetTarget,
  expected: number | null
): Promise<void> {
  if (currentRevisionOf(target.asset) !== expected) {
    throw await revisionConflictOf(options, call.access, target);
  }
}

/**
 * Asks the kind whether the stored asset takes a write at all. It runs once the caller holds
 * the right and before the write is read, so a stale revision or a config that would not
 * validate answers the same refusal.
 */
export function assertStoredWritable(target: AssetTarget): void {
  if (target.asset?.status === "active") {
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
