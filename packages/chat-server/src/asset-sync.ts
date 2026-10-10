import {
  AppError,
  INSTANCE_ASSET_SCOPE,
  auditActorFromIdentity,
  findNamespaceOfAssetName,
  isAppError,
  type ActorAccess,
  type ConfigAssetMutation,
  type ConfigAssetRecord,
  type PolicyTarget
} from "@vivd-catalyst/core";
import { z } from "zod";
import { readDefinitionName, type WorkflowAssetKind } from "./asset-kinds/shared";
import {
  definitionsOf,
  findAssetSetIssues,
  findDefinition,
  withDefaultAgentName,
  withDefinition,
  withoutDefinition,
  type AssetSet,
  type AssetSetIssue
} from "./asset-set";
import {
  accessResource,
  decide,
  deleteDecision,
  errorIssues,
  type AssetCall
} from "./asset-access";
import {
  assetKey,
  authorizeInteractiveWrite,
  findChangedAgentRefusals,
  findIssuesOfChange,
  loadReferableAssets,
  loadStoredAssets,
  toJsonObject
} from "./asset-write-rules";
import { applyValidatedConfigAssetMutations } from "./config-asset-writer";
import type { ChatServerOptions } from "./types";

type AssetSyncItem =
  | { type: "put"; kind: string; config: Record<string, unknown>; expectedRevision?: number }
  | { type: "delete"; kind: string; name: string; expectedRevision: number };

export interface AssetSyncInput {
  /** The prefix of the one Namespace the batch belongs to. */
  namespace: string;
  items: AssetSyncItem[];
}

/** Why one item stops the batch. */
interface ItemRefusal {
  code: "FORBIDDEN" | "CONFLICT" | "NOT_FOUND" | "VALIDATION_FAILED";
  message: string;
  /** The right the caller lacks, for a refusal of rights. */
  action?: string;
  /** What the asset is at, for an item made against another revision. */
  currentRevision?: number | null;
}

interface PlannedItem {
  index: number;
  item: AssetSyncItem;
  name?: string;
  kind?: WorkflowAssetKind;
  /** The instance's own row of the name, a deleted one included. */
  asset?: ConfigAssetRecord;
  refusal?: ItemRefusal;
}

/** An item that passed the checks of its own input: its kind is registered and it has a name. */
type ReadyItem = PlannedItem & { name: string; kind: WorkflowAssetKind };

/** Which refusal names the batch's error, where its items were refused for different reasons. */
const REFUSAL_ORDER = ["FORBIDDEN", "NOT_FOUND", "CONFLICT", "VALIDATION_FAILED"] as const;

const conflictsSchema = z.object({
  conflicts: z.array(
    z.object({ kind: z.string(), name: z.string(), currentRevision: z.number().nullable() })
  )
});

/**
 * Applies puts and deletes in one Namespace, all of them or none. Every item is checked as
 * the single operation would check it: the right on its asset, the revision it was made
 * against, the definition and the instance's rules. The first kind of check that refuses any
 * item stops the batch, and the error names every item with what it was refused for. An item
 * outside the named prefix is refused before anything is read.
 */
export async function syncAssets(
  options: ChatServerOptions,
  call: AssetCall,
  input: AssetSyncInput
) {
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
  if (!namespaces.some((namespace) => namespace.prefix === input.namespace)) {
    throw new AppError("VALIDATION_FAILED", `Namespace '${input.namespace}' is not registered`);
  }
  await authorizeInteractiveWrite(options, call.actor, call, call.audit);
  for (const entry of ready()) {
    const current = entry.asset?.status === "active" ? entry.asset.revision : null;
    if (entry.item.type === "delete") {
      entry.refusal =
        refusalOf(() => entry.kind.assertInteractiveDeleteAllowed()) ??
        (current === null
          ? {
              code: "NOT_FOUND",
              message: `Config ${entry.kind.kind} '${entry.name}' was not found`
            }
          : undefined);
    }
    const expected = entry.item.expectedRevision ?? null;
    if (!entry.refusal && current !== expected) {
      entry.refusal = {
        code: "CONFLICT",
        message:
          current === null
            ? `Config ${entry.kind.kind} '${entry.name}' does not exist`
            : `Config ${entry.kind.kind} '${entry.name}' is at revision ${current}`,
        currentRevision: current
      };
    }
  }
  stopIfRefused();

  const stored = await loadStoredAssets(options);
  /** The set as the batch would leave it. */
  const withItems = (set: AssetSet) => leftByItems(stored.set, ready(), set);
  let candidate = withItems(stored.set);
  // The first asset of a kind with an instance default becomes it and the last one takes it
  // away. Either changes the default, which no Namespace or asset grant opens.
  const defaultChange = planDefaultChange(kinds.kinds, stored.set, candidate, ready());
  if (defaultChange) {
    candidate = withDefaultAgentName(candidate, defaultChange.agentName);
    if (!call.access.authorize(defaultChange.entry.kind.actions.write).allowed) {
      defaultChange.entry.refusal = defaultChangeRefusal(defaultChange.entry.kind);
    }
  }
  stopIfRefused();

  // What the batch refers to and its caller may not read is refused as a reference to nothing.
  const view = await loadReferableAssets(options, call.access, stored, {
    scope: INSTANCE_ASSET_SCOPE,
    name: input.namespace
  });
  if (!view.complete) {
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
  for (const { agentName, error } of changed.refusals) {
    const entry = ready().find(
      (candidateEntry) =>
        candidateEntry.item.type === "put" &&
        candidateEntry.kind.kind === "agent" &&
        candidateEntry.name === agentName
    );
    if (!entry) {
      throw error;
    }
    entry.refusal ??= toRefusal(error);
  }
  for (const entry of ready()) {
    if (entry.item.type !== "put" || entry.refusal) continue;
    entry.refusal = refusalOf(() =>
      entry.kind.assertInteractiveUpsertAllowed({
        access: call.access,
        name: entry.name,
        current: findDefinition(stored.set, entry.kind.kind, entry.name),
        next: findDefinition(found.accepted, entry.kind.kind, entry.name),
        namespaces: changed.namespaces
      })
    );
  }
  stopIfRefused();

  const mutations: ConfigAssetMutation[] = ready().map((entry) =>
    entry.item.type === "delete"
      ? { type: "delete", kind: entry.kind.kind, name: entry.name, scope: INSTANCE_ASSET_SCOPE }
      : {
          type: "upsert",
          kind: entry.kind.kind,
          name: entry.name,
          config: toJsonObject(findDefinition(found.accepted, entry.kind.kind, entry.name)),
          scope: INSTANCE_ASSET_SCOPE
        }
  );
  if (defaultChange) {
    mutations.push({ type: "setDefaultAgent", agentName: defaultChange.agentName });
  }
  const result = await applyValidatedConfigAssetMutations(options, {
    clientInstanceId: options.clientInstanceId,
    actor: auditActorFromIdentity(call.actor),
    baseRevisions: Object.fromEntries(
      ready().map((entry) => [
        assetKey(entry.kind.kind, entry.name),
        entry.item.expectedRevision ?? null
      ])
    ),
    ...(defaultChange ? { baseDefaultAgentName: stored.state.defaultAgentName ?? null } : {}),
    mutations
  }).catch((error: unknown) => {
    // Another write got between the check above and the store's lock.
    const stale =
      isAppError(error) && error.code === "CONFLICT"
        ? conflictsSchema.safeParse(error.details)
        : undefined;
    if (!stale?.success) throw error;
    for (const conflict of stale.data.conflicts) {
      const entry = ready().find(
        (candidateEntry) =>
          candidateEntry.kind.kind === conflict.kind && candidateEntry.name === conflict.name
      );
      if (entry) {
        entry.refusal = {
          code: "CONFLICT",
          message: `Config ${conflict.kind} '${conflict.name}' changed meanwhile`,
          currentRevision: conflict.currentRevision
        };
      }
    }
    throw planned.some((entry) => entry.refusal) ? refusedBatch(planned) : error;
  });

  // The recorder of the Operation Run: each row names the run that wrote it.
  const auditRecorder = call.audit;
  const items = [];
  for (const entry of ready()) {
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
  return { version: result.version, items, warnings: [] };
}

/**
 * What each item is by its own input, and the caller's right on every item that names an
 * asset: the write or the delete right at the asset's scope. Throws the refusal of the batch
 * where an item is refused by either, so a caller without the rights learns nothing else.
 */
async function authorizeItems(
  options: ChatServerOptions,
  access: ActorAccess,
  input: AssetSyncInput
): Promise<PlannedItem[]> {
  const planned = planItems(options, input);
  for (const entry of planned.filter(isReady)) {
    const row = await options.configAssets.store.getConfigAsset({
      clientInstanceId: options.clientInstanceId,
      kind: entry.kind.kind,
      name: entry.name
    });
    const own = row?.scope.kind === "instance" ? row : undefined;
    const resource = accessResource(entry.kind.kind, entry.name, INSTANCE_ASSET_SCOPE, own?.id);
    const { actions } = entry.kind;
    const right =
      entry.item.type === "delete"
        ? deleteDecision(access, { kind: entry.kind, resource })
        : decide(access, actions.write, resource);
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
  await requireFurtherRights(options, access, planned);
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
  planned: PlannedItem[]
): Promise<void> {
  const ready = planned.filter(isReady);
  const [stored, namespaces] = await Promise.all([
    loadStoredAssets(options),
    options.stores.access.listNamespaceRecords({ clientInstanceId: options.clientInstanceId })
  ]);
  const defaultChange = planDefaultChange(
    options.configAssets.kinds.kinds,
    stored.set,
    leftByItems(stored.set, ready, stored.set),
    ready
  );
  if (defaultChange && !access.authorize(defaultChange.entry.kind.actions.write).allowed) {
    defaultChange.entry.refusal = defaultChangeRefusal(defaultChange.entry.kind);
  }
  for (const entry of ready) {
    if (entry.item.type !== "put" || entry.refusal) continue;
    const current = findDefinition(stored.set, entry.kind.kind, entry.name);
    const action = entry.kind.missingUpsertRight({
      access,
      name: entry.name,
      current,
      next: entry.kind.prepareInteractiveUpsert({ current, next: entry.item.config }),
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

/** The set as the items would leave it. `stored` is what each put is prepared against. */
function leftByItems(stored: AssetSet, entries: readonly ReadyItem[], set: AssetSet): AssetSet {
  return entries.reduce(
    (left, entry) =>
      entry.item.type === "delete"
        ? withoutDefinition(left, entry.kind.kind, entry.name)
        : withDefinition(
            left,
            entry.kind.kind,
            entry.name,
            entry.kind.prepareInteractiveUpsert({
              current: findDefinition(stored, entry.kind.kind, entry.name),
              next: entry.item.config
            })
          ),
    set
  );
}

/**
 * The check the registry asks before the policy and the guardrails: every item is authorized,
 * so a batch its caller may not make never reaches either. The refusal is the batch's own
 * error, which names each item by its index.
 */
export async function authorizeAssetSync(
  options: ChatServerOptions,
  access: ActorAccess,
  input: AssetSyncInput
): Promise<void> {
  await authorizeItems(options, access, input);
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

function isReady(entry: PlannedItem): entry is ReadyItem {
  return entry.kind !== undefined && entry.name !== undefined && entry.refusal === undefined;
}

/** What each item is by its own input: a registered kind, a name, inside the prefix, once. */
function planItems(options: ChatServerOptions, input: AssetSyncInput): PlannedItem[] {
  const seen = new Set<string>();
  return input.items.map((item, index): PlannedItem => {
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
    if (name === undefined) {
      return refuse("Config asset must have a name");
    }
    if (!name.startsWith(input.namespace)) {
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

/** Hands each issue to the put it is about. Returns the ones that are about the set. */
function placeIssues(issues: readonly AssetSetIssue[], entries: readonly ReadyItem[]) {
  const unplaced: AssetSetIssue[] = [];
  for (const issue of issues) {
    const entry = entries.find(
      (candidate) =>
        candidate.item.type === "put" &&
        candidate.kind.kind === issue.assetKind &&
        candidate.name === issue.assetName
    );
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

function toRefusal(error: AppError): ItemRefusal {
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
function refusalOf(rule: () => void): ItemRefusal | undefined {
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
 * The error of a batch that was not applied. `details.items` names every item: `refused` with
 * the reason for one that stopped the batch, `not_applied` for one that would have been
 * written. `details.issues` holds what the set as a whole was refused for.
 */
function refusedBatch(planned: readonly PlannedItem[], issues: readonly AssetSetIssue[] = []) {
  const refused = planned.flatMap((entry) => (entry.refusal ? [entry.refusal] : []));
  const code = REFUSAL_ORDER.find((candidate) => refused.some((entry) => entry.code === candidate));
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
        ...(entry.refusal ? { error: { ...entry.refusal } } : {})
      })),
      ...(issues.length > 0 ? { issues: issues.map(({ message }) => ({ message })) } : {})
    }
  );
}
