import {
  ApiError,
  type AdministeredUser,
  type ConfigAssetSummary,
  type CreateNamespaceRequest,
  type CreatePermissionGrantRequest,
  type EffectivePermissions,
  type NamespaceWithUsage,
  type PermissionGrantRow,
  type PlatformContext
} from "@work-shape/catalyst-api-client";
import {
  ACCESS_SOURCES,
  CONFIG_ASSET_KINDS,
  explainAccessEntries,
  GRANT_EFFECTS,
  GRANTABLE_ACTION_SCOPES,
  GRANTABLE_ACTIONS,
  NAMESPACE_PREFIX_MAX_LENGTH,
  NAMESPACE_PREFIX_MIN_LENGTH,
  NAMESPACE_PREFIX_PATTERN,
  type GrantableAction,
  type PermissionGrant
} from "@work-shape/catalyst-core";

/** A kind of the instance's registry, with the actions its rights are checked as. */
export type CheckedKind = PlatformContext["kinds"][number];

/** What the Check tab decides on an asset, in the order the page lists it. */
const ACCESS_VERBS = ["read", "use", "write", "delete"] as const;
type AccessVerb = (typeof ACCESS_VERBS)[number];

/** The actions of a kind the check answers for: every one its registry entry names. */
function checkedVerbs(actions: CheckedKind["actions"]): { verb: AccessVerb; action: string }[] {
  return ACCESS_VERBS.flatMap((verb) => {
    const action = actions[verb];
    return action === undefined ? [] : [{ verb, action }];
  });
}

/**
 * The asset kinds a grant of this page names and what it allows or denies on them: the two
 * halves of every action core writes a grant row for. A kind or a verb core adds is offered
 * here without a list of this page's own; the page then owes it its words, which the label
 * tables of the Rights tab are typed to ask for.
 */
export type GrantKind = GrantableAction extends `${infer Kind}.${string}` ? Kind : never;
export type GrantVerb = GrantableAction extends `${string}.${infer Verb}` ? Verb : never;

/**
 * The order the page lists the verbs in: from seeing to changing to removing. It is the one
 * thing about a verb core does not say.
 */
const GRANT_VERB_RANK: Record<GrantVerb, number> = {
  read: 0,
  use: 1,
  write: 2,
  publish: 3,
  delete: 4,
  read_run_data: 5,
  records: 6
};

function isGrantKind(kind: string): kind is GrantKind {
  return GRANTABLE_ACTIONS.some((action) => action.startsWith(`${kind}.`));
}

function isGrantVerb(verb: string): verb is GrantVerb {
  return Object.hasOwn(GRANT_VERB_RANK, verb);
}

/** One right a grant row can be written for: its action, and the kind and verb it is made of. */
interface GrantRight {
  action: GrantableAction;
  kind: GrantKind;
  verb: GrantVerb;
}

/** Every right core writes a grant row for, the kinds in core's order and each kind's verbs in the page's. */
const GRANT_RIGHTS: readonly GrantRight[] = GRANTABLE_ACTIONS.flatMap((action) => {
  const dot = action.indexOf(".");
  const kind = action.slice(0, dot);
  const verb = action.slice(dot + 1);
  return isGrantKind(kind) && isGrantVerb(verb) ? [{ action, kind, verb }] : [];
});

/** The kinds a grant can name, in core's order. The dialog offers those the instance has. */
export const GRANT_KINDS: readonly GrantKind[] = [
  ...new Set(GRANT_RIGHTS.map((right) => right.kind))
];

/** Agents and skills: the two kinds every instance has, read with the agent configuration. */
const CONFIG_ASSET_GRANT_KINDS = CONFIG_ASSET_KINDS satisfies readonly GrantKind[];

export function isConfigAssetGrantKind(
  kind: GrantKind
): kind is (typeof CONFIG_ASSET_GRANT_KINDS)[number] {
  return CONFIG_ASSET_GRANT_KINDS.some((candidate) => candidate === kind);
}

/**
 * Where a new right applies, in the order the dialog offers the places: what a workspace owns
 * first, then one asset, then the whole instance. A Namespace is not among them: it is
 * retired, and its rows are only listed and revoked until it goes.
 */
export const GRANT_SCOPE_KINDS = [
  "workspace",
  "asset",
  "instance"
] as const satisfies readonly PermissionGrant["scopeKind"][];
export type GrantScopeKind = (typeof GRANT_SCOPE_KINDS)[number];

/** The rights of one kind, in the order the page lists them. */
function grantRights(kind: GrantKind): GrantRight[] {
  return GRANT_RIGHTS.filter((right) => right.kind === kind).sort(
    (left, right) => GRANT_VERB_RANK[left.verb] - GRANT_VERB_RANK[right.verb]
  );
}

/** The action of a kind and a verb, where a grant row can be written for it. */
export function grantAction(kind: GrantKind, verb: GrantVerb): GrantableAction | undefined {
  return GRANT_RIGHTS.find((right) => right.kind === kind && right.verb === verb)?.action;
}

/** The verbs a grant of the kind can name: what the server writes a row for. */
export function grantVerbs(kind: GrantKind): GrantVerb[] {
  return grantRights(kind).map((right) => right.verb);
}

/**
 * The places shared by the selected verbs (every verb of the kind when omitted), so a
 * request never names a place one of its ticked actions would be refused at. The first is the
 * one the dialog chooses for the kind.
 */
export function grantScopeKinds(
  kind: GrantKind,
  verbs: readonly GrantVerb[] = grantVerbs(kind)
): GrantScopeKind[] {
  const scopes = grantRights(kind)
    .filter((right) => verbs.includes(right.verb))
    .map((right): readonly string[] => GRANTABLE_ACTION_SCOPES[right.action]);
  return scopes.length === 0
    ? []
    : GRANT_SCOPE_KINDS.filter((scopeKind) => scopes.every((of) => of.includes(scopeKind)));
}

/**
 * Whether the page needs the names of the Shared Workspaces: a new grant can be written on what
 * one owns, for agents, skills or any of the further kinds an instance has, or a row already
 * given is on a workspace. Such a row stays listed and revocable after its kind lost the place,
 * and it names the workspace by its name.
 */
export function grantsNameWorkspaces(
  furtherKinds: readonly GrantKind[],
  grants: readonly Pick<PermissionGrantRow, "scopeKind">[]
): boolean {
  return (
    grants.some((grant) => grant.scopeKind === "workspace") ||
    [...CONFIG_ASSET_GRANT_KINDS, ...furtherKinds].some((kind) =>
      grantScopeKinds(kind).includes("workspace")
    )
  );
}

/** The kind and verb of an action this page writes; nothing for any other action. */
export function splitGrantableAction(
  action: string
): { kind: GrantKind; verb: GrantVerb } | undefined {
  const right = GRANT_RIGHTS.find((candidate) => candidate.action === action);
  return right && { kind: right.kind, verb: right.verb };
}

/** Where a right stands among all of them: the kinds in order, each kind's verbs in order. */
function grantRightPosition(action: string): number {
  const parts = splitGrantableAction(action);
  return parts
    ? GRANT_KINDS.indexOf(parts.kind) * GRANT_RIGHTS.length + GRANT_VERB_RANK[parts.verb]
    : GRANT_KINDS.length * GRANT_RIGHTS.length;
}

/**
 * The kinds beyond agents and skills a grant can name on an instance: each one core writes a
 * grant row for that the instance registers, which it does while the kind's module is on.
 * Agents and skills are on every instance and come with the agent configuration.
 */
export function furtherGrantKinds(registered: readonly string[] | undefined): GrantKind[] {
  return GRANT_KINDS.filter(
    (kind) => !isConfigAssetGrantKind(kind) && (registered?.includes(kind) ?? false)
  );
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
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const AGENT_NAME_PATTERN = /^\S+$/u;

/**
 * Whether the server could hold an asset of this name: a check gives no verdict otherwise.
 * A kind without a rule of its own here is held to one word.
 */
export function assetNameValid(kind: string, name: string): boolean {
  return (kind === "skill" ? SKILL_NAME_PATTERN : AGENT_NAME_PATTERN).test(name);
}

/** What the grant dialog holds while it is edited. */
export interface GrantForm {
  holderId: string | undefined;
  kind: GrantKind;
  verbs: GrantVerb[];
  /** Absent for a kind no right can be written for at any place. */
  scopeKind: GrantScopeKind | undefined;
  assetId: string | undefined;
  /** The Shared Workspace of a grant on what a workspace owns. */
  workspaceId: string | undefined;
  effect: (typeof GRANT_EFFECTS)[number];
}

/** A new right on agents, at the first place an agent right can be written. */
export const emptyGrantForm: GrantForm = {
  holderId: undefined,
  kind: "agent",
  verbs: [],
  scopeKind: grantScopeKinds("agent")[0],
  assetId: undefined,
  workspaceId: undefined,
  effect: "allow"
};

/**
 * The form after another kind was chosen. An asset belongs to its kind, so none is kept; a
 * verb the new kind has no grant for is dropped, and the place is the kind's first, so a kind
 * a workspace can own starts in the workspace.
 */
export function withGrantKind(form: GrantForm, kind: GrantKind): GrantForm {
  const verbs = grantVerbs(kind);
  return {
    ...form,
    kind,
    verbs: form.verbs.filter((verb) => verbs.includes(verb)),
    scopeKind: grantScopeKinds(kind)[0],
    assetId: undefined
  };
}

/** The place of the form's rows, once the form names everything the place asks for. */
function grantScope(
  form: GrantForm
): Pick<CreatePermissionGrantRequest, "scopeKind" | "scopeId"> | undefined {
  switch (form.scopeKind) {
    case "workspace":
      return form.workspaceId === undefined
        ? undefined
        : { scopeKind: "workspace", scopeId: form.workspaceId };
    case "asset":
      return form.assetId === undefined ? undefined : { scopeKind: "asset", scopeId: form.assetId };
    case "instance":
      return { scopeKind: "instance" };
    case undefined:
      return undefined;
  }
}

/** One request per chosen action, in the page's order; nothing while the form is incomplete. */
export function grantRequests(form: GrantForm): CreatePermissionGrantRequest[] | undefined {
  if (
    form.scopeKind === undefined ||
    !grantScopeKinds(form.kind, form.verbs).includes(form.scopeKind)
  ) {
    return undefined;
  }
  const scope = grantScope(form);
  const holderId = form.holderId;
  const actions = grantRights(form.kind)
    .filter((right) => form.verbs.includes(right.verb))
    .map((right) => right.action);
  if (holderId === undefined || scope === undefined || actions.length === 0) {
    return undefined;
  }
  return actions.map((action) => ({
    holderKind: "user",
    holderId,
    action,
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
  const position = (grant: PermissionGrantRow) => grantRightPosition(grant.action);
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
export function refusalReason(error: unknown): string | undefined {
  return refusalDetail(error, "reason");
}

/** How a grant or Namespace write failed, as far as the page has its own sentence for it. */
export type AccessWriteFailure =
  | "duplicateGrant"
  | "userBeingDeleted"
  | "unknownHolder"
  | "assetGone"
  | "rightNotOffered"
  | "moduleOff"
  | "missingManageRight"
  | "holderIsSuperadmin"
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
    case "invalid_scope":
      return "assetGone";
    case "unknown_action":
    case "action_not_grantable":
      return "rightNotOffered";
    case "module_off":
      return "moduleOff";
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
  if (error.status === 403) {
    // The caller lacks the right to manage users, or holds it and the row is a superadmin's:
    // that refusal names the operation, because no right a caller can be given opens it.
    const action = refusalDetail(error, "action");
    if (action === "users.manage") {
      return "missingManageRight";
    }
    return action?.startsWith("permissions.") ? "holderIsSuperadmin" : "other";
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
  kind: string;
  name: string;
}

/** An asset as the check needs it: enough to find the id a grant row on one asset names. */
export interface CheckableAsset {
  id?: string;
  kind: string;
  name: string;
}

/**
 * The source of an allowed action as the check names it. A membership allows nothing on the
 * kinds checked here: it is the right to open what a workspace published, so it reads as the
 * grant it stands in for.
 */
function checkedReason(source: (typeof ACCESS_SOURCES)[number]): "role" | "legacy" | "grant" {
  if (source === "legacy_ref") return "legacy";
  return source === "membership" ? "grant" : source;
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
  assets: readonly CheckableAsset[],
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
 * Decides every action of the asset's kind on one asset, from a holder's effective entries,
 * with the evaluator the server decides with. `actions` are the ones the instance's registry
 * names for the kind; without them a kind has reading, writing and deleting under its own
 * name. A delete follows the asset workflow's further rule.
 */
export function checkAsset(
  effective: EffectivePermissions,
  asset: CheckedAsset,
  assetId: string | undefined,
  actions: CheckedKind["actions"] = {
    read: `${asset.kind}.read`,
    write: `${asset.kind}.write`,
    delete: `${asset.kind}.delete`
  }
): CheckedAction[] {
  const verbs = checkedVerbs(actions);
  if (!effective.holderActive) {
    return verbs.map(({ verb }) => ({ verb, allowed: false, reason: "holder_inactive" }));
  }
  const resource = { kind: asset.kind, name: asset.name, ...(assetId ? { assetId } : {}) };
  const decided = verbs.map(({ verb, action }): CheckedAction => {
    const { decision, entry } = explainAccessEntries(effective.items, action, resource);
    if (decision.allowed) {
      return {
        verb,
        allowed: true,
        reason: checkedReason(decision.source),
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
    const deny = decided.find(
      (other) => (other.verb === "read" || other.verb === "write") && other.reason === "deny"
    );
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
  /** The chosen kind. Absent until the instance has said which kinds it has. */
  kind: string | undefined;
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
  if (
    inputs.holderId === undefined ||
    inputs.kind === undefined ||
    !assetNameValid(inputs.kind, inputs.name)
  ) {
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
