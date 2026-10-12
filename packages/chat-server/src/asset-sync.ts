import {
  AppError,
  INSTANCE_ASSET_SCOPE,
  auditActorFromIdentity,
  findNamespaceOfAssetName,
  isAppError,
  type ActorAccess,
  type AuthenticatedIdentity,
  type ConfigAssetMutation,
  type PolicyTarget
} from "@vivd-catalyst/core";
import { z } from "zod";
import { readDefinitionName, type WorkflowAssetKind } from "./asset-kinds/shared";
import {
  definitionsByName,
  definitionsOf,
  findAssetSetIssues,
  withDefaultAgentName,
  type AssetSet,
  type AssetSetIssue
} from "./asset-set";
import { accessResource, errorIssues, type AssetCall } from "./asset-access";
import {
  assertDeleteWithinLimits,
  assertUpsertWithinLimits,
  assetKey,
  authorizeInteractiveWrite,
  findChangedAgentRefusals,
  findIssuesOfChange,
  isHiddenEverywhere,
  isReleaseSync,
  isReleasedKind,
  itemWriteDecision,
  loadReferableAssets,
  loadStoredAssets,
  impliesDefaultChange,
  accessOfSyncCredential,
  maxSyncItems,
  missingUpsertRightOf,
  preparedUpsert,
  releaseInitialAvailability,
  requireAssetKindModuleOn,
  requireAssetManagementOn,
  requireInteractiveEditingOn,
  requireNamespaceOrRelease,
  requireReleaseSync,
  toJsonObject
} from "./asset-write-rules";
import { currentRevisionOf } from "./asset-revision";
import {
  isReady,
  refusalOf,
  refuseStale,
  refusedBatch,
  staleBatch,
  toRefusal,
  type AssetSyncItem,
  type ItemRefusal,
  type PlannedItem,
  type ReadyItem,
  type StaleItem
} from "./asset-sync-refusals";
import { applyValidatedConfigAssetMutations } from "./config-asset-writer";
import type { ChatServerOptions } from "./types";

export interface AssetSyncInput {
  /**
   * The prefix of the one Namespace the batch belongs to. A release names none and may name
   * any asset of the instance.
   */
  namespace?: string;
  items: AssetSyncItem[];
  /** The default agent a release names, `null` for none. Left out, the batch names none. */
  defaultAgentName?: string | null;
  /** The default agent the batch was made against, where its caller says so. */
  expectedDefaultAgentName?: string | null;
}

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
  options: ChatServerOptions,
  call: AssetCall,
  input: AssetSyncInput
) {
  const bound = withSyncCredential(call);
  const checked = await checkBatch(options, bound, input, "apply");
  return applyBatch(options, bound, checked);
}

/**
 * Says whether the batch would be applied, and writes nothing. It asks everything the sync
 * asks, in the same order, and refuses with the same error. Only the store's own check under
 * its lock is left out, which decides nothing but a write that arrives in the same moment.
 */
export async function checkAssetSync(
  options: ChatServerOptions,
  call: AssetCall,
  input: AssetSyncInput
): Promise<{ valid: true }> {
  await checkBatch(options, withSyncCredential(call), input, "check");
  return { valid: true };
}

/** The call as it is decided: whether it is a release depends on the key it came with. */
function withSyncCredential(call: AssetCall): AssetCall {
  return { ...call, access: accessOfSyncCredential(call.actor, call.access) };
}

/** A batch every check accepted, with what the store is asked to write for it. */
interface CheckedBatch {
  planned: PlannedItem[];
  ready: ReadyItem[];
  releaseSync: boolean;
  storedDefault: string | null;
  defaultChange: { agentName: string | undefined } | undefined;
  mutations: ConfigAssetMutation[];
}

async function checkBatch(
  options: ChatServerOptions,
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
  const releaseSync = isReleaseSync(call.access, "sync");
  if (purpose === "apply") {
    await authorizeInteractiveWrite(options, call.actor, call, call.audit, releaseSync);
  } else {
    requireInteractiveEditingOn(options, releaseSync);
  }
  const stale: ReadyItem[] = [];
  for (const entry of ready()) {
    const active = entry.asset?.status === "active";
    if (entry.asset?.status === "active") {
      const stored = entry.asset.config;
      entry.refusal = refusalOf(() => entry.kind.assertStoredWritable?.({ current: stored }));
      if (entry.refusal) continue;
    }
    if (entry.item.type === "delete") {
      if (releaseSync && !active) {
        // A release says what the instance holds. An asset that is gone already is as it says.
        entry.absent = true;
        continue;
      }
      entry.refusal =
        refusalOf(() => assertDeleteWithinLimits(call.access, "sync", entry.kind)) ??
        (active
          ? undefined
          : {
              code: "NOT_FOUND",
              message: `Config ${entry.kind.kind} '${entry.name}' was not found`
            });
    }
    // A deleted asset keeps its revision: a put creates it again only by naming that one.
    if (!entry.refusal && currentRevisionOf(entry.asset) !== entry.item.expectedRevision) {
      stale.push(entry);
    }
  }
  await refuseStale(options, call.access, stale);
  stopIfRefused();

  const stored = await loadStoredAssets(options);
  const storedByName = definitionsByName(stored.set);
  /** The set as the batch would leave it. */
  const withItems = (set: AssetSet) => leftByItems(call.access, storedByName, ready(), set);
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

  const found = findAssetSetIssues(kinds.kinds, candidate);
  const unplaced = placeIssues(found.issues, ready());
  stopIfRefused(unplaced);
  stopIfRefused(writeIssues(() => found.validateWrite(stored.set)));

  const changed = await findChangedAgentRefusals(options, call.access, stored.set, found.accepted);
  const puts = putsByAsset(ready());
  for (const { agentName, error } of changed.refusals) {
    const entry = puts.get(assetKey("agent", agentName));
    // A second refusal of an agent is the answer of the call: the first is on its item.
    if (!entry || entry.refusal) throw error;
    entry.refusal = toRefusal(error);
  }
  const acceptedByName = definitionsByName(found.accepted);
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
      ? { type: "delete", kind: entry.kind.kind, name: entry.name, scope: INSTANCE_ASSET_SCOPE }
      : {
          type: "upsert",
          kind: entry.kind.kind,
          name: entry.name,
          config: toJsonObject(acceptedByName(entry.kind.kind).get(entry.name)),
          scope: INSTANCE_ASSET_SCOPE,
          // A kind with a published revision moves its draft with a write and nothing else.
          ...(entry.kind.lifecycle === "draft_published" ? { draft: true as const } : {})
        }
  );
  if (defaultChange) {
    mutations.push({ type: "setDefaultAgent", agentName: defaultChange.agentName });
  }
  return {
    planned,
    ready: ready(),
    releaseSync,
    storedDefault,
    defaultChange,
    mutations
  };
}

async function applyBatch(options: ChatServerOptions, call: AssetCall, checked: CheckedBatch) {
  const { planned, ready, releaseSync, storedDefault, defaultChange, mutations } = checked;
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
    ...(defaultChange ? { baseDefaultAgentName: storedDefault } : {}),
    ...releaseInitialAvailability(call.access, "sync"),
    mutations
  }).catch(async (error: unknown) => {
    // Another write got between the check above and the store's lock. Nothing was written.
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
  for (const entry of ready) {
    if (entry.absent) {
      items.push({
        type: "delete" as const,
        kind: entry.kind.kind,
        name: entry.name,
        status: "absent" as const
      });
      continue;
    }
    // The store appends exactly one revision to the one the batch was checked against. A
    // name that is created again continues the revisions of its deleted row.
    const revision = (entry.asset?.revision ?? 0) + 1;
    await auditRecorder.record({
      type: entry.item.type === "delete" ? "config_asset.deleted" : "config_asset.updated",
      status: "success",
      actor: auditActorFromIdentity(call.actor),
      correlationId: call.correlationId,
      metadata: { kind: entry.kind.kind, name: entry.name, revision, version: result.version }
    });
    items.push({
      type: entry.item.type,
      kind: entry.kind.kind,
      name: entry.name,
      status: "applied" as const,
      revision
    });
  }
  return {
    version: result.version,
    items,
    ...(releaseSync
      ? await hiddenAgentNamesOf(
          options,
          ready.filter((entry) => !entry.absent)
        )
      : {}),
    warnings: []
  };
}

/** The agents a release wrote that no workspace shows afterwards, as its answer names them. */
async function hiddenAgentNamesOf(
  options: ChatServerOptions,
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
 * What each item is by its own input, and the caller's right on every item that names an
 * asset: the write or the delete right at the asset's scope, or the release right in their
 * place. Throws the refusal of the batch where an item is refused by either, so a caller
 * without the rights learns nothing else.
 */
async function authorizeItems(
  options: ChatServerOptions,
  access: ActorAccess,
  input: AssetSyncInput
): Promise<PlannedItem[]> {
  // The module's switch is asked here because the release holder passes it: the operation
  // itself belongs to no module, so the route does not refuse it before the caller is known.
  requireAssetManagementOn(options, access, "sync");
  requireNamespaceOrRelease(access, input.namespace);
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
  for (const entry of planned.filter(isReady)) {
    if (releaseSync && !isReleasedKind(entry.kind)) {
      entry.refusal = {
        code: "VALIDATION_FAILED",
        message: `Asset kind '${entry.kind.kind}' is not part of a release`
      };
      continue;
    }
    const row = await options.configAssets.store.getConfigAsset({
      clientInstanceId: options.clientInstanceId,
      kind: entry.kind.kind,
      name: entry.name
    });
    const own = row?.scope.kind === "instance" ? row : undefined;
    const resource = accessResource(entry.kind.kind, entry.name, INSTANCE_ASSET_SCOPE, own?.id);
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
    } else if (row && !own) {
      // A Namespace is a prefix among the instance's own assets.
      entry.refusal = {
        code: "VALIDATION_FAILED",
        message: `Config ${entry.kind.kind} '${entry.name}' belongs to another scope`
      };
    } else if (own) {
      entry.asset = own;
    }
  }
  if (planned.some((entry) => entry.refusal)) {
    throw refusedBatch(planned);
  }
  // Asked once the caller holds the right on every item, and before the policy and the
  // guardrails: a batch that names no revision for an asset is never taken as an overwrite.
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
  await requireFurtherRights(options, access, input, planned);
  return planned;
}

/**
 * The rights a batch needs beside those on its items: the write right on the instance where
 * it changes the instance default, and what a kind asks for a put beside its write right. They
 * are decided on what the caller sent, so they are known before the policy is asked. The
 * checks of the validated definitions stay where they are and decide again.
 */
async function requireFurtherRights(
  options: ChatServerOptions,
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

function defaultChangeRefusal(kind: WorkflowAssetKind): ItemRefusal {
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
function leftByItems(
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

/**
 * The check the registry asks before the policy and the guardrails: every item is authorized,
 * so a batch its caller may not make never reaches either. The refusal is the batch's own
 * error, which names each item by its index.
 */
export async function authorizeAssetSync(
  options: ChatServerOptions,
  actor: AuthenticatedIdentity,
  access: ActorAccess,
  input: AssetSyncInput
): Promise<void> {
  await authorizeItems(options, accessOfSyncCredential(actor, access), input);
}

/**
 * What the policy is asked about: each kind the batch names with the Namespace of the names it
 * carries, so a setting narrowed to a kind or to a Namespace applies to the batch.
 */
export async function assetSyncPolicyTargets(
  options: ChatServerOptions,
  input: AssetSyncInput
): Promise<PolicyTarget[]> {
  const namespaces = await options.stores.access.listNamespaceRecords({
    clientInstanceId: options.clientInstanceId
  });
  const targets = new Map<string, PolicyTarget>();
  for (const item of input.items) {
    const name = item.type === "put" ? readDefinitionName(item.config) : item.name;
    const namespace =
      name === undefined ? undefined : findNamespaceOfAssetName(namespaces, name)?.prefix;
    targets.set(JSON.stringify([item.kind, namespace]), {
      assetKind: item.kind,
      ...(namespace === undefined ? {} : { namespace })
    });
  }
  return [...targets.values()];
}

/** What each item is by its own input: a registered kind, a name, inside a named prefix, once. */
function planItems(options: ChatServerOptions, input: AssetSyncInput): PlannedItem[] {
  const seen = new Set<string>();
  return input.items.map((item, index): PlannedItem => {
    requireAssetKindModuleOn(options.modules, item.kind);
    const kind = options.configAssets.kinds.get(item.kind);
    const name = item.type === "put" ? readDefinitionName(item.config) : item.name;
    const base = { index, item, ...(name === undefined ? {} : { name }) };
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
function planDefaultChange(
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
