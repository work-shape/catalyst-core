import {
  ApiError,
  type AdministeredUser,
  type ConfigAssetSummary,
  type CreateNamespaceRequest,
  type CreatePermissionGrantRequest,
  type EffectivePermissions,
  type NamespaceWithUsage,
  type PermissionGrantRow
} from "@vivd-catalyst/api-client";
import {
  NAMESPACE_PREFIX_MAX_LENGTH,
  NAMESPACE_PREFIX_MIN_LENGTH,
  NAMESPACE_PREFIX_PATTERN,
  explainAccessEntries,
  type GrantableAction
} from "@vivd-catalyst/core";

/** The asset kinds a grant of this page names. */
export const ACCESS_ASSET_KINDS = ["agent", "skill"] as const;
export type AccessAssetKind = (typeof ACCESS_ASSET_KINDS)[number];

/** What a grant of this page allows or denies on an asset, in the order the page lists it. */
export const ACCESS_VERBS = ["read", "write", "delete"] as const;
export type AccessVerb = (typeof ACCESS_VERBS)[number];

function grantableAction(kind: AccessAssetKind, verb: AccessVerb): GrantableAction {
  return `${kind}.${verb}`;
}

/** The kind and verb of an action this page writes; nothing for any other action. */
export function splitGrantableAction(
  action: string
): { kind: AccessAssetKind; verb: AccessVerb } | undefined {
  for (const kind of ACCESS_ASSET_KINDS) {
    for (const verb of ACCESS_VERBS) {
      if (grantableAction(kind, verb) === action) {
        return { kind, verb };
      }
    }
  }
  return undefined;
}

/** Why a prefix cannot be registered, as far as the page can tell before it asks the server. */
export type NamespacePrefixProblem =
  { kind: "length" } | { kind: "pattern" } | { kind: "overlap"; prefix: string };

/**
 * Checks a prefix as it is typed: its length, its shape, and that neither it nor a registered
 * prefix starts with the other. The server checks the same and has the last word.
 */
export function namespacePrefixProblem(
  prefix: string,
  registered: readonly string[]
): NamespacePrefixProblem | undefined {
  if (prefix.length < NAMESPACE_PREFIX_MIN_LENGTH || prefix.length > NAMESPACE_PREFIX_MAX_LENGTH) {
    return { kind: "length" };
  }
  if (!NAMESPACE_PREFIX_PATTERN.test(prefix)) {
    return { kind: "pattern" };
  }
  const overlapping = registered.find(
    (candidate) => candidate.startsWith(prefix) || prefix.startsWith(candidate)
  );
  return overlapping === undefined ? undefined : { kind: "overlap", prefix: overlapping };
}

/** What the Namespace dialog holds while it is edited. */
export interface NamespaceForm {
  prefix: string;
  displayName: string;
  /** Off means the Namespace does not restrict tools; on with none chosen allows none. */
  limitTools: boolean;
  toolNames: string[];
  limitModels: boolean;
  modelBindingIds: string[];
}

export function namespaceFormFrom(namespace: NamespaceWithUsage | undefined): NamespaceForm {
  return {
    prefix: namespace?.prefix ?? "",
    displayName: namespace?.displayName ?? "",
    limitTools: Array.isArray(namespace?.allowedToolNames),
    toolNames: namespace?.allowedToolNames ?? [],
    limitModels: Array.isArray(namespace?.allowedModelBindingIds),
    modelBindingIds: namespace?.allowedModelBindingIds ?? []
  };
}

/** The request of the form: a switch that is off sends `null`, which lifts the restriction. */
export function namespaceRequest(form: NamespaceForm): CreateNamespaceRequest {
  return {
    prefix: form.prefix,
    displayName: form.displayName.trim(),
    allowedToolNames: form.limitTools ? form.toolNames : null,
    allowedModelBindingIds: form.limitModels ? form.modelBindingIds : null
  };
}

/**
 * How many assets a Namespace's lists would bind: the agents under the prefix when the page
 * could read them, else the agents and skills the Namespace's own row counts, else unknown.
 */
export type BoundAssets =
  { unit: "agents"; count: number } | { unit: "assets"; count: number } | { unit: "unknown" };

export function boundAssets(
  prefix: string,
  assets: readonly ConfigAssetSummary[] | undefined,
  namespace: NamespaceWithUsage | undefined
): BoundAssets {
  if (assets !== undefined) {
    return {
      unit: "agents",
      count:
        prefix === ""
          ? 0
          : assets.filter((asset) => asset.kind === "agent" && asset.name.startsWith(prefix)).length
    };
  }
  return namespace ? { unit: "assets", count: namespace.assetCount } : { unit: "unknown" };
}

/**
 * The lists that are switched on and empty while assets may already live under the prefix.
 * The server holds every save of an agent there against the lists, whoever saves: an empty
 * tool list refuses every agent that names a tool, an empty model list every agent that names
 * a model binding, and an agent without a binding needs the right to manage models.
 */
export function namespaceLockedLists(
  form: NamespaceForm,
  bound: BoundAssets
): ("tools" | "models")[] {
  if (bound.unit !== "unknown" && bound.count === 0) {
    return [];
  }
  return [
    ...(form.limitTools && form.toolNames.length === 0 ? (["tools"] as const) : []),
    ...(form.limitModels && form.modelBindingIds.length === 0 ? (["models"] as const) : [])
  ];
}

/** The Namespace a name lies in: Namespaces never overlap, so there is at most one. */
export function namespaceOfName(
  name: string,
  namespaces: readonly NamespaceWithUsage[]
): NamespaceWithUsage | undefined {
  return namespaces.find((namespace) => name.startsWith(namespace.prefix));
}

/**
 * The shape the server asks of a skill's name (`skillNameSchema` of the config schema, which
 * does not load in a browser). An agent's name only has to be one word.
 */
const SKILL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/u;
const AGENT_NAME_PATTERN = /^\S+$/u;

/** Whether the server could hold an asset of this name: a check gives no verdict otherwise. */
export function assetNameValid(kind: AccessAssetKind, name: string): boolean {
  return (kind === "skill" ? SKILL_NAME_PATTERN : AGENT_NAME_PATTERN).test(name);
}

/** What the grant dialog holds while it is edited. */
export interface GrantForm {
  holderId: string | undefined;
  kind: AccessAssetKind;
  verbs: AccessVerb[];
  scopeKind: "namespace" | "asset";
  namespace: string | undefined;
  assetId: string | undefined;
  effect: "allow" | "deny";
}

export const emptyGrantForm: GrantForm = {
  holderId: undefined,
  kind: "agent",
  verbs: [],
  scopeKind: "namespace",
  namespace: undefined,
  assetId: undefined,
  effect: "allow"
};

/** One request per chosen action, in the page's order; nothing while the form is incomplete. */
export function grantRequests(form: GrantForm): CreatePermissionGrantRequest[] | undefined {
  const scope =
    form.scopeKind === "namespace"
      ? form.namespace === undefined
        ? undefined
        : { scopeKind: "namespace" as const, namespace: form.namespace }
      : form.assetId === undefined
        ? undefined
        : { scopeKind: "asset" as const, scopeId: form.assetId };
  if (form.holderId === undefined || scope === undefined || form.verbs.length === 0) {
    return undefined;
  }
  const holderId = form.holderId;
  return ACCESS_VERBS.filter((verb) => form.verbs.includes(verb)).map((verb) => ({
    holderKind: "user",
    holderId,
    action: grantableAction(form.kind, verb),
    effect: form.effect,
    ...scope
  }));
}

/** A grant of several actions that stopped at one of them: the rows before it are written. */
export class GrantWriteError extends Error {
  constructor(
    /** The request the server refused. */
    readonly request: CreatePermissionGrantRequest,
    readonly written: number,
    readonly total: number,
    cause: unknown
  ) {
    super("A grant row could not be written", { cause });
    this.name = "GrantWriteError";
  }
}

/** What a grant of several actions came to: rows that existed already are left as they are. */
export interface GrantWriteResult {
  added: number;
  existing: number;
}

/** The rows one person holds on one place, in the order the actions are listed. */
export interface GrantGroup {
  key: string;
  holderId: string;
  /** The first row: it carries the scope every row of the group has. */
  scope: PermissionGrantRow;
  grants: PermissionGrantRow[];
}

/** One group per holder and place, the holders in the order of their names. */
export function groupGrants(
  grants: readonly PermissionGrantRow[],
  holderName: (holderId: string) => string
): GrantGroup[] {
  const groups = new Map<string, GrantGroup>();
  for (const grant of grants) {
    const key = [
      grant.holderKind,
      grant.holderId,
      grant.scopeKind,
      grant.namespace ?? grant.scopeId ?? ""
    ].join(":");
    const group = groups.get(key);
    if (group) {
      group.grants.push(grant);
    } else {
      groups.set(key, { key, holderId: grant.holderId, scope: grant, grants: [grant] });
    }
  }
  const place = ({ scope }: GrantGroup) =>
    `${scope.scopeKind} ${scope.namespace ?? scope.scopeAsset?.name ?? scope.scopeId ?? ""}`;
  const position = (grant: PermissionGrantRow) => {
    const parts = splitGrantableAction(grant.action);
    return parts
      ? ACCESS_ASSET_KINDS.indexOf(parts.kind) * ACCESS_VERBS.length +
          ACCESS_VERBS.indexOf(parts.verb)
      : ACCESS_ASSET_KINDS.length * ACCESS_VERBS.length;
  };
  return [...groups.values()]
    .map((group) => ({
      ...group,
      grants: [...group.grants].sort((left, right) => position(left) - position(right))
    }))
    .sort(
      (left, right) =>
        holderName(left.holderId).localeCompare(holderName(right.holderId)) ||
        place(left).localeCompare(place(right))
    );
}

/** The users a grant can be written for: nobody whose account is being deleted. */
export function grantableUsers(users: readonly AdministeredUser[]): AdministeredUser[] {
  return users.filter((user) => user.status !== "deleting");
}

/** One field of the `details` the server sends with a refusal, when it is text. */
function refusalDetail(error: unknown, field: string): string | undefined {
  if (!(error instanceof ApiError)) {
    return undefined;
  }
  const envelope = readField(error.payload, "error");
  const value = readField(readField(envelope, "details"), field);
  return typeof value === "string" ? value : undefined;
}

function readField(value: unknown, field: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return Object.entries(value).find(([key]) => key === field)?.[1];
}

/** The `details.reason` the server names in a refusal. */
function refusalReason(error: unknown): string | undefined {
  return refusalDetail(error, "reason");
}

/** How a grant or Namespace write failed, as far as the page has its own sentence for it. */
export type AccessWriteFailure =
  | "duplicateGrant"
  | "userBeingDeleted"
  | "unknownHolder"
  | "unknownNamespace"
  | "assetGone"
  | "namespaceOverlap"
  | "namespaceInUse"
  | "unknownListEntry"
  | "notFound"
  | "other";

export function accessWriteFailure(error: unknown): AccessWriteFailure {
  const reason = refusalReason(error);
  switch (reason) {
    case "duplicate_grant":
      return "duplicateGrant";
    case "unknown_holder":
      return "unknownHolder";
    case "unknown_namespace":
      return "unknownNamespace";
    case "invalid_scope":
      return "assetGone";
    case "namespace_overlap":
      return "namespaceOverlap";
    case "namespace_in_use":
      return "namespaceInUse";
    case "unknown_tool":
    case "unknown_model_binding":
      return "unknownListEntry";
    default:
      break;
  }
  if (!(error instanceof ApiError)) {
    return "other";
  }
  // A grant for a user whose deletion was requested is the one conflict without a reason.
  if (error.code === "CONFLICT") {
    return "userBeingDeleted";
  }
  return error.code === "NOT_FOUND" ? "notFound" : "other";
}

/** Why a list the page needs is not there: the caller lacks the right, or the load failed. */
export type LoadFailure = "forbidden" | "failed";

export function loadFailure(error: unknown): LoadFailure | undefined {
  if (error === null || error === undefined) {
    return undefined;
  }
  return error instanceof ApiError && error.status === 403 ? "forbidden" : "failed";
}

/** The registered prefix a refused prefix overlaps, as the server names it. */
export function overlappedPrefix(error: unknown): string | undefined {
  return refusalReason(error) === "namespace_overlap" ? refusalDetail(error, "prefix") : undefined;
}

type EffectiveEntry = EffectivePermissions["items"][number];

/** The asset a check asks about: a name that need not exist yet. */
export interface CheckedAsset {
  kind: AccessAssetKind;
  name: string;
}

/** What one action on the checked asset comes to, and what says so. */
export interface CheckedAction {
  verb: AccessVerb;
  allowed: boolean;
  reason: "role" | "legacy" | "grant" | "deny" | "no_grant" | "holder_inactive";
  /** The entry that decided. Absent when nothing covers the asset or the holder is inactive. */
  entry?: EffectiveEntry;
  /**
   * The verb of the deny that refuses a delete the holder is otherwise allowed: whoever is
   * denied reading or writing an asset does not delete it.
   */
  deniedThrough?: AccessVerb;
}

/**
 * The id asset rows name for this asset: the active asset's, or the one a row of this holder
 * still names after the asset was deleted. A name without either has no asset row.
 */
export function checkedAssetId(
  asset: CheckedAsset,
  assets: readonly ConfigAssetSummary[],
  holderGrants: readonly PermissionGrantRow[]
): string | undefined {
  const active = assets.find(
    (candidate) => candidate.kind === asset.kind && candidate.name === asset.name
  );
  if (active?.id !== undefined) {
    return active.id;
  }
  return holderGrants.find(
    (grant) => grant.scopeAsset?.kind === asset.kind && grant.scopeAsset.name === asset.name
  )?.scopeId;
}

/**
 * Decides read, write and delete on one asset from a holder's effective entries, with the
 * evaluator the server decides with. A delete follows the asset workflow's further rule.
 */
export function checkAsset(
  effective: EffectivePermissions,
  asset: CheckedAsset,
  assetId: string | undefined
): CheckedAction[] {
  if (!effective.holderActive) {
    return ACCESS_VERBS.map((verb) => ({ verb, allowed: false, reason: "holder_inactive" }));
  }
  const resource = { kind: asset.kind, name: asset.name, ...(assetId ? { assetId } : {}) };
  const decided = ACCESS_VERBS.map((verb): CheckedAction => {
    const { decision, entry } = explainAccessEntries(
      effective.items,
      grantableAction(asset.kind, verb),
      resource
    );
    if (decision.allowed) {
      return {
        verb,
        allowed: true,
        reason: decision.source === "legacy_ref" ? "legacy" : decision.source,
        ...(entry ? { entry } : {})
      };
    }
    return decision.reason === "denied"
      ? { verb, allowed: false, reason: "deny", ...(entry ? { entry } : {}) }
      : { verb, allowed: false, reason: "no_grant" };
  });
  return decided.map((action) => {
    if (action.verb !== "delete" || !action.allowed) {
      return action;
    }
    const deny = decided.find((other) => other.verb !== "delete" && other.reason === "deny");
    return deny
      ? {
          verb: "delete",
          allowed: false,
          reason: "deny",
          ...(deny.entry ? { entry: deny.entry } : {}),
          deniedThrough: deny.verb
        }
      : action;
  });
}

/** What the Check tab has to go on, and what keeps it from giving a result. */
export interface CheckInputs {
  holderId: string | undefined;
  kind: AccessAssetKind;
  name: string;
  effectiveLoaded: boolean;
  effectiveFailure: "hidden" | "failed" | undefined;
  grantsLoaded: boolean;
  grantsFailed: boolean;
  assetsLoaded: boolean;
  assetsFailure: LoadFailure | undefined;
}

export type CheckState =
  | "incomplete"
  | "holderHidden"
  | "effectiveFailed"
  | "grantsFailed"
  | "assetsForbidden"
  | "assetsFailed"
  | "loading"
  | "ready";

/**
 * Whether the Check tab may give a result. It needs a person, a name an asset can have, the
 * person's rights, the grant rows and the assets: a result without the rows or the assets
 * would miss a deny on one asset and call the action allowed.
 */
export function checkState(inputs: CheckInputs): CheckState {
  if (inputs.holderId === undefined || !assetNameValid(inputs.kind, inputs.name)) {
    return "incomplete";
  }
  if (inputs.effectiveFailure !== undefined) {
    return inputs.effectiveFailure === "hidden" ? "holderHidden" : "effectiveFailed";
  }
  if (inputs.grantsFailed) {
    return "grantsFailed";
  }
  if (inputs.assetsFailure !== undefined) {
    return inputs.assetsFailure === "forbidden" ? "assetsForbidden" : "assetsFailed";
  }
  return inputs.effectiveLoaded && inputs.grantsLoaded && inputs.assetsLoaded ? "ready" : "loading";
}
