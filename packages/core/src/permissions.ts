import type { AppAvailability } from "./app-audience";
import {
  WORKSPACE_USE_ASSET_KINDS,
  ACCESS_SOURCES,
  ACTIONS,
  SERVICE_PRINCIPAL_PERMISSIONS as CONTRACT_SERVICE_PRINCIPAL_PERMISSIONS,
  GRANT_EFFECTS,
  GRANT_HOLDER_KINDS,
  GRANT_SCOPE_KINDS,
  NAMESPACE_PREFIX_MAX_LENGTH,
  NAMESPACE_PREFIX_MIN_LENGTH,
  NAMESPACE_PREFIX_PATTERN,
  PRINCIPAL_HOLDER_KINDS,
  type PlatformAction
} from "@work-shape/catalyst-asset-schemas";
import { resolveDataScope, type DataScope, type ScopeAssignmentInput } from "./data-scope";
import { AppError } from "./errors";
import { GRANTABLE_ACTION_SCOPES } from "./grantable-action-scopes";
import { isAuthenticatedServicePrincipal, type AuthenticatedIdentity } from "./identity";
import type { ClientInstanceId, UserId } from "./ids";
import { operationDenialError } from "./operation-denial";
import type { StorePage } from "./paging";
import { personalApiKeyCovers, personalApiKeyNamesAction } from "./personal-api-keys";
import type { RightsLock } from "./rights-lock";
import type { ISODateString } from "./time";

export const PERMISSIONS = [
  "agent_skills.approve",
  "config_assets.read",
  "config_assets.write",
  "config_assets.release",
  "usage.view",
  "users.manage",
  "api_access.manage",
  "agent_models.manage",
  "audit.view"
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const SERVICE_PRINCIPAL_PERMISSIONS =
  CONTRACT_SERVICE_PRINCIPAL_PERMISSIONS satisfies readonly Permission[];

export { ACTIONS, type PlatformAction };

export const LEGACY_PERMISSION_ACTIONS = {
  // Who approves a skill change approves an operation call that waits for an approval.
  "agent_skills.approve": ["skill.approve", "operations.approve"],
  "config_assets.read": ["agent.read", "skill.read"],
  "config_assets.write": ["agent.write", "agent.delete", "skill.write", "skill.delete"],
  "config_assets.release": ["assets.release"],
  "usage.view": ["usage.view"],
  "users.manage": ["users.manage"],
  "api_access.manage": ["api_access.manage"],
  "agent_models.manage": ["agent_models.manage"],
  "audit.view": ["audit.view"]
} as const satisfies Record<Permission, readonly PlatformAction[]>;

export function legacyPermissionFor(action: PlatformAction): Permission {
  for (const permission of PERMISSIONS) {
    if (LEGACY_PERMISSION_ACTIONS[permission].some((candidate) => candidate === action)) {
      return permission;
    }
  }
  throw new AppError("VALIDATION_FAILED", `No legacy permission for action '${action}'`);
}

/** What the legacy list helpers read of a holder's grant rows. */
export type LegacyRowView = Pick<PermissionGrant, "action" | "effect" | "scopeKind">;

/**
 * The keys a holder's instance-wide rows stand for: every action of the key has a row and one
 * of them allows. These are the keys of the holder's legacy list, a key whose single action a
 * row of other origin denies included, which the list held all the same. A service principal's
 * credential can carry these keys, as far as its scopes reach.
 */
export function legacyKeysHeld(rows: readonly LegacyRowView[]): Permission[] {
  return PERMISSIONS.filter((key) => {
    const effects = LEGACY_PERMISSION_ACTIONS[key].map(
      (action) => rows.find((row) => row.scopeKind === "instance" && row.action === action)?.effect
    );
    return effects.every((effect) => effect !== undefined) && effects.includes("allow");
  });
}

/**
 * The rights over the instance itself that no asset kind carries and no legacy key names. A
 * role holds them by default; the interface reads which of them a person holds from the
 * platform context.
 */
export const INSTANCE_ACTIONS = [
  "service_principals.manage"
] as const satisfies readonly PlatformAction[];

export const ROLE_DEFAULT_ACTIONS: Record<
  "user" | "admin" | "superadmin",
  readonly PlatformAction[]
> = {
  user: [],
  admin: ACTIONS.filter(
    (action) =>
      action !== "assets.release" &&
      action !== "api_access.manage" &&
      action !== "agent_models.manage"
  ),
  superadmin: ACTIONS.filter((action) => action !== "assets.release")
};

export interface PermissionGrant {
  id: string;
  clientInstanceId: ClientInstanceId;
  holderKind: (typeof GRANT_HOLDER_KINDS)[number];
  holderId: string;
  action: string;
  effect: (typeof GRANT_EFFECTS)[number];
  scopeKind: (typeof GRANT_SCOPE_KINDS)[number];
  scopeId?: string;
  namespace?: string;
  grantedBy: UserId;
  createdAt: ISODateString;
}

export interface Namespace {
  clientInstanceId: ClientInstanceId;
  prefix: string;
  displayName: string;
  allowedToolNames?: string[];
  allowedModelBindingIds?: string[];
  createdBy: UserId;
  createdAt: ISODateString;
}

export interface AccessResource {
  appAvailability?: AppAvailability;
  kind?: string;
  name?: string;
  assetId?: string;
  workspaceId?: string;
}

/**
 * The actions a member of a workspace holds on what that workspace owns, by being a member.
 * Opening a published App is one: it acts with its viewer's rights and shows nothing more.
 */
export const WORKSPACE_MEMBER_ACTIONS = ["app.use"] as const satisfies readonly PlatformAction[];

/**
 * The verbs each bundle of a workspace carries on every kind: Builder reads and writes,
 * Publisher publishes. Neither deletes.
 */
const WORKSPACE_BUNDLE_VERBS: Readonly<Record<string, readonly string[]>> = {
  builder: ["read", "write"],
  publisher: ["publish"]
};

/**
 * Publishes no bundle carries. A guardrail stops other people's work, so who sets one is an
 * instance admin's grant. A Workflow's publish joins the Publisher bundle only after the publish
 * review (DT-1b), once a workspace can own a Workflow (build plan, gate of 2026-10-14).
 */
const BUNDLE_EXCLUDED_ACTIONS: readonly string[] = ["guardrail.publish", "workflow.publish"];

/**
 * Whether a row of the action gives the right asked for: its own action, or a bundle held in a
 * workspace. A workspace row covers only what that workspace owns, so the kinds a bundle reaches
 * are the ones the kind registry lets a workspace own, a kind a later release adds included,
 * without a new row.
 */
function rowGives(
  row: { action: string; scopeKind: PermissionGrant["scopeKind"] },
  action: string
): boolean {
  if (row.action === action) return true;
  const verbs = WORKSPACE_BUNDLE_VERBS[row.action];
  if (
    row.scopeKind !== "workspace" ||
    verbs === undefined ||
    BUNDLE_EXCLUDED_ACTIONS.includes(action)
  ) {
    return false;
  }
  const dot = action.indexOf(".");
  return dot > 0 && verbs.includes(action.slice(dot + 1));
}

export type AccessSource = (typeof ACCESS_SOURCES)[number];

export type AccessDecision =
  | { allowed: true; source: AccessSource }
  | {
      allowed: false;
      /** `outside_key_scope`: the holder has the right, and the personal key of the call does not cover it. */
      reason: "no_grant" | "denied" | "unknown_action" | "holder_inactive" | "outside_key_scope";
    };

export { WORKSPACE_USE_ASSET_KINDS };
export type WorkspaceUseAssetKind = (typeof WORKSPACE_USE_ASSET_KINDS)[number];

export interface PersistedAccess {
  holderActive: boolean;
  grants: PermissionGrant[];
  scopeAssignments?: readonly ScopeAssignmentInput[];
  /**
   * The workspaces the holder is a member of. The evaluator reads a membership as the rights
   * of `WORKSPACE_MEMBER_ACTIONS` on what the workspace owns, so no check of a membership
   * runs beside it. A service principal is a member of none.
   */
  memberWorkspaceIds?: readonly string[];
  /** Only use is inherited from availability; settings, writes and secrets stay explicit. */
  availableAssets?: readonly { assetId: string; kind: WorkspaceUseAssetKind }[];
}

export interface AccessStore {
  loadPersistedAccess(input: {
    clientInstanceId: ClientInstanceId;
    holder: { kind: (typeof PRINCIPAL_HOLDER_KINDS)[number]; id: string };
    /** Absent: inspect rights across memberships. Null: call outside a workspace. */
    workspaceId?: string | null;
  }): Promise<PersistedAccess>;
}

export interface ActorAccess {
  /** No implicit all for an administrator: data assignments are independent of rights. */
  scopeOf(dimension: string): DataScope;
  authorize(action: string, resource?: AccessResource): AccessDecision;
  /** Rights that may be handed on: excludes membership and availability, preserving denies and key scopes. */
  authorizeTransfer(action: string, resource?: AccessResource): AccessDecision;
  /** Throws FORBIDDEN with the action and reason. */
  require(action: string, resource?: AccessResource): void;
  /**
   * A grant row allows the active holder the action at one of these scope kinds, on whichever
   * asset, workspace or Namespace. It tells that something of the kind may be open to the
   * holder and decides no call: a covering deny is not read.
   */
  holdsGrantAt(action: string, scopeKinds: readonly PermissionGrant["scopeKind"][]): boolean;
  /** The holder's denies of the action (of a legacy key, of its actions), wherever they lie. */
  denials(action: string): readonly AccessEntry[];
}

export interface Authorizer {
  forActor(
    actor: AuthenticatedIdentity,
    scope?: { workspaceId: string | null }
  ): Promise<ActorAccess>;
}

/** The free-text reference `x` of a tool is checked as the action `ref:x`. */
export const PERMISSION_REF_ACTION_PREFIX = "ref:";

export { NAMESPACE_PREFIX_MAX_LENGTH, NAMESPACE_PREFIX_MIN_LENGTH, NAMESPACE_PREFIX_PATTERN };

export { GRANTABLE_ACTION_SCOPES };

export type GrantableAction = keyof typeof GRANTABLE_ACTION_SCOPES;

export const GRANTABLE_ACTIONS: readonly GrantableAction[] = ACTIONS.filter(isGrantableAction);

export function isPlatformAction(action: string): action is PlatformAction {
  return ACTIONS.some((candidate) => candidate === action);
}

export function isGrantableAction(action: string): action is GrantableAction {
  return Object.hasOwn(GRANTABLE_ACTION_SCOPES, action);
}

/** Whether a legacy key carries the action: its instance-wide row is that key's. */
export function isLegacyKeyAction(action: string): boolean {
  return PERMISSIONS.some((key) =>
    LEGACY_PERMISSION_ACTIONS[key].some((carried) => carried === action)
  );
}

/** Whether a grant row of the action can be written at the scope kind. */
export function isGrantableAt(
  action: GrantableAction,
  scopeKind: PermissionGrant["scopeKind"]
): boolean {
  return GRANTABLE_ACTION_SCOPES[action].some((candidate) => candidate === scopeKind);
}

export * from "./principal-grantable-actions";

/** The one test of the superadmin role. */
export function isSuperadmin(subject: { roles: readonly string[] }): boolean {
  return subject.roles.includes("superadmin");
}

/**
 * Whoever holds rights, with the two sources the holder's own record carries. A right held
 * one by one, also one of the nine legacy keys, is a grant row: the legacy permission lists
 * were moved into rows (AP-4) and are no source any more.
 */
export interface AccessHolder {
  kind: (typeof PRINCIPAL_HOLDER_KINDS)[number];
  id: string;
  clientInstanceId: ClientInstanceId;
  roles: readonly string[];
  permissionRefs: readonly string[];
  /**
   * The legacy keys the token of a service principal's credential carries. On its request they
   * are the principal's legacy rights in place of the rows its list became, as before AP-4
   * (`tokenRights`). Absent for every other holder.
   */
  tokenKeys?: readonly string[];
}

/** One thing a holder is allowed or denied, with the source that says so. */
export interface AccessEntry {
  action: string;
  effect: (typeof GRANT_EFFECTS)[number];
  scopeKind: PermissionGrant["scopeKind"];
  scopeId?: string;
  namespace?: string;
  source: AccessSource;
}

/** An actor outside the closed union holds nothing: it is refused before any right is read. */
export function accessHolderFromIdentity(actor: AuthenticatedIdentity): AccessHolder {
  if (isAuthenticatedServicePrincipal(actor)) {
    return {
      kind: "service_principal",
      id: actor.id,
      clientInstanceId: actor.clientInstanceId,
      roles: [],
      permissionRefs: actor.permissionRefs,
      // A credential's token carries the keys its scopes reach; a Workflow Run holds its
      // principal's own rights.
      ...("credentialId" in actor ? { tokenKeys: actor.permissions } : {})
    };
  }
  if ("kind" in actor) {
    throw new AppError("FORBIDDEN", "Unknown actor kind");
  }
  return {
    kind: "user",
    id: actor.id,
    clientInstanceId: actor.clientInstanceId,
    roles: actor.roles,
    permissionRefs: actor.permissionRefs
  };
}

/**
 * Everything the four sources say about one holder, in the order role defaults, references,
 * memberships, grant rows. The evaluator and the effective-rights list both read this.
 */
export function listAccessEntries(holder: AccessHolder, persisted: PersistedAccess): AccessEntry[] {
  const entries: AccessEntry[] = [];
  for (const role of holder.roles) {
    if (isDefaultActionRole(role)) {
      for (const action of ROLE_DEFAULT_ACTIONS[role]) {
        entries.push({ action, effect: "allow", scopeKind: "instance", source: "role" });
      }
    }
  }
  for (const permissionRef of holder.permissionRefs) {
    entries.push({
      action: `${PERMISSION_REF_ACTION_PREFIX}${permissionRef}`,
      effect: "allow",
      scopeKind: "instance",
      source: "legacy_ref"
    });
  }
  for (const workspaceId of persisted.memberWorkspaceIds ?? []) {
    for (const action of WORKSPACE_MEMBER_ACTIONS) {
      entries.push({
        action,
        effect: "allow",
        scopeKind: "workspace",
        scopeId: workspaceId,
        source: "membership"
      });
    }
  }
  for (const asset of persisted.availableAssets ?? []) {
    entries.push({
      action: `${asset.kind}.use`,
      effect: "allow",
      scopeKind: "asset",
      scopeId: asset.assetId,
      source: "membership"
    });
  }
  const ownRows = persisted.grants.filter(
    (grant) =>
      grant.clientInstanceId === holder.clientInstanceId &&
      grant.holderKind === holder.kind &&
      grant.holderId === holder.id
  );
  const token = holder.tokenKeys === undefined ? undefined : tokenRights(holder.tokenKeys, ownRows);
  for (const action of token?.allowed ?? []) {
    entries.push({ action, effect: "allow", scopeKind: "instance", source: "grant" });
  }
  for (const grant of persisted.grants) {
    // A row of another client instance or of another holder never applies. Rows held through a
    // role or a group are the store's answer for this holder.
    if (grant.clientInstanceId !== holder.clientInstanceId) {
      continue;
    }
    if (
      (grant.holderKind === "user" || grant.holderKind === "service_principal") &&
      (grant.holderKind !== holder.kind || grant.holderId !== holder.id)
    ) {
      continue;
    }
    if (!isPlatformAction(grant.action)) {
      continue;
    }
    if (
      grant.scopeKind === "instance" &&
      grant.holderKind === holder.kind &&
      token?.replaces(grant)
    ) {
      continue;
    }
    entries.push({
      action: grant.action,
      effect: grant.effect,
      scopeKind: grant.scopeKind,
      ...(grant.scopeId === undefined ? {} : { scopeId: grant.scopeId }),
      ...(grant.namespace === undefined ? {} : { namespace: grant.namespace }),
      source: "grant"
    });
  }
  return entries;
}

/**
 * A token's carried keys stand in for the rows the principal's list became, as before AP-4; a
 * scope carries its first key (`governance:read`: `usage.view`). Rows of a key given in full
 * are the list's; of a mixed key only the allows are; a partly given key is no key of it.
 */
function tokenRights(
  carried: readonly string[],
  ownRows: readonly LegacyRowView[]
): { allowed: PlatformAction[]; replaces(row: LegacyRowView): boolean } {
  const held = legacyKeysHeld(ownRows);
  const heldScopes = new Set(held.map((key) => authScopeForPermission(key)));
  const allowed = PERMISSIONS.filter(
    (key) =>
      carried.includes(key) &&
      (held.includes(key) ||
        (authScopeForPermission(key) !== undefined && heldScopes.has(authScopeForPermission(key))))
  ).flatMap((key) => LEGACY_PERMISSION_ACTIONS[key]);
  return {
    allowed,
    replaces(row) {
      const key = PERMISSIONS.find((candidate) =>
        LEGACY_PERMISSION_ACTIONS[candidate].some((action) => action === row.action)
      );
      if (key === undefined) return false;
      const effects = LEGACY_PERMISSION_ACTIONS[key].map(
        (action) =>
          ownRows.find((own) => own.scopeKind === "instance" && own.action === action)?.effect
      );
      if (effects.some((effect) => effect === undefined)) return false;
      return effects.every((effect) => effect === effects[0]) || row.effect === "allow";
    }
  };
}

function entryCovers(entry: AccessEntry, resource: AccessResource | undefined): boolean {
  switch (entry.scopeKind) {
    case "instance":
      return true;
    case "namespace":
      // A Namespace is a prefix among the instance's own assets. An asset a workspace owns is
      // reached through a right on that workspace, on the asset or on the instance.
      return (
        entry.namespace !== undefined &&
        entry.namespace.length > 0 &&
        resource?.name !== undefined &&
        resource.workspaceId === undefined &&
        resource.name.startsWith(entry.namespace)
      );
    case "asset":
      return entry.scopeId !== undefined && resource?.assetId === entry.scopeId;
    case "workspace":
      return entry.scopeId !== undefined && resource?.workspaceId === entry.scopeId;
    default:
      return false;
  }
}

/** What one action on one resource comes to, with the entry that decided it. */
export interface AccessExplanation {
  decision: AccessDecision;
  /** The covering deny that refuses, or the first covering allow. Absent when nothing covers. */
  entry?: AccessEntry;
}

/**
 * Decides one registered action over a holder's entries: any covering deny refuses, any
 * covering allow permits, otherwise nothing grants it. The evaluator decides with this, and so
 * does a screen that explains a decision from the entries of `permissions.effective`.
 */
export function explainAccessEntries(
  entries: readonly AccessEntry[],
  action: string,
  resource: AccessResource | undefined
): AccessExplanation {
  const covering = entries.filter(
    (entry) => rowGives(entry, action) && entryCovers(entry, resource)
  );
  const deny = covering.find((entry) => entry.effect === "deny");
  if (deny) {
    return { decision: { allowed: false, reason: "denied" }, entry: deny };
  }
  const allow = covering.find((entry) => entry.effect === "allow");
  return allow
    ? { decision: { allowed: true, source: allow.source }, entry: allow }
    : { decision: { allowed: false, reason: "no_grant" } };
}

function evaluateRegisteredAction(
  entries: readonly AccessEntry[],
  action: string,
  resource: AccessResource | undefined
): AccessDecision {
  return explainAccessEntries(entries, action, resource).decision;
}

/**
 * The one place a right is decided. Order: the holder is active; the action is a reference, a
 * legacy key or a registered action; any covering deny refuses; any covering allow permits;
 * otherwise nothing grants it. A legacy key stands for all of its actions at instance scope.
 */
interface AccessEvaluationInput {
  holder: AccessHolder;
  persisted: PersistedAccess;
  action: string;
  resource?: AccessResource;
}

export function evaluateAccess(input: AccessEvaluationInput): AccessDecision {
  return evaluateAccessEntries(input, listAccessEntries(input.holder, input.persisted));
}

/** Membership and availability authorize use in place, never the transfer of a lasting right. */
export function transferableAccessEntries(entries: readonly AccessEntry[]): AccessEntry[] {
  return entries.filter((entry) => entry.source !== "membership");
}

function evaluateAccessEntries(
  input: AccessEvaluationInput,
  entries: readonly AccessEntry[]
): AccessDecision {
  if (!input.persisted.holderActive) {
    return { allowed: false, reason: "holder_inactive" };
  }
  if (input.action.startsWith(PERMISSION_REF_ACTION_PREFIX)) {
    // A reference has one source, the holder's own list. No role, row or deny names one.
    return entries.some((entry) => entry.source === "legacy_ref" && entry.action === input.action)
      ? { allowed: true, source: "legacy_ref" }
      : { allowed: false, reason: "no_grant" };
  }
  const granting = entries.filter((entry) => entry.source !== "legacy_ref");
  if (isPermission(input.action)) {
    let allowed: AccessDecision | undefined;
    let refused: AccessDecision | undefined;
    for (const target of LEGACY_PERMISSION_ACTIONS[input.action]) {
      const decision = evaluateRegisteredAction(granting, target, undefined);
      if (decision.allowed) {
        allowed ??= decision;
      } else if (decision.reason === "denied") {
        return decision;
      } else {
        refused ??= decision;
      }
    }
    return refused ?? allowed ?? { allowed: false, reason: "no_grant" };
  }
  if (isPlatformAction(input.action)) {
    const decision = evaluateRegisteredAction(granting, input.action, input.resource);
    const availability = input.resource?.appAvailability;
    if (input.action === "app.use" && availability) {
      // Availability narrows every use, including a direct asset grant. Explicit denies still
      // win, and the credential's own scope is applied by boundedActorAccess afterwards.
      if (!decision.allowed && decision.reason === "denied") return decision;
      if (availability.audience === "self") {
        return input.holder.kind === "user" &&
          availability.userId === input.holder.id &&
          (decision.allowed ||
            evaluateRegisteredAction(granting, "app.write", input.resource).allowed)
          ? { allowed: true, source: "membership" }
          : { allowed: false, reason: "no_grant" };
      }
      if (availability.audience === "instance" && input.holder.kind === "user") {
        return { allowed: true, source: "membership" };
      }
    }
    return decision;
  }
  return { allowed: false, reason: "unknown_action" };
}

/**
 * The synchronous answers for one holder over one load of the persisted state. With the scopes
 * of a personal key, a right is allowed where the holder has it and a scope covers it: removing
 * the holder's right narrows the key on its next call.
 */
export function createActorAccess(
  holder: AccessHolder,
  persisted: PersistedAccess,
  keyScopes?: readonly string[]
): ActorAccess {
  const decide = (
    decision: AccessDecision,
    action: string,
    resource?: AccessResource
  ): AccessDecision => {
    if (!decision.allowed || keyScopes === undefined || decision.source === "legacy_ref") {
      // A reference names a tool the holder may use, which a key neither widens nor narrows.
      return decision;
    }
    const legacyActions = isPermission(action) ? LEGACY_PERMISSION_ACTIONS[action] : undefined;
    return personalApiKeyCovers(keyScopes, action, resource, legacyActions)
      ? decision
      : { allowed: false, reason: "outside_key_scope" };
  };
  const authorize: ActorAccess["authorize"] = (action, resource) =>
    decide(evaluateAccess({ holder, persisted, action, resource }), action, resource);
  return {
    scopeOf: (dimension) =>
      persisted.holderActive ? resolveDataScope(persisted.scopeAssignments ?? [], dimension) : [],
    authorize,
    authorizeTransfer(action, resource) {
      const transferable = transferableAccessEntries(listAccessEntries(holder, persisted));
      // Availability is permission to use here, never authority to give a lasting right away.
      const { appAvailability: _availability, ...target } = resource ?? {};
      return decide(
        evaluateAccessEntries(
          { holder, persisted, action, resource: resource === undefined ? undefined : target },
          transferable
        ),
        action,
        resource
      );
    },
    require(action, resource) {
      const decision = authorize(action, resource);
      if (!decision.allowed) {
        throw operationDenialError({ kind: "forbidden", action, reason: decision.reason });
      }
    },
    holdsGrantAt: (action, scopeKinds) =>
      persisted.holderActive &&
      (keyScopes === undefined || personalApiKeyNamesAction(keyScopes, action)) &&
      persisted.grants.some(
        (grant) =>
          rowGives(grant, action) &&
          grant.effect === "allow" &&
          scopeKinds.includes(grant.scopeKind)
      ),
    denials(action) {
      const actions: readonly string[] = isPermission(action)
        ? LEGACY_PERMISSION_ACTIONS[action]
        : [action];
      return listAccessEntries(holder, persisted).filter(
        (entry) =>
          entry.effect === "deny" && actions.some((candidate) => rowGives(entry, candidate))
      );
    }
  };
}

/**
 * Loads the persisted state once per call of `forActor` and keeps nothing beyond it. Without a
 * store the holder's own record is the only source: no grant row applies and nothing reports
 * the holder inactive.
 */
export function createAuthorizer(accessStore?: AccessStore): Authorizer {
  return {
    async forActor(actor, scope) {
      const holder = accessHolderFromIdentity(actor);
      const persisted = accessStore
        ? await accessStore.loadPersistedAccess({
            clientInstanceId: holder.clientInstanceId,
            holder: { kind: holder.kind, id: holder.id },
            ...(scope ? { workspaceId: scope.workspaceId } : {})
          })
        : { holderActive: true, grants: [] };
      return createActorAccess(
        holder,
        persisted,
        isAuthenticatedServicePrincipal(actor) ? undefined : actor.keyScopes
      );
    }
  };
}

/** The legacy keys a caller holds: a key is listed when every action behind it is allowed. */
export function allowedLegacyPermissions(access: ActorAccess): Permission[] {
  return PERMISSIONS.filter((permission) => access.authorize(permission).allowed);
}

/** What a Namespace list answers: the record and what refers to it. */
export interface NamespaceUsage extends Namespace {
  /** Grant rows that name the prefix, of any holder and either effect. */
  grantCount: number;
  /** Active agents and skills whose names start with the prefix. */
  assetCount: number;
}

/** The asset an asset-scoped grant row names. */
export interface GrantScopeAsset {
  id: string;
  kind: string;
  name: string;
  /** False once the asset was deleted. Its deny rows stay and apply when the name returns. */
  active: boolean;
  /** The workspace that owns the asset; absent for one of the instance's own. */
  workspaceId?: string;
}

/** The store behind grants and Namespaces: the evaluator's port plus the administration writes. */
export interface AccessAdministrationStore extends AccessStore, RightsLock {
  listScopeAssignments(input: {
    clientInstanceId: ClientInstanceId;
    holderKind: ScopeAssignmentInput["holderKind"];
    holderId: string;
  }): Promise<ScopeAssignmentInput[]>;
  setScopeAssignment(
    input: ScopeAssignmentInput & { clientInstanceId: ClientInstanceId }
  ): Promise<void>;
  /** Non-admin people who inherit use through availability, with their own rows for the evaluator. */
  listAvailabilityMembers(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
    action: string;
    page: StorePage;
  }): Promise<{ userId: UserId; displayLabel: string; grants: PermissionGrant[] }[]>;
  /**
   * Throws CONFLICT `duplicate_grant`, VALIDATION_FAILED `unknown_namespace` for an
   * unregistered prefix, `userInDeletionError` for a user whose deletion was requested, and
   * NOT_FOUND `unknown_holder` for a service principal the instance does not have.
   */
  createGrant(input: Omit<PermissionGrant, "id" | "createdAt">): Promise<PermissionGrant>;
  getGrant(input: {
    clientInstanceId: ClientInstanceId;
    grantId: string;
  }): Promise<PermissionGrant | undefined>;
  deleteGrant(input: {
    clientInstanceId: ClientInstanceId;
    grantId: string;
  }): Promise<PermissionGrant | undefined>;
  listGrants(input: {
    clientInstanceId: ClientInstanceId;
    holderKind?: PermissionGrant["holderKind"];
    holderId?: string;
    action?: string;
    scopeKind?: PermissionGrant["scopeKind"];
    /** The asset or the workspace the rows name. */
    scopeId?: string;
    /** Leaves out the rows whose holder is a user with the superadmin role. */
    excludeSuperadminHolders?: boolean;
    /** Leaves out the rows whose holder is a service principal. */
    excludeServicePrincipalHolders?: boolean;
    /** Administration hides principals managed by their owning asset. */
    excludeOwnedPrincipalHolders?: boolean;
    /**
     * Leaves out the instance-wide rows of the actions a legacy key carries, which the legacy
     * permission lists show. An instance-wide row of any other action is listed.
     */
    excludeLegacyKeyRows?: boolean;
    page?: StorePage;
  }): Promise<PermissionGrant[]>;
  /** Throws CONFLICT `namespace_overlap` naming the registered prefix it meets. */
  createNamespace(input: Omit<Namespace, "createdAt">): Promise<Namespace>;
  /** A list left out is kept; `null` lifts the restriction. */
  updateNamespace(input: {
    clientInstanceId: ClientInstanceId;
    prefix: string;
    displayName?: string;
    allowedToolNames?: string[] | null;
    allowedModelBindingIds?: string[] | null;
  }): Promise<Namespace | undefined>;
  /** Throws CONFLICT `namespace_in_use` while a grant row names the prefix. */
  deleteNamespace(input: {
    clientInstanceId: ClientInstanceId;
    prefix: string;
  }): Promise<Namespace | undefined>;
  /** The Namespaces with what refers to each. It counts per Namespace: for a page that shows the counts. */
  listNamespaces(input: { clientInstanceId: ClientInstanceId }): Promise<NamespaceUsage[]>;
  /** The Namespaces alone, in the byte order of their prefixes: what a write and a list read. */
  listNamespaceRecords(input: { clientInstanceId: ClientInstanceId }): Promise<Namespace[]>;
  /** The active agent or skill an asset-scoped grant names. */
  getGrantableAsset(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
  }): Promise<Omit<GrantScopeAsset, "active"> | undefined>;
  /**
   * The agents and skills behind asset scope ids, deleted ones included: a deny outlives the
   * asset it names, and whoever lists it has to say which name it still refuses.
   */
  listGrantScopeAssets(input: {
    clientInstanceId: ClientInstanceId;
    assetIds: readonly string[];
  }): Promise<GrantScopeAsset[]>;
}

function isDefaultActionRole(role: string): role is keyof typeof ROLE_DEFAULT_ACTIONS {
  return Object.hasOwn(ROLE_DEFAULT_ACTIONS, role);
}

export function isPermission(permission: string): permission is Permission {
  return PERMISSIONS.includes(permission as Permission);
}

const PERMISSION_AUTH_SCOPES: Partial<Record<Permission, string>> = {
  "config_assets.read": "config_assets:read",
  "config_assets.write": "config_assets:write",
  "config_assets.release": "config_assets:release",
  "usage.view": "governance:read",
  "users.manage": "user_admin:write",
  "api_access.manage": "api_access:write",
  "audit.view": "governance:read"
};

export function authScopeForPermission(permission: Permission): string | undefined {
  return PERMISSION_AUTH_SCOPES[permission];
}

export function permissionForAuthScope(scope: string): Permission | undefined {
  return PERMISSIONS.find((permission) => PERMISSION_AUTH_SCOPES[permission] === scope);
}
