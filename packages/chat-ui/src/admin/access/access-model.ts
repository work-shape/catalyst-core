import {
  ApiError,
  type AccessOrigin,
  type AdministeredUser,
  type AssetRightsCheck,
  type CreatePermissionGrantRequest,
  type PermissionGrantRow,
  type PlatformContext
} from "@work-shape/catalyst-api-client";
import {
  ACCESS_SOURCES,
  CONFIG_ASSET_KINDS,
  GRANT_EFFECTS,
  GRANT_SCOPE_KINDS as SCOPE_KINDS,
  GRANTABLE_ACTION_SCOPES,
  GRANTABLE_ACTIONS,
  type GrantableAction,
  type PermissionGrant
} from "@work-shape/catalyst-core";

/** A kind of the instance's registry, with the actions its rights are checked as. */
export type CheckedKind = PlatformContext["kinds"][number];

/**
 * The asset kinds a grant of this page names and what it allows or denies on them: the two
 * halves of every action core writes a grant row for. A kind or a verb core adds is offered
 * here without a list of this page's own; the page then owes it its words, which the label
 * tables of the Rights tab are typed to ask for.
 */
export type GrantKind = KindOf<GrantableAction>;
export type GrantVerb = VerbOf<GrantableAction>;

/**
 * A bundle of a workspace, Builder or Publisher, is an action without a kind: the page offers it
 * as a verb of the kind `workspace`, which only one workspace is the place of.
 */
const BUNDLE_KIND = "workspace";
type KindOf<Action> = Action extends `${infer Kind}.${string}` ? Kind : typeof BUNDLE_KIND;

/** The actions of one kind: `workflow.read` and the others of `workflow`, Builder and Publisher of `workspace`. */
export type GrantKindAction<Kind extends GrantKind> = {
  [Action in GrantableAction]: KindOf<Action> extends Kind ? Action : never;
}[GrantableAction];
type VerbOf<Action> = Action extends `${string}.${infer Verb}` ? Verb : Action;

/**
 * The order the page lists the verbs in: from seeing to changing to removing. It is the one
 * thing about a verb core does not say.
 */
const GRANT_VERB_RANK: Record<GrantVerb, number> = {
  read: 0,
  use: 1,
  insert: 2,
  execute: 3,
  write: 4,
  publish: 5,
  approve: 6,
  delete: 7,
  read_run_data: 8,
  records: 9,
  builder: 10,
  publisher: 11,
  review: 12,
  edit_built_in: 13,
  view_users: 14,
  retry: 15
};

function isGrantKind(kind: string): kind is GrantKind {
  return kind === BUNDLE_KIND || GRANTABLE_ACTIONS.some((action) => action.startsWith(`${kind}.`));
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
  const kind = dot < 0 ? BUNDLE_KIND : action.slice(0, dot);
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
 * first, then one asset, then the whole instance.
 */
const GRANT_SCOPE_RANK: Record<PermissionGrant["scopeKind"], number> = {
  workspace: 0,
  asset: 1,
  instance: 2
};
export const GRANT_SCOPE_KINDS = [...SCOPE_KINDS].sort(
  (left, right) => GRANT_SCOPE_RANK[left] - GRANT_SCOPE_RANK[right]
);
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
function assetNameValid(kind: string, name: string): boolean {
  return (kind === "skill" ? SKILL_NAME_PATTERN : AGENT_NAME_PATTERN).test(name);
}

/**
 * The verbs a right is given as a level, from using to removing: each level includes the ones
 * below it. Using comes first: a person who queries a Knowledge Base need not see how it is
 * made. The other verbs of a kind, such as adding rows to a Data Store, are given one by one.
 */
const LEVEL_VERBS = [
  "use",
  "read",
  "write",
  "publish",
  "delete"
] as const satisfies readonly GrantVerb[];

/**
 * The kinds whose use acts with the asset's own rights: a started Workflow runs as its account
 * and a Connection calls the outside system with its credentials. Viewing one comes first, so a
 * person can be given View without Use (access-and-permissions.md, Levels per kind).
 */
const VIEW_BEFORE_USE_KINDS: readonly GrantKind[] = ["workflow", "connection"];

function isLevelVerb(verb: GrantVerb): boolean {
  return LEVEL_VERBS.some((level) => level === verb);
}

/** The levels a right on the kind can be given at, the lowest first. */
export function grantLevels(kind: GrantKind): GrantVerb[] {
  const verbs = grantVerbs(kind);
  const order: readonly GrantVerb[] = VIEW_BEFORE_USE_KINDS.includes(kind)
    ? ["read", "use", "write", "publish", "delete"]
    : LEVEL_VERBS;
  return order.filter((level) => verbs.includes(level));
}

/** The verbs of the kind that are no level: each is given on its own. */
export function grantExtras(kind: GrantKind): GrantVerb[] {
  return grantVerbs(kind).filter((verb) => !isLevelVerb(verb));
}

/**
 * The verbs a level stands for. An allow gives the level and every one below it; a deny refuses
 * the level and every one above it, because whoever may not view an asset may not edit it.
 */
export function levelVerbs(
  kind: GrantKind,
  level: GrantVerb | undefined,
  effect: GrantForm["effect"]
): GrantVerb[] {
  const levels = grantLevels(kind);
  const index = level === undefined ? -1 : levels.indexOf(level);
  if (index < 0) {
    return [];
  }
  return effect === "allow" ? levels.slice(0, index + 1) : levels.slice(index);
}

/** What the grant dialog holds while it is edited. */
export interface GrantForm {
  holderId: string | undefined;
  kind: GrantKind;
  /** The chosen level of the kind; absent until one is chosen. */
  level: GrantVerb | undefined;
  /** The chosen verbs that are no level. */
  extras: GrantVerb[];
  /** Absent for a kind no right can be written for at any place. */
  scopeKind: GrantScopeKind | undefined;
  assetId: string | undefined;
  /** The Shared Workspace of a grant on what a workspace owns. */
  workspaceId: string | undefined;
  effect: (typeof GRANT_EFFECTS)[number];
}

/** Every verb the form gives or refuses: its level's and the further ones ticked. */
export function grantFormVerbs(form: GrantForm): GrantVerb[] {
  return [...levelVerbs(form.kind, form.level, form.effect), ...form.extras];
}

/** A new right on agents, at the first place an agent right can be written. */
export const emptyGrantForm: GrantForm = {
  holderId: undefined,
  kind: "agent",
  level: undefined,
  extras: [],
  scopeKind: grantScopeKinds("agent")[0],
  assetId: undefined,
  workspaceId: undefined,
  effect: "allow"
};

/**
 * The form after another kind was chosen. An asset belongs to its kind, so none is kept; a
 * level or a verb the new kind has no grant for is dropped, and the place is the kind's first,
 * so a kind a workspace can own starts in the workspace.
 */
export function withGrantKind(form: GrantForm, kind: GrantKind): GrantForm {
  const verbs = grantVerbs(kind);
  return {
    ...form,
    kind,
    level:
      form.level !== undefined && grantLevels(kind).includes(form.level) ? form.level : undefined,
    extras: form.extras.filter((verb) => verbs.includes(verb)),
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
  const verbs = grantFormVerbs(form);
  if (form.scopeKind === undefined || !grantScopeKinds(form.kind, verbs).includes(form.scopeKind)) {
    return undefined;
  }
  const scope = grantScope(form);
  const holderId = form.holderId;
  const actions = grantRights(form.kind)
    .filter((right) => verbs.includes(right.verb))
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
    const key = [grant.holderKind, grant.holderId, grant.scopeKind, grant.scopeId ?? ""].join(":");
    const group = groups.get(key);
    if (group) {
      group.grants.push(grant);
    } else {
      groups.set(key, { key, holderId: grant.holderId, scope: grant, grants: [grant] });
    }
  }
  const place = ({ scope }: GrantGroup) =>
    `${scope.scopeKind} ${scope.scopeAsset?.name ?? scope.scopeId ?? ""}`;
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

/** How many rows the Rights tab shows: one per holder and place. Nothing while loading. */
export function grantRowCount(
  grants: readonly PermissionGrantRow[] | undefined
): number | undefined {
  return grants && groupGrants(grants, () => "").length;
}

/** The users a grant can be written for: nobody whose account is being deleted. */
export function grantableUsers(users: readonly AdministeredUser[]): AdministeredUser[] {
  return users.filter((user) => user.status !== "deleting");
}

/** One field of the `details` the server sends with a refusal, when it is text. */
export function refusalDetail(error: unknown, field: string): string | undefined {
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

/** How a grant or build limit write failed, as far as the page has its own sentence for it. */
export type AccessWriteFailure =
  | "duplicateGrant"
  | "userBeingDeleted"
  | "unknownHolder"
  | "assetGone"
  | "rightNotOffered"
  | "moduleOff"
  | "missingManageRight"
  | "holderIsSuperadmin"
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

type CheckAnswer = AssetRightsCheck["actions"][number];
/** What the Check tab answers for on an asset. */
type AccessVerb = CheckAnswer["verb"];

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

/** The source of an allowed action as the check names it. */
function checkedReason(
  source: (typeof ACCESS_SOURCES)[number]
): "role" | "legacy" | "grant" | "membership" {
  return source === "legacy_ref" ? "legacy" : source;
}

/** What one action on the checked asset comes to, and what says so. */
export interface CheckedAction {
  verb: AccessVerb;
  allowed: boolean;
  reason:
    | "role"
    | "legacy"
    | "grant"
    | "membership"
    | "availability"
    | "deny"
    | "no_grant"
    | "holder_inactive";
  /** The entry that decided. Absent when nothing covers the asset or the holder is inactive. */
  entry?: AccessOrigin;
  /** The App's audience, where it and not an entry decided. */
  availability?: CheckAnswer["availability"];
  /** The workspaces the right holds in only; absent where it holds everywhere. */
  onlyInWorkspaces?: CheckAnswer["onlyInWorkspaces"];
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
 * The server's answers on one asset, as the Check tab names them. The server decided each one
 * with the evaluator it decides every call with; this only says which words fit.
 */
export function checkedActions(check: AssetRightsCheck): CheckedAction[] {
  return check.actions.flatMap((answer: CheckAnswer): CheckedAction[] => {
    const entry = answer.decidedBy === undefined ? {} : { entry: answer.decidedBy };
    const conditions = {
      ...(answer.availability === undefined ? {} : { availability: answer.availability }),
      ...(answer.onlyInWorkspaces === undefined
        ? {}
        : { onlyInWorkspaces: answer.onlyInWorkspaces })
    };
    if (answer.allowed) {
      return [
        {
          verb: answer.verb,
          allowed: true,
          reason:
            answer.availability !== undefined
              ? "availability"
              : answer.decidedBy
                ? checkedReason(answer.decidedBy.source)
                : "grant",
          ...entry,
          ...conditions
        }
      ];
    }
    const reason =
      answer.reason === "denied"
        ? "deny"
        : answer.reason === "holder_inactive"
          ? "holder_inactive"
          : answer.availability !== undefined
            ? "availability"
            : "no_grant";
    return [
      {
        verb: answer.verb,
        allowed: false,
        reason,
        ...(reason === "deny" ? entry : {}),
        ...conditions,
        ...(answer.deniedThrough === undefined ? {} : { deniedThrough: answer.deniedThrough })
      }
    ];
  });
}

/** What the Check tab has to go on, and what keeps it from giving a result. */
export interface CheckInputs {
  holderId: string | undefined;
  /** The chosen kind. Absent until the instance has said which kinds it has. */
  kind: string | undefined;
  name: string;
  checkLoaded: boolean;
  checkFailure: "hidden" | "failed" | undefined;
  grantsLoaded: boolean;
  grantsFailed: boolean;
  assetsLoaded: boolean;
  assetsFailure: LoadFailure | undefined;
}

export type CheckState =
  | "incomplete"
  | "holderHidden"
  | "checkFailed"
  | "grantsFailed"
  | "assetsForbidden"
  | "assetsFailed"
  | "loading"
  | "ready";

/**
 * Whether the Check tab may give a result. It needs a person, a name an asset can have, the
 * grant rows and the assets, which name the asset the server is asked about, and the server's
 * answer: a question without the rows or the assets would miss a deny on one asset and call
 * the action allowed.
 */
export function checkState(inputs: CheckInputs): CheckState {
  if (
    inputs.holderId === undefined ||
    inputs.kind === undefined ||
    !assetNameValid(inputs.kind, inputs.name)
  ) {
    return "incomplete";
  }
  if (inputs.checkFailure !== undefined) {
    return inputs.checkFailure === "hidden" ? "holderHidden" : "checkFailed";
  }
  if (inputs.grantsFailed) {
    return "grantsFailed";
  }
  if (inputs.assetsFailure !== undefined) {
    return inputs.assetsFailure === "forbidden" ? "assetsForbidden" : "assetsFailed";
  }
  return inputs.checkLoaded && inputs.grantsLoaded && inputs.assetsLoaded ? "ready" : "loading";
}
