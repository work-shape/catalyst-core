import {
  AppError,
  type AccessResource,
  type ActorAccess,
  type ConfigAssetRecord
} from "@vivd-catalyst/core";
import type { WorkflowAssetKind } from "./asset-kinds/shared";
import type { ChatServerOptions } from "./types";

// The precondition every write of an asset carries, and what a write is told that was made
// against another revision. One shape on every surface: the single write and the batch.

/** `details.reason` of the refusal of a write that names no expected revision. */
const PRECONDITION_REQUIRED_REASON = "precondition_required";
/** `details.reason` of the refusal of a write made against another revision. */
const REVISION_CONFLICT_REASON = "revision_conflict";

/**
 * One asset a write was made against another revision of. The name is the one the caller
 * sent. Everything else is told only to a caller who may read the asset's history: the
 * revision it is at, whether that revision is its delete, who wrote it and when.
 */
export interface RevisionConflict {
  kind: string;
  name: string;
  /** `null` where no asset of the name was ever stored. */
  currentRevision?: number | null;
  /** The current revision is the delete of the asset: its tombstone. */
  deleted?: true;
  changedBy?: string;
  changedAt?: string;
}

/** An asset whose revision is not the one a write named, as the write read it. */
export interface StaleAsset {
  kind: WorkflowAssetKind;
  name: string;
  /** What the caller's right on the asset is decided on. */
  resource: AccessResource;
  /** The row of the name as it is now, a deleted one included. Absent where there is none. */
  asset?: Pick<ConfigAssetRecord, "revision" | "status">;
  /** Who wrote the current revision and when, where the store said so with its refusal. */
  change?: { changedBy?: string; changedAt?: string };
}

type RevisionReader = Pick<ChatServerOptions, "clientInstanceId" | "configAssets">;

/**
 * Whether the caller reads the history of the asset: the read right of the kind, or for a
 * kind with a draft the right its drafts are read with. It is what `assets.revisions.list`
 * asks, so a conflict tells nothing that list would refuse.
 */
function readsHistory(access: ActorAccess, stale: StaleAsset): boolean {
  const { read, write, publish } = stale.kind.actions;
  const holds = (action: string) => access.authorize(action, stale.resource).allowed;
  return stale.kind.lifecycle === "draft_published"
    ? holds(write) || (publish !== undefined && holds(publish))
    : holds(read);
}

/**
 * What a caller is told of each stale asset. One revision is read per asset the caller may
 * read and the store named no writer of, so the cost is bounded by the items of one batch.
 */
export async function describeConflicts(
  options: RevisionReader,
  access: ActorAccess,
  stale: readonly StaleAsset[]
): Promise<RevisionConflict[]> {
  const conflicts: RevisionConflict[] = [];
  for (const entry of stale) {
    const named = { kind: entry.kind.kind, name: entry.name };
    if (!readsHistory(access, entry)) {
      conflicts.push(named);
      continue;
    }
    if (!entry.asset) {
      conflicts.push({ ...named, currentRevision: null });
      continue;
    }
    const change = entry.change ?? (await changeOf(options, entry, entry.asset.revision));
    conflicts.push({
      ...named,
      currentRevision: entry.asset.revision,
      ...(entry.asset.status === "deleted" ? { deleted: true as const } : {}),
      ...change
    });
  }
  return conflicts;
}

async function changeOf(
  options: RevisionReader,
  entry: StaleAsset,
  revision: number
): Promise<{ changedBy?: string; changedAt?: string }> {
  const written = await options.configAssets.store.getConfigAssetRevision({
    clientInstanceId: options.clientInstanceId,
    kind: entry.kind.kind,
    name: entry.name,
    revision
  });
  return written
    ? {
        ...(written.actor ? { changedBy: written.actor.displayLabel } : {}),
        changedAt: written.createdAt
      }
    : {};
}

/** The sentence of one conflict, in the words of what its caller may know. */
export function conflictMessage(conflict: RevisionConflict): string {
  const asset = `Config ${conflict.kind} '${conflict.name}'`;
  if (conflict.currentRevision === undefined) {
    return `${asset} is not at the revision the call names`;
  }
  if (conflict.currentRevision === null) {
    return `${asset} does not exist`;
  }
  return conflict.deleted
    ? `${asset} was deleted at revision ${conflict.currentRevision}. Creating it again names that revision`
    : `${asset} is at revision ${conflict.currentRevision}`;
}

/** The refusal of a write that was made against another revision than the current one. */
function revisionConflictError(conflicts: readonly RevisionConflict[]): AppError {
  const [first] = conflicts;
  return new AppError(
    "REVISION_CONFLICT",
    conflicts.length === 1 && first
      ? conflictMessage(first)
      : `${conflicts.length} assets are not at the revisions the call names`,
    { reason: REVISION_CONFLICT_REASON, conflicts }
  );
}

/** The refusal of one write made against another revision, told as its caller may read it. */
export async function revisionConflictOf(
  options: RevisionReader,
  access: ActorAccess,
  stale: StaleAsset
): Promise<AppError> {
  return revisionConflictError(await describeConflicts(options, access, [stale]));
}

/** The refusal of a write that names no revision for the assets it writes. */
function preconditionRequiredError(assets: readonly { kind: string; name: string }[]): AppError {
  const named = assets.map(({ kind, name }) => `${kind} '${name}'`).join(", ");
  return new AppError(
    "PRECONDITION_REQUIRED",
    `'expectedRevision' is missing for ${named}: send the revision that was read, or null to create the asset`,
    {
      reason: PRECONDITION_REQUIRED_REASON,
      assets: assets.map(({ kind, name }) => ({ kind, name }))
    }
  );
}

/**
 * A write names the revision it was made against: a number, or `null` for an asset that was
 * never stored. A write that names none is refused, never taken as leave to overwrite.
 */
export function requirePrecondition<Expected extends number | null>(
  address: { kind: string; name: string },
  expected: Expected | undefined
): Expected {
  if (expected === undefined) {
    throw preconditionRequiredError([address]);
  }
  return expected;
}

/**
 * The revision the name is at, whatever its state: a deleted asset keeps its last revision,
 * the tombstone, and `null` is a name that was never stored.
 */
export function currentRevisionOf(
  asset: Pick<ConfigAssetRecord, "revision"> | undefined
): number | null {
  return asset?.revision ?? null;
}
