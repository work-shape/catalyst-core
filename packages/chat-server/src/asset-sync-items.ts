import { AppError, assetScopesEqual, type ActorAccess } from "@work-shape/catalyst-core";
import { ASSET_SYNC_ITEM_MAX_BYTES } from "@work-shape/catalyst-api-contract";
import { z } from "zod";
import { readDefinitionName, type WorkflowAssetKind } from "./asset-kinds/shared";
import { definitionsByName, definitionsOf, type AssetSet } from "./asset-set";
import { accessResource } from "./asset-access";
import {
  assetKey,
  isReleaseSync,
  isReleasedKind,
  itemWriteDecision,
  loadStoredAssets,
  impliesDefaultChange,
  maxSyncItems,
  missingUpsertRightOf,
  preparedUpsert,
  requireAssetKindModuleOn,
  requireAssetManagementOn,
  requireBatchScope,
  requireReleaseSync
} from "./asset-write-rules";
import {
  isReady,
  refusedBatch,
  type ItemRefusal,
  type AssetSyncInput,
  type PlannedItem,
  type ReadyItem
} from "./asset-sync-refusals";
import { scopeOf } from "./asset-target";
import type { AssetWorkflowOptions } from "./types";

// The items of a batch before anything is written: what each is by its own input, the row it
// names, and every right its caller needs for it.

/**
 * What each item is by its own input, and the caller's right on every item that names an
 * asset: the write or the delete right at the asset's scope, or the release right in their
 * place. Throws the refusal of the batch where an item is refused by either, so a caller
 * without the rights learns nothing else.
 */
export async function authorizeItems(
  options: AssetWorkflowOptions,
  access: ActorAccess,
  input: AssetSyncInput
): Promise<PlannedItem[]> {
  // The module's switch is asked here because the release holder passes it: the operation
  // itself belongs to no module, so the route does not refuse it before the caller is known.
  requireAssetManagementOn(options, access, "sync");
  requireBatchScope(access, input);
  if (input.defaultAgentName !== undefined || input.expectedDefaultAgentName !== undefined) {
    requireReleaseSync(access, "sync");
  }
  if (input.items.length === 0 && input.defaultAgentName === undefined) {
    throw new AppError("VALIDATION_FAILED", "A batch needs an item or a default agent");
  }
  const maxItems = maxSyncItems(access);
  if (input.items.length > maxItems) {
    throw new AppError("VALIDATION_FAILED", `A batch holds at most ${maxItems} items`);
  }
  const releaseSync = isReleaseSync(access, "sync");
  const planned = planItems(options, input);
  // The rows of every item in one read, whatever their number.
  const rows = new Map(
    (
      await options.configAssets.store.listConfigAssetsByKey({
        clientInstanceId: options.clientInstanceId,
        keys: planned.filter(isReady).map((entry) => ({ kind: entry.kind.kind, name: entry.name }))
      })
    ).map((row) => [assetKey(row.kind, row.name), row])
  );
  for (const entry of planned.filter(isReady)) {
    if (releaseSync && !isReleasedKind(entry.kind)) {
      entry.refusal = {
        code: "VALIDATION_FAILED",
        message: `Asset kind '${entry.kind.kind}' is not part of a release`
      };
      continue;
    }
    const row = rows.get(assetKey(entry.kind.kind, entry.name));
    const own = row && assetScopesEqual(row.scope, entry.scope) ? row : undefined;
    const resource = accessResource(entry.kind.kind, entry.name, entry.scope, own?.id);
    const right = itemWriteDecision(
      access,
      "sync",
      { kind: entry.kind, resource },
      entry.item.type
    );
    if (!right.allowed) {
      entry.refusal = {
        code: "FORBIDDEN",
        message: `Missing the right '${right.action}'`,
        action: right.action
      };
    } else if (own) {
      entry.asset = own;
    } else if (row) {
      // The name is another owner's. What the item is told of it is decided with the
      // revisions, after every right.
      entry.other = { id: row.id, scope: row.scope };
    }
  }
  if (planned.some((entry) => entry.refusal)) {
    throw refusedBatch(planned);
  }
  // Every right first: the ones on the items above, then what the batch needs beside them.
  await requireFurtherRights(options, access, input, planned);
  // Asked once the caller holds every right, and before the policy and the guardrails: a
  // batch that names no revision for an asset is never taken as an overwrite.
  for (const entry of planned.filter(isReady)) {
    if (entry.item.expectedRevision === undefined) {
      entry.refusal = {
        code: "PRECONDITION_REQUIRED",
        message: `'expectedRevision' is missing: send the revision that was read${entry.item.type === "put" ? ", or null to create the asset" : ""}`
      };
    }
  }
  if (planned.some((entry) => entry.refusal)) {
    throw refusedBatch(planned);
  }
  return planned;
}

/** The refusal of an item whose asset is another one than the caller read. */
export const REPLACED_REFUSAL: ItemRefusal = {
  code: "CONFLICT",
  message:
    "The asset under this name is another one than the revision was read of: it was replaced, or this is another database. Read it again before writing"
};

/** What the store says of a batch it refused for an asset under another id. */
export const replacedSchema = z.object({
  reason: z.literal("asset_replaced"),
  assets: z.array(z.object({ kind: z.string(), name: z.string() }))
});

export function replacedRefusal(entry: ReadyItem): ItemRefusal | undefined {
  const { expectedAssetId } = entry.item;
  return expectedAssetId !== undefined && entry.asset && entry.asset.id !== expectedAssetId
    ? { ...REPLACED_REFUSAL }
    : undefined;
}

/**
 * The rights a batch needs beside those on its items: the write right on the instance where
 * it changes the instance default, and what a kind asks for a put beside its write right. They
 * are decided on what the caller sent, so they are known before the policy is asked. The
 * checks of the validated definitions stay where they are and decide again.
 */
async function requireFurtherRights(
  options: AssetWorkflowOptions,
  access: ActorAccess,
  input: AssetSyncInput,
  planned: PlannedItem[]
): Promise<void> {
  const ready = planned.filter(isReady);
  const [stored, namespaces] = await Promise.all([
    loadStoredAssets(options),
    options.stores.access.listNamespaceRecords({ clientInstanceId: options.clientInstanceId })
  ]);
  const storedByName = definitionsByName(stored.set);
  const defaultChange =
    input.defaultAgentName === undefined && impliesDefaultChange(access)
      ? planDefaultChange(
          options.configAssets.kinds.kinds,
          stored.set,
          leftByItems(access, storedByName, ready, stored.set),
          ready
        )
      : undefined;
  if (defaultChange && !access.authorize(defaultChange.entry.kind.actions.write).allowed) {
    defaultChange.entry.refusal = defaultChangeRefusal(defaultChange.entry.kind);
  }
  for (const entry of ready) {
    if (entry.item.type !== "put" || entry.refusal) continue;
    const current = storedByName(entry.kind.kind).get(entry.name);
    const action = missingUpsertRightOf(access, "sync", entry.kind, {
      name: entry.name,
      current,
      next: preparedUpsert(access, "sync", entry.kind, { current, next: entry.item.config }),
      namespaces
    });
    if (action !== undefined) {
      entry.refusal = { code: "FORBIDDEN", message: `Missing the right '${action}'`, action };
    }
  }
  if (planned.some((entry) => entry.refusal)) {
    throw refusedBatch(planned);
  }
}

export function defaultChangeRefusal(kind: WorkflowAssetKind): ItemRefusal {
  return {
    code: "FORBIDDEN",
    message: `Missing the right '${kind.actions.write}' on the instance, which changing its default needs`,
    action: kind.actions.write
  };
}

/**
 * The set as the items would leave it. `storedByName` is what each put is prepared against.
 * Each name is looked up once and each kind's list is built once, so the cost grows with the
 * items and the stored assets and not with their product.
 */
export function leftByItems(
  access: ActorAccess,
  storedByName: (kind: string) => Map<string, unknown>,
  entries: readonly ReadyItem[],
  set: AssetSet
): AssetSet {
  /** Per kind: what the batch leaves under each name it carries, nothing for a delete. */
  const carried = new Map<string, Map<string, { definition: unknown } | undefined>>();
  for (const entry of entries) {
    const ofKind = carried.get(entry.kind.kind) ?? new Map();
    carried.set(entry.kind.kind, ofKind);
    ofKind.set(
      entry.name,
      entry.item.type === "delete"
        ? undefined
        : {
            definition: preparedUpsert(access, "sync", entry.kind, {
              current: storedByName(entry.kind.kind).get(entry.name),
              next: entry.item.config
            })
          }
    );
  }
  const definitions = new Map(set.definitions);
  for (const [kind, ofKind] of carried) {
    definitions.set(kind, [
      ...definitionsOf(set, kind).filter((candidate) => {
        const name = readDefinitionName(candidate);
        return name === undefined || !ofKind.has(name);
      }),
      ...[...ofKind.values()].flatMap((put) => (put ? [put.definition] : []))
    ]);
  }
  return { ...set, definitions };
}

/** What each item is by its own input: a registered kind, a name, inside a named prefix, once. */
function planItems(options: AssetWorkflowOptions, input: AssetSyncInput): PlannedItem[] {
  const seen = new Set<string>();
  return input.items.map((item, index): PlannedItem => {
    requireAssetKindModuleOn(options.modules, item.kind);
    const kind = options.configAssets.kinds.get(item.kind);
    const name = item.type === "put" ? readDefinitionName(item.config) : item.name;
    const scope = scopeOf(input.workspaceId);
    const base = { index, item, scope, ...(name === undefined ? {} : { name }) };
    const refuse = (message: string): PlannedItem => ({
      ...base,
      ...(kind ? { kind } : {}),
      refusal: { code: "VALIDATION_FAILED", message }
    });
    if (!kind) {
      return refuse(`Asset kind '${item.kind}' is not registered`);
    }
    if (kind.representation === "files") {
      // Its revision is a set of files that is built and stored per write, which no batch is.
      return refuse(
        `A ${kind.kind} holds files: it is written with 'assets.put' and deleted with 'assets.delete', one at a time`
      );
    }
    if (name === undefined) {
      return refuse("Config asset must have a name");
    }
    if (!kind.owners.includes(scope.kind)) {
      return refuse(
        scope.kind === "workspace"
          ? `A ${kind.kind} cannot be owned by a workspace`
          : `A ${kind.kind} belongs to one workspace. Name it as 'workspaceId'`
      );
    }
    if (
      item.type === "put" &&
      Buffer.byteLength(JSON.stringify(item.config), "utf8") > ASSET_SYNC_ITEM_MAX_BYTES
    ) {
      return refuse(
        `Config ${kind.kind} '${name}' is larger than ${ASSET_SYNC_ITEM_MAX_BYTES} bytes, the most one item of a batch holds`
      );
    }
    if (input.namespace !== undefined && !name.startsWith(input.namespace)) {
      return refuse(`Config ${kind.kind} '${name}' is outside Namespace '${input.namespace}'`);
    }
    const key = assetKey(kind.kind, name);
    if (seen.has(key)) {
      return refuse(`Config ${kind.kind} '${name}' is named by more than one item`);
    }
    seen.add(key);
    return { ...base, kind };
  });
}

/**
 * The change of the instance default the batch brings with it, with the item that causes it.
 * A batch that leaves a kind with assets and no default, or with a default that is gone, is
 * left to the validation of the set.
 */
export function planDefaultChange(
  kinds: readonly WorkflowAssetKind[],
  stored: AssetSet,
  candidate: AssetSet,
  entries: readonly ReadyItem[]
): { entry: ReadyItem; agentName: string | undefined } | undefined {
  for (const kind of kinds) {
    if (!kind.holdsInstanceDefault) continue;
    const before = definitionsOf(stored, kind.kind).length;
    const after = definitionsOf(candidate, kind.kind).length;
    const ofKind = entries.filter((entry) => entry.kind.kind === kind.kind);
    if (before === 0 && stored.defaultAgentName === undefined && after > 0) {
      const first = ofKind.find((entry) => entry.item.type === "put");
      if (first) return { entry: first, agentName: first.name };
    }
    if (after === 0 && stored.defaultAgentName !== undefined) {
      const last = ofKind.find(
        (entry) => entry.item.type === "delete" && entry.name === stored.defaultAgentName
      );
      if (last) return { entry: last, agentName: undefined };
    }
  }
  return undefined;
}
