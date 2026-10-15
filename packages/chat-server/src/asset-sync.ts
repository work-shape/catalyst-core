import {
  AppError,
  asCollaborationWorkspaceId,
  auditActorFromIdentity,
  findNamespaceOfAssetName,
  isAppError,
  type ActorAccess,
  type AuthenticatedIdentity,
  type ConfigAssetMutation,
  type PolicyTarget
} from "@vivd-catalyst/core";
import type { AgentToolWarning } from "./agent-tool-validation";
import { afterWrite, clearLiveOnceSwitches } from "./asset-after-write";
import { z } from "zod";
import { configValuesEqual, readDefinitionName } from "./asset-kinds/shared";
import {
  definitionsByName,
  findAssetSetIssues,
  withDefaultAgentName,
  type AssetSet,
  type AssetSetIssue
} from "./asset-set";
import { errorIssues, type AssetCall } from "./asset-access";
import {
  assertDeleteWithinLimits,
  assertUpsertWithinLimits,
  assetKey,
  authorizeInteractiveWrite,
  findChangedAgentRefusals,
  findIssuesOfChange,
  isHiddenEverywhere,
  isReleaseSync,
  loadReferableAssets,
  loadStoredAssets,
  impliesDefaultChange,
  accessOfSyncCredential,
  syncInitialAvailability,
  requireInteractiveEditingOn,
  requireOwnerWorkspace,
  toJsonObject
} from "./asset-write-rules";
import { currentRevisionOf } from "./asset-revision";
import { readsOther, recordCommitted } from "./asset-target";
import {
  isReady,
  readsItem,
  refusalOf,
  refuseStale,
  refusedBatch,
  staleBatch,
  toRefusal,
  type AssetSyncInput,
  type PlannedItem,
  type ReadyItem,
  type StaleItem
} from "./asset-sync-refusals";
import {
  REPLACED_REFUSAL,
  authorizeItems,
  defaultChangeRefusal,
  leftByItems,
  planDefaultChange,
  replacedRefusal,
  replacedSchema
} from "./asset-sync-items";
import { applyValidatedConfigAssetMutations } from "./config-asset-writer";
import { assertDefaultOwnedByInstance } from "./asset-owner-references";

export type { AssetSyncInput } from "./asset-sync-refusals";
import type { AssetWorkflowOptions } from "./types";

/** What the store says of each asset a batch was stale for, under its lock. */
const conflictsSchema = z.object({
  conflicts: z.array(
    z.object({
      kind: z.string(),
      name: z.string(),
      currentRevision: z.number().nullable(),
      deleted: z.boolean().optional(),
      actorLabel: z.string().nullable().optional(),
      timestamp: z.string().nullable().optional()
    })
  )
});

/**
 * Applies puts and deletes, all of them or none: in one Namespace where the batch names one,
 * anywhere among the instance's own assets where it names none. Every item is checked as the
 * single operation would check it: the right on its asset, the revision it was made against,
 * the definition and the instance's rules. An asset the batch does not name is neither read
 * for its revision nor written, so a change of it never refuses the batch.
 *
 * A kind with a draft and a published revision has its draft moved by a put and nothing else:
 * the published revision stays, and so does the version of the set the runtime reads. A kind
 * whose revisions hold files, such as the App, is refused as an item: its files are built per
 * write, which no batch is. The first kind of check that refuses any item stops
 * the batch, and the error names every item with what it was refused for. An item outside a
 * named prefix is refused before anything is read. What a holder of the release right is
 * exempt from in this call is listed at `isReleaseSync`.
 */
export async function syncAssets(
  options: AssetWorkflowOptions,
  call: AssetCall,
  input: AssetSyncInput
) {
  const bound = withSyncCredential(call, input);
  const checked = await checkBatch(options, bound, input, "apply");
  return applyBatch(options, bound, checked);
}

/**
 * Says whether the batch would be applied, and writes nothing. It asks everything the sync
 * asks, in the same order, and refuses with the same error. Only the store's own check under
 * its lock is left out, which decides nothing but a write that arrives in the same moment.
 */
export async function checkAssetSync(
  options: AssetWorkflowOptions,
  call: AssetCall,
  input: AssetSyncInput
) {
  const { warnings } = await checkBatch(options, withSyncCredential(call, input), input, "check");
  return { valid: true as const, ...(warnings.length > 0 ? { warnings } : {}) };
}

/**
 * The call as it is decided: whether it is a release depends on the key it came with and on
 * the owner the batch names.
 */
function withSyncCredential(call: AssetCall, input: AssetSyncInput): AssetCall {
  return { ...call, access: accessOfSyncCredential(call.actor, call.access, input) };
}

/** A batch every check accepted, with what the store is asked to write for it. */
interface CheckedBatch {
  warnings: AgentToolWarning[];
  planned: PlannedItem[];
  ready: ReadyItem[];
  storedDefault: string | null;
  defaultChange: { agentName: string | undefined } | undefined;
  mutations: ConfigAssetMutation[];
}

async function checkBatch(
  options: AssetWorkflowOptions,
  call: AssetCall,
  input: AssetSyncInput,
  purpose: "apply" | "check"
): Promise<CheckedBatch> {
  const kinds = options.configAssets.kinds;
  // The registry asked the same before the policy. It is asked again on the rows as they are
  // now: a call that waited for an approval runs later than it was authorized.
  const planned = await authorizeItems(options, call.access, input);
  const ready = () => planned.filter(isReady);
  const stopIfRefused = (issues?: AssetSetIssue[]) => {
    if (planned.some((entry) => entry.refusal) || issues?.length) {
      throw refusedBatch(planned, issues);
    }
  };

  const namespaces = await options.stores.access.listNamespaceRecords({
    clientInstanceId: options.clientInstanceId
  });
  if (
    input.namespace !== undefined &&
    !namespaces.some((namespace) => namespace.prefix === input.namespace)
  ) {
    throw new AppError("VALIDATION_FAILED", `Namespace '${input.namespace}' is not registered`);
  }
  await requireOwnerWorkspace(options, input.workspaceId);
  const releaseSync = isReleaseSync(call.access, "sync");
  if (purpose === "apply") {
    await authorizeInteractiveWrite(options, call.actor, call, call.audit, releaseSync);
  } else {
    requireInteractiveEditingOn(options, releaseSync);
  }
  // What the instance's rules refuse, before anything is told of a revision: a batch refused
  // here carries no word of what an asset is at.
  const storedWritable = (entry: ReadyItem) =>
    entry.asset?.status === "active"
      ? refusalOf(() => entry.kind.assertStoredWritable?.({ current: entry.asset?.config }))
      : undefined;
  for (const entry of ready()) {
    const active = entry.asset?.status === "active";
    // Told at once to a caller who reads the asset. For everyone else it waits until the
    // revision the item names is the asset's: it depends on what is stored.
    entry.refusal = readsItem(call.access, entry) ? storedWritable(entry) : undefined;
    if (entry.refusal || entry.item.type !== "delete") continue;
    if (releaseSync && !active) {
      // A release says what the instance holds. An asset that is gone already is as it says.
      entry.absent = true;
      continue;
    }
    entry.refusal = refusalOf(() => assertDeleteWithinLimits(call.access, "sync", entry.kind));
  }
  stopIfRefused();

  const stale: StaleItem[] = [];
  for (const entry of ready()) {
    if (entry.absent) continue;
    const replaced = replacedRefusal(entry);
    if (replaced) {
      entry.refusal = replaced;
      continue;
    }
    if (entry.other) {
      // The name is a workspace asset's. Who reads that asset is told so. For everyone else
      // the item is at another revision than it names, and nothing more is said.
      if (readsOther(call.access, entry)) {
        entry.refusal = {
          code: "VALIDATION_FAILED",
          message: `Config ${entry.kind.kind} '${entry.name}' belongs to another scope`
        };
      } else {
        stale.push({ entry, untold: true });
      }
      continue;
    }
    const active = entry.asset?.status === "active";
    if (entry.item.type === "delete" && !active && readsItem(call.access, entry)) {
      entry.refusal = {
        code: "NOT_FOUND",
        message: `Config ${entry.kind.kind} '${entry.name}' was not found`
      };
      continue;
    }
    // A deleted asset keeps its revision: a put creates it again only by naming that one. A
    // delete of an asset that is not there is stale for a caller who does not read it: that
    // caller is not told whether there is an asset.
    if (
      (entry.item.type === "delete" && !active) ||
      currentRevisionOf(entry.asset) !== entry.item.expectedRevision
    ) {
      stale.push({ entry, asset: entry.asset });
    }
  }
  await refuseStale(options, call.access, stale);
  stopIfRefused();
  for (const entry of ready()) {
    entry.refusal = storedWritable(entry);
  }
  stopIfRefused();

  const stored = await loadStoredAssets(options);
  const storedByName = definitionsByName(stored.set);
  /** The set as the batch would leave it. */
  const withItems = (set: AssetSet) =>
    leftByItems(call.access, storedByName, ready(), set, call.actor.id);
  let candidate = withItems(stored.set);
  const storedDefault = stored.state.defaultAgentName ?? null;
  if (
    input.expectedDefaultAgentName !== undefined &&
    input.expectedDefaultAgentName !== storedDefault
  ) {
    throw new AppError(
      "CONFLICT",
      storedDefault === null
        ? "The instance has no default agent"
        : `The default agent is '${storedDefault}'`,
      { reason: "default_agent_changed", currentDefaultAgentName: storedDefault }
    );
  }
  // The first asset of a kind with an instance default becomes it and the last one takes it
  // away. Either changes the default, which no Namespace or asset grant opens. A release is
  // taken at its word instead: the default it names, or the stored one.
  const impliedDefault =
    input.defaultAgentName === undefined && impliesDefaultChange(call.access)
      ? planDefaultChange(kinds.kinds, stored.set, candidate, ready())
      : undefined;
  if (impliedDefault && !call.access.authorize(impliedDefault.entry.kind.actions.write).allowed) {
    impliedDefault.entry.refusal = defaultChangeRefusal(impliedDefault.entry.kind);
  }
  // A batch made against a default the caller read writes the default it leaves, so that the
  // store checks the expectation once more under its lock.
  const keptDefault =
    input.expectedDefaultAgentName === undefined
      ? undefined
      : { agentName: stored.state.defaultAgentName };
  const defaultChange =
    input.defaultAgentName === undefined
      ? (impliedDefault ?? keptDefault)
      : { agentName: input.defaultAgentName ?? undefined };
  if (defaultChange) {
    candidate = withDefaultAgentName(candidate, defaultChange.agentName);
  }
  stopIfRefused();

  // What the batch refers to and its caller may not read is refused as a reference to nothing.
  // A release is checked against the whole set: it says what the instance holds, also where
  // its key reads less than it writes.
  const view = releaseSync ? undefined : loadReferableAssets(options, call.access, stored);
  if (view && !view.complete) {
    const written = new Set(ready().map((entry) => assetKey(entry.kind.kind, entry.name)));
    const left = (set: AssetSet) =>
      defaultChange
        ? withDefaultAgentName(withItems(set), defaultChange.agentName)
        : withItems(set);
    const tellable = findIssuesOfChange(kinds.kinds, stored.set, view, left, written);
    stopIfRefused(placeIssues(tellable, ready()));
  }

  const found = findAssetSetIssues(kinds.kinds, candidate, stored.set);
  const unplaced = placeIssues(found.issues, ready());
  stopIfRefused(unplaced);
  stopIfRefused(writeIssues(() => found.validateWrite(stored.set)));

  const acceptedByName = definitionsByName(found.accepted);
  const changed = await findChangedAgentRefusals(options, call.access, stored.set, found.accepted, {
    names: ready()
      .filter(
        (entry) =>
          entry.kind.kind === "agent" &&
          entry.item.type === "put" &&
          (purpose === "check" ||
            !configValuesEqual(
              storedByName("agent").get(entry.name),
              acceptedByName("agent").get(entry.name)
            ))
      )
      .map((entry) => entry.name),
    scope:
      input.workspaceId === undefined
        ? {}
        : { workspaceId: asCollaborationWorkspaceId(input.workspaceId) }
  });
  const puts = putsByAsset(ready());
  for (const { agentName, error } of changed.refusals) {
    const entry = puts.get(assetKey("agent", agentName));
    // A second refusal of an agent is the answer of the call: the first is on its item.
    if (!entry || entry.refusal) throw error;
    entry.refusal = toRefusal(error);
  }
  for (const entry of ready()) {
    if (entry.item.type !== "put" || entry.refusal) continue;
    entry.refusal = refusalOf(() =>
      assertUpsertWithinLimits(call.access, "sync", entry.kind, {
        name: entry.name,
        current: storedByName(entry.kind.kind).get(entry.name),
        next: acceptedByName(entry.kind.kind).get(entry.name),
        namespaces: changed.namespaces
      })
    );
  }
  stopIfRefused();

  // A delete of an asset that is not there writes nothing. It is handed to the store all the
  // same, which checks under its lock that the asset is still not there.
  const mutations: ConfigAssetMutation[] = ready().map((entry) =>
    entry.item.type === "delete"
      ? { type: "delete", kind: entry.kind.kind, name: entry.name, scope: entry.scope }
      : {
          type: "upsert",
          kind: entry.kind.kind,
          name: entry.name,
          config: toJsonObject(acceptedByName(entry.kind.kind).get(entry.name)),
          scope: entry.scope,
          // A kind with a published revision moves its draft with a write and nothing else.
          ...(entry.kind.lifecycle === "draft_published" ? { draft: true as const } : {})
        }
  );
  if (defaultChange) {
    mutations.push({ type: "setDefaultAgent", agentName: defaultChange.agentName });
  }
  // Asked here as well as by the writer, so that a check of the batch refuses it too.
  assertDefaultOwnedByInstance(kinds.kinds, mutations, stored.assets);
  return {
    warnings: changed.warnings,
    planned,
    ready: ready(),
    storedDefault,
    defaultChange,
    mutations
  };
}

async function applyBatch(options: AssetWorkflowOptions, call: AssetCall, checked: CheckedBatch) {
  const { planned, ready, storedDefault, defaultChange, mutations } = checked;
  const byKey = new Map(ready.map((entry) => [assetKey(entry.kind.kind, entry.name), entry]));
  const result = await applyValidatedConfigAssetMutations(options, {
    clientInstanceId: options.clientInstanceId,
    actor: auditActorFromIdentity(call.actor),
    baseRevisions: Object.fromEntries(
      // Every item named a revision: the batch was refused before the policy otherwise.
      [...byKey].map(([key, entry]) => [
        key,
        entry.absent ? null : (entry.item.expectedRevision ?? null)
      ])
    ),
    baseAssetIds: Object.fromEntries(
      [...byKey].flatMap(([key, entry]) =>
        entry.item.expectedAssetId === undefined ? [] : [[key, entry.item.expectedAssetId]]
      )
    ),
    ...(defaultChange ? { baseDefaultAgentName: storedDefault } : {}),
    ...syncInitialAvailability(
      call.access,
      storedDefault === null && defaultChange?.agentName !== undefined
    ),
    mutations
  }).catch(async (error: unknown) => {
    // Another write got between the check above and the store's lock. Nothing was written.
    const replaced =
      isAppError(error) && error.code === "CONFLICT"
        ? replacedSchema.safeParse(error.details)
        : undefined;
    if (replaced?.success) {
      for (const { kind, name } of replaced.data.assets) {
        const entry = byKey.get(assetKey(kind, name));
        if (entry) entry.refusal = REPLACED_REFUSAL;
      }
      throw refusedBatch(planned);
    }
    const found =
      isAppError(error) && error.code === "REVISION_CONFLICT"
        ? conflictsSchema.safeParse(error.details)
        : undefined;
    if (!found?.success) throw error;
    const stale: StaleItem[] = [];
    for (const conflict of found.data.conflicts) {
      const entry = byKey.get(assetKey(conflict.kind, conflict.name));
      if (!entry) continue;
      stale.push({
        entry,
        ...(conflict.currentRevision === null
          ? {}
          : {
              asset: {
                revision: conflict.currentRevision,
                status: conflict.deleted ? ("deleted" as const) : ("active" as const)
              }
            }),
        change: {
          ...(conflict.actorLabel ? { changedBy: conflict.actorLabel } : {}),
          ...(conflict.timestamp ? { changedAt: conflict.timestamp } : {})
        }
      });
    }
    if (stale.length === 0) throw error;
    throw await staleBatch(options, call.access, planned, stale);
  });

  // The recorder of the Operation Run: each row names the run that wrote it.
  const auditRecorder = call.audit;
  const items = [];
  const records: (() => Promise<void>)[] = [];
  for (const entry of ready) {
    // The revision the store gave the asset in this transaction. A delete of an asset that
    // was not there wrote nothing and has none.
    const key = assetKey(entry.kind.kind, entry.name);
    const revision = result.revisions[key];
    const id = result.assetIds[key];
    if (entry.absent || revision === undefined || id === undefined) {
      items.push({
        type: "delete" as const,
        kind: entry.kind.kind,
        name: entry.name,
        status: "absent" as const
      });
      continue;
    }
    records.push(async () => {
      await auditRecorder.record({
        type: entry.item.type === "delete" ? "config_asset.deleted" : "config_asset.updated",
        status: "success",
        actor: auditActorFromIdentity(call.actor),
        correlationId: call.correlationId,
        metadata: { kind: entry.kind.kind, name: entry.name, revision, version: result.version }
      });
    });
    items.push({
      type: entry.item.type,
      kind: entry.kind.kind,
      name: entry.name,
      status: "applied" as const,
      id,
      revision
    });
  }
  // The batch is committed: every asset is written. A row of the trail that cannot be written
  // is logged, the others are still written, and the caller is told what was written.
  await recordCommitted(options, call, records);
  for (const entry of ready) {
    const id = result.assetIds[assetKey(entry.kind.kind, entry.name)];
    if (!entry.absent && entry.item.type === "put") {
      await clearLiveOnceSwitches(options, call, entry.kind, entry.name, id);
      const mutation = mutations.find(
        (item) =>
          item.type === "upsert" && item.kind === entry.kind.kind && item.name === entry.name
      );
      if (mutation?.type === "upsert") {
        await afterWrite(options, call, entry, {
          previous: entry.asset?.config,
          config: mutation.config
        });
      }
    }
  }
  return {
    version: result.version,
    items,
    ...(await hiddenAgentNamesOf(
      options,
      ready.filter((entry) => !entry.absent)
    )),
    warnings: checked.warnings
  };
}

/** The agents a batch wrote that no workspace shows afterwards, as its answer names them. */
async function hiddenAgentNamesOf(
  options: AssetWorkflowOptions,
  written: readonly ReadyItem[]
): Promise<{ hiddenAgentNames?: string[] }> {
  const names = written
    .filter((entry) => entry.item.type === "put" && entry.kind.hasWorkspaceAvailability)
    .map((entry) => entry.name);
  if (names.length === 0) return {};
  const availability = await options.configAssets.store.listAgentAvailability({
    clientInstanceId: options.clientInstanceId
  });
  const hidden = names.filter((name) => isHiddenEverywhere(availability.get(name)));
  return hidden.length > 0 ? { hiddenAgentNames: hidden } : {};
}

/**
 * The check the registry asks before the policy and the guardrails: every item is authorized,
 * so a batch its caller may not make never reaches either. The refusal is the batch's own
 * error, which names each item by its index.
 */
export async function authorizeAssetSync(
  options: AssetWorkflowOptions,
  actor: AuthenticatedIdentity,
  access: ActorAccess,
  input: AssetSyncInput
): Promise<void> {
  await authorizeItems(options, accessOfSyncCredential(actor, access, input), input);
}

/**
 * What the policy is asked about: each kind the batch names with the Namespace of the names it
 * carries and the workspace the batch names, so a setting narrowed to a kind, a Namespace or
 * a workspace applies to the batch.
 */
export async function assetSyncPolicyTargets(
  options: AssetWorkflowOptions,
  input: AssetSyncInput
): Promise<PolicyTarget[]> {
  const namespaces = await options.stores.access.listNamespaceRecords({
    clientInstanceId: options.clientInstanceId
  });
  const targets = new Map<string, PolicyTarget>();
  for (const item of input.items) {
    const name = item.type === "put" ? readDefinitionName(item.config) : item.name;
    // A Namespace is a prefix among the instance's own assets only.
    const namespace =
      name === undefined || input.workspaceId !== undefined
        ? undefined
        : findNamespaceOfAssetName(namespaces, name)?.prefix;
    targets.set(JSON.stringify([item.kind, namespace]), {
      assetKind: item.kind,
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      ...(namespace === undefined ? {} : { namespace })
    });
  }
  return [...targets.values()];
}

/**
 * The puts of a batch by the asset each writes, the first one where a name comes twice. Built
 * once per pass, so that naming the put of each refusal does not grow with their product.
 */
function putsByAsset(entries: readonly ReadyItem[]): Map<string, ReadyItem> {
  const puts = new Map<string, ReadyItem>();
  for (const entry of entries) {
    if (entry.item.type !== "put") continue;
    const key = assetKey(entry.kind.kind, entry.name);
    if (!puts.has(key)) puts.set(key, entry);
  }
  return puts;
}

/** Hands each issue to the put it is about. Returns the ones that are about the set. */
function placeIssues(issues: readonly AssetSetIssue[], entries: readonly ReadyItem[]) {
  const unplaced: AssetSetIssue[] = [];
  const puts = putsByAsset(entries);
  for (const issue of issues) {
    const entry =
      issue.assetKind === undefined || issue.assetName === undefined
        ? undefined
        : puts.get(assetKey(issue.assetKind, issue.assetName));
    if (!entry) {
      unplaced.push(issue);
    } else if (entry.refusal) {
      entry.refusal.message = `${entry.refusal.message}; ${issueText(issue)}`;
    } else {
      entry.refusal = { code: "VALIDATION_FAILED", message: issueText(issue) };
    }
  }
  return unplaced;
}

function issueText(issue: AssetSetIssue): string {
  return issue.path?.length
    ? `${issue.path.map(String).join(".")}: ${issue.message}`
    : issue.message;
}

function writeIssues(check: () => AssetSetIssue[]): AssetSetIssue[] {
  try {
    return check();
  } catch (error) {
    if (isAppError(error) && error.code === "VALIDATION_FAILED") {
      return errorIssues(error);
    }
    throw error;
  }
}
