import {
  AppError,
  INSTANCE_ASSET_SCOPE,
  isAppError,
  type ActorAccess,
  type ConfigAssetRecord
} from "@vivd-catalyst/core";
import { accessResource, errorIssues } from "./asset-access";
import type { WorkflowAssetKind } from "./asset-kinds/shared";
import {
  conflictMessage,
  describeConflicts,
  type RevisionConflict,
  type StaleAsset
} from "./asset-revision";
import type { AssetSetIssue } from "./asset-set";
import type { ChatServerOptions } from "./types";

// The items of a batch as its checks plan them, and the one error of a batch that was not
// applied: what each item was refused for, and what its caller may know of a stale asset.

/** Why one item stops the batch. */
export interface ItemRefusal {
  code:
    | "FORBIDDEN"
    | "NOT_FOUND"
    | "PRECONDITION_REQUIRED"
    | "REVISION_CONFLICT"
    | "CONFLICT"
    | "VALIDATION_FAILED";
  message: string;
  /** The right the caller lacks, for a refusal of rights. */
  action?: string;
  /** What the asset is at, for an item made against another revision, told to its readers. */
  currentRevision?: number | null;
  /** The entry of `details.conflicts` the item stands for. */
  conflict?: RevisionConflict;
}

/** Which refusal names the batch's error, where its items were refused for different reasons. */
const REFUSAL_ORDER = [
  "FORBIDDEN",
  "NOT_FOUND",
  "PRECONDITION_REQUIRED",
  "REVISION_CONFLICT",
  "CONFLICT",
  "VALIDATION_FAILED"
] as const;

export function toRefusal(error: AppError): ItemRefusal {
  const code = REFUSAL_ORDER.find((candidate) => candidate === error.code);
  if (!code) {
    throw error;
  }
  return {
    code,
    message: errorIssues(error)
      .map(({ message }) => message)
      .join("; ")
  };
}

/** Runs a rule of a kind that refuses by throwing, and answers its refusal. */
export function refusalOf(rule: () => void): ItemRefusal | undefined {
  try {
    rule();
    return undefined;
  } catch (error) {
    if (isAppError(error)) {
      return toRefusal(error);
    }
    throw error;
  }
}

/**
 * One write of a batch. Each names the revision it was made against: `null` on a put creates
 * the asset. An item that names none refuses the batch.
 */
export type AssetSyncItem =
  | {
      type: "put";
      kind: string;
      config: Record<string, unknown>;
      expectedRevision?: number | null;
    }
  | { type: "delete"; kind: string; name: string; expectedRevision?: number };

export interface PlannedItem {
  index: number;
  item: AssetSyncItem;
  name?: string;
  kind?: WorkflowAssetKind;
  /** The instance's own row of the name, a deleted one included. */
  asset?: ConfigAssetRecord;
  /** A delete of a release whose asset is not there: nothing is written for it. */
  absent?: boolean;
  refusal?: ItemRefusal;
}

/** An item that passed the checks of its own input: its kind is registered and it has a name. */
export type ReadyItem = PlannedItem & { name: string; kind: WorkflowAssetKind };

export function isReady(entry: PlannedItem): entry is ReadyItem {
  return entry.kind !== undefined && entry.name !== undefined && entry.refusal === undefined;
}

/** An item made against another revision, with what is known of the asset now. */
export interface StaleItem {
  entry: ReadyItem;
  /** The row as the store read it under its lock, where it refused the batch. */
  asset?: StaleAsset["asset"];
  change?: StaleAsset["change"];
}

/** Refuses the batch for the items that were made against another revision, if any. */
export async function refuseStale(
  options: ChatServerOptions,
  access: ActorAccess,
  stale: readonly ReadyItem[]
): Promise<void> {
  if (stale.length === 0) return;
  const items = stale.map((entry): StaleItem => ({ entry, asset: entry.asset }));
  for (const [index, conflict] of (await conflictsOf(options, access, items)).entries()) {
    const entry = stale[index];
    if (entry) entry.refusal = staleRefusal(conflict);
  }
}

/** The refusal of a batch the store found stale under its lock. */
export async function staleBatch(
  options: ChatServerOptions,
  access: ActorAccess,
  planned: readonly PlannedItem[],
  stale: readonly StaleItem[]
): Promise<AppError> {
  for (const [index, conflict] of (await conflictsOf(options, access, stale)).entries()) {
    const entry = stale[index]?.entry;
    if (entry) entry.refusal = staleRefusal(conflict);
  }
  return refusedBatch(planned);
}

/** What the caller is told of each stale item, in the order of the items. */
function conflictsOf(
  options: ChatServerOptions,
  access: ActorAccess,
  stale: readonly StaleItem[]
): Promise<RevisionConflict[]> {
  return describeConflicts(
    options,
    access,
    stale.map(({ entry, asset, change }) => ({
      kind: entry.kind,
      name: entry.name,
      resource: accessResource(entry.kind.kind, entry.name, INSTANCE_ASSET_SCOPE, entry.asset?.id),
      ...(asset ? { asset } : {}),
      ...(change ? { change } : {})
    }))
  );
}

function staleRefusal(conflict: RevisionConflict): ItemRefusal {
  return {
    code: "REVISION_CONFLICT",
    message: conflictMessage(conflict),
    ...(conflict.currentRevision === undefined
      ? {}
      : { currentRevision: conflict.currentRevision }),
    conflict
  };
}

/**
 * The error of a batch that was not applied. `details.items` names every item: `refused` with
 * the reason for one that stopped the batch, `not_applied` for one that would have been
 * written. `details.issues` holds what the set as a whole was refused for. A batch refused for
 * its revisions carries `details.conflicts`, and one that names no revision for an asset
 * `details.assets`, each as the single write of an asset answers them.
 */
export function refusedBatch(
  planned: readonly PlannedItem[],
  issues: readonly AssetSetIssue[] = []
) {
  const refused = planned.flatMap((entry) => (entry.refusal ? [entry.refusal] : []));
  const code = REFUSAL_ORDER.find((candidate) => refused.some((entry) => entry.code === candidate));
  const conflicts = refused.flatMap(({ conflict }) => (conflict ? [conflict] : []));
  const unconditioned = planned.flatMap((entry) =>
    entry.refusal?.code === "PRECONDITION_REQUIRED" && entry.name !== undefined
      ? [{ kind: entry.item.kind, name: entry.name }]
      : []
  );
  return new AppError(
    code ?? "VALIDATION_FAILED",
    refused.length > 0
      ? `The batch was not applied: ${refused.length} of ${planned.length} items were refused`
      : "The batch was not applied: the assets it would leave are invalid",
    {
      reason: "sync_refused",
      items: planned.map((entry) => ({
        index: entry.index,
        type: entry.item.type,
        kind: entry.item.kind,
        ...(entry.name === undefined ? {} : { name: entry.name }),
        status: entry.refusal ? "refused" : "not_applied",
        ...(entry.refusal ? { error: refusalError(entry.refusal) } : {})
      })),
      ...(code === "REVISION_CONFLICT" && conflicts.length > 0 ? { conflicts } : {}),
      ...(code === "PRECONDITION_REQUIRED" ? { assets: unconditioned } : {}),
      ...(issues.length > 0 ? { issues: issues.map(({ message }) => ({ message })) } : {})
    }
  );
}

/** One refusal as an item of the error carries it. */
function refusalError({ conflict: _conflict, ...error }: ItemRefusal) {
  return error;
}
