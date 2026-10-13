import {
  ACTIONS,
  NAMESPACE_PREFIX_MAX_LENGTH,
  NAMESPACE_PREFIX_MIN_LENGTH,
  NAMESPACE_PREFIX_PATTERN,
  type PlatformAction
} from "@vivd-catalyst/asset-schemas";
import { AppError } from "./errors";
import { operationDenialError } from "./operation-denial";
import {
  isAuthenticatedServicePrincipal,
  type AuthenticatedIdentity,
  type AuthenticatedServicePrincipal,
  type AuthenticatedUser
} from "./identity";
import type { ClientInstanceId, UserId } from "./ids";
import type { StorePage } from "./paging";
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

function legacyPermissionsFor(actions: readonly PlatformAction[]): Permission[] {
  return PERMISSIONS.filter((permission) =>
    LEGACY_PERMISSION_ACTIONS[permission].every((action) => actions.includes(action))
  );
}

export const ROLE_DEFAULT_PERMISSIONS: Record<
  "user" | "admin" | "superadmin",
  readonly Permission[]
> = {
  user: legacyPermissionsFor(ROLE_DEFAULT_ACTIONS.user),
  admin: legacyPermissionsFor(ROLE_DEFAULT_ACTIONS.admin),
  superadmin: legacyPermissionsFor(ROLE_DEFAULT_ACTIONS.superadmin)
};

export interface PermissionGrant {
  id: string;
  clientInstanceId: ClientInstanceId;
  holderKind: "user" | "service_principal" | "role" | "group";
  holderId: string;
  action: string;
  effect: "allow" | "deny";
  scopeKind: "instance" | "workspace" | "namespace" | "asset";
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

export type AccessSource = "role" | "legacy" | "legacy_ref" | "grant" | "membership";

export type AccessDecision =
  | { allowed: true; source: AccessSource }
  | { allowed: false; reason: "no_grant" | "denied" | "unknown_action" | "holder_inactive" };

export interface PersistedAccess {
  holderActive: boolean;
  grants: PermissionGrant[];
  /**
   * The workspaces the holder is a member of. The evaluator reads a membership as the rights
   * of `WORKSPACE_MEMBER_ACTIONS` on what the workspace owns, so no check of a membership
   * runs beside it. A service principal is a member of none.
   */
  memberWorkspaceIds?: readonly string[];
}

export interface AccessStore {
  loadPersistedAccess(input: {
    clientInstanceId: ClientInstanceId;
    holder: { kind: "user" | "service_principal"; id: string };
  }): Promise<PersistedAccess>;
}

export interface ActorAccess {
  authorize(action: string, resource?: AccessResource): AccessDecision;
  /** Throws FORBIDDEN with the action and reason. */
  require(action: string, resource?: AccessResource): void;
  /**
   * A grant row allows the active holder the action at one of these scope kinds, on whichever
   * asset, workspace or Namespace. It tells that something of the kind may be open to the
   * holder and decides no call: a covering deny is not read.
   */
  holdsGrantAt(action: string, scopeKinds: readonly PermissionGrant["scopeKind"][]): boolean;
}

export interface Authorizer {
  forActor(actor: AuthenticatedIdentity): Promise<ActorAccess>;
}

/** The free-text reference `x` of a tool is checked as the action `ref:x`. */
export const PERMISSION_REF_ACTION_PREFIX = "ref:";

export { NAMESPACE_PREFIX_MAX_LENGTH, NAMESPACE_PREFIX_MIN_LENGTH, NAMESPACE_PREFIX_PATTERN };

/**
 * The actions a grant row can be written for, each with the scope kinds it can be written at,
 * until the slice that brings each further check. No row is written at instance scope: the
 * whole instance is a role's.
 */
export const GRANTABLE_ACTION_SCOPES = {
  "agent.read": ["namespace", "asset"],
  "agent.write": ["namespace", "asset"],
  "agent.delete": ["namespace", "asset"],
  "skill.read": ["namespace", "asset"],
  "skill.write": ["namespace", "asset"],
  "skill.delete": ["namespace", "asset"],
  // Reading and using a Connection are granted in a Namespace, on one Connection or on what
  // a workspace owns. Writing, deleting and approving stay with the role until a slice opens
  // them.
  "connection.read": ["namespace", "asset", "workspace"],
  "connection.use": ["namespace", "asset", "workspace"],
  // A Workflow is the instance's own: its rights are granted in a Namespace or on one Workflow,
  // and no workspace owns one yet. Reading shows it and its runs, using starts it, writing
  // edits the draft and publishing moves the published pointer; making a revision live that
  // names a service principal asks the right over that principal beside it. Deleting and the
  // rows of a run's datasets stay with the role.
  "workflow.read": ["namespace", "asset"],
  "workflow.use": ["namespace", "asset"],
  "workflow.write": ["namespace", "asset"],
  "workflow.publish": ["namespace", "asset"]
} as const satisfies Partial<
  Record<PlatformAction, readonly Exclude<PermissionGrant["scopeKind"], "instance">[]>
>;

export type GrantableAction = keyof typeof GRANTABLE_ACTION_SCOPES;

export const GRANTABLE_ACTIONS: readonly GrantableAction[] = ACTIONS.filter(isGrantableAction);

export function isPlatformAction(action: string): action is PlatformAction {
  return ACTIONS.some((candidate) => candidate === action);
}

export function isGrantableAction(action: string): action is GrantableAction {
  return Object.hasOwn(GRANTABLE_ACTION_SCOPES, action);
}

/** Whether a grant row of the action can be written at the scope kind. */
export function isGrantableAt(
  action: GrantableAction,
  scopeKind: PermissionGrant["scopeKind"]
): boolean {
  return GRANTABLE_ACTION_SCOPES[action].some((candidate) => candidate === scopeKind);
}

/**
 * The rights a grant row can give a service principal: the use rights of a resource and
 * nothing else. No right that writes, publishes, deletes or manages is here, and none over
 * users, access or API access. A kind adds its use right when it brings one; the grant write
 * hands out only those of them a kind of the instance registers. The list limits what the
 * grant operation writes; the evaluator answers from whatever rows the table holds.
 */
export const PRINCIPAL_GRANTABLE_ACTIONS = [
  "connection.use",
  "data_store.read",
  "data_store.insert",
  "data_store.execute",
  "knowledge_base.use",
  "workflow.use"
] as const satisfies readonly PlatformAction[];

export type PrincipalGrantableAction = (typeof PRINCIPAL_GRANTABLE_ACTIONS)[number];

export function isPrincipalGrantableAction(action: string): action is PrincipalGrantableAction {
  return PRINCIPAL_GRANTABLE_ACTIONS.some((candidate) => candidate === action);
}

/** The one test of the superadmin role. */
export function isSuperadmin(subject: { roles: readonly string[] }): boolean {
  return subject.roles.includes("superadmin");
}

/** Whoever holds rights, with the three sources the holder's own record carries. */
export interface AccessHolder {
  kind: "user" | "service_principal";
  id: string;
  clientInstanceId: ClientInstanceId;
  roles: readonly string[];
  /** The legacy column: keys, and `!key` revocations. */
  permissions: readonly string[];
  permissionRefs: readonly string[];
}

/** One thing a holder is allowed or denied, with the source that says so. */
export interface AccessEntry {
  action: string;
  effect: "allow" | "deny";
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
      permissions: actor.permissions,
      permissionRefs: actor.permissionRefs
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
    permissions: actor.permissions ?? [],
    permissionRefs: actor.permissionRefs
  };
}

/**
 * Everything the four sources say about one holder, in the order role defaults, legacy column,
 * references, grant rows. The evaluator and the effective-rights list both read this.
 */
export function listAccessEntries(holder: AccessHolder, persisted: PersistedAccess): AccessEntry[] {
  const entries: AccessEntry[] = [];
  for (const role of holder.roles) {
    if (isDefaultPermissionRole(role)) {
      for (const action of ROLE_DEFAULT_ACTIONS[role]) {
        entries.push({ action, effect: "allow", scopeKind: "instance", source: "role" });
      }
    }
  }
  for (const entry of holder.permissions) {
    const revoked = entry.startsWith("!");
    const permission = revoked ? entry.slice(1) : entry;
    if (!isPermission(permission)) {
      continue;
    }
    for (const action of LEGACY_PERMISSION_ACTIONS[permission]) {
      entries.push({
        action,
        effect: revoked ? "deny" : "allow",
        scopeKind: "instance",
        source: "legacy"
      });
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
    (entry) => entry.action === action && entryCovers(entry, resource)
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
export function evaluateAccess(input: {
  holder: AccessHolder;
  persisted: PersistedAccess;
  action: string;
  resource?: AccessResource;
}): AccessDecision {
  if (!input.persisted.holderActive) {
    return { allowed: false, reason: "holder_inactive" };
  }
  const entries = listAccessEntries(input.holder, input.persisted);
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
    return evaluateRegisteredAction(granting, input.action, input.resource);
  }
  return { allowed: false, reason: "unknown_action" };
}

/** The synchronous answers for one holder over one load of the persisted state. */
export function createActorAccess(holder: AccessHolder, persisted: PersistedAccess): ActorAccess {
  const authorize = (action: string, resource?: AccessResource) =>
    evaluateAccess({ holder, persisted, action, resource });
  return {
    authorize,
    require(action, resource) {
      const decision = authorize(action, resource);
      if (!decision.allowed) {
        throw operationDenialError({ kind: "forbidden", action, reason: decision.reason });
      }
    },
    holdsGrantAt: (action, scopeKinds) =>
      persisted.holderActive &&
      persisted.grants.some(
        (grant) =>
          grant.action === action &&
          grant.effect === "allow" &&
          scopeKinds.includes(grant.scopeKind)
      )
  };
}

/**
 * Loads the persisted state once per call of `forActor` and keeps nothing beyond it. Without a
 * store the holder's own record is the only source: no grant row applies and nothing reports
 * the holder inactive.
 */
export function createAuthorizer(accessStore?: AccessStore): Authorizer {
  return {
    async forActor(actor) {
      const holder = accessHolderFromIdentity(actor);
      const persisted = accessStore
        ? await accessStore.loadPersistedAccess({
            clientInstanceId: holder.clientInstanceId,
            holder: { kind: holder.kind, id: holder.id }
          })
        : { holderActive: true, grants: [] };
      return createActorAccess(holder, persisted);
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
}

/** The store behind grants and Namespaces: the evaluator's port plus the administration writes. */
export interface AccessAdministrationStore extends AccessStore {
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
  }): Promise<{ id: string; kind: string; name: string } | undefined>;
  /**
   * The agents and skills behind asset scope ids, deleted ones included: a deny outlives the
   * asset it names, and whoever lists it has to say which name it still refuses.
   */
  listGrantScopeAssets(input: {
    clientInstanceId: ClientInstanceId;
    assetIds: readonly string[];
  }): Promise<GrantScopeAsset[]>;
}

export function resolveEffectivePermissions(
  subject:
    | Pick<AuthenticatedUser, "roles" | "permissions">
    | Pick<AuthenticatedServicePrincipal, "permissions">
): ReadonlySet<Permission> {
  const effective = new Set<Permission>();
  const revocations = new Set<Permission>();

  for (const role of "roles" in subject ? subject.roles : []) {
    if (isDefaultPermissionRole(role)) {
      for (const permission of ROLE_DEFAULT_PERMISSIONS[role]) {
        effective.add(permission);
      }
    }
  }

  for (const entry of subject.permissions ?? []) {
    const revoked = entry.startsWith("!");
    const permission = revoked ? entry.slice(1) : entry;
    if (!isPermission(permission)) {
      continue;
    }
    if (revoked) {
      revocations.add(permission);
    } else {
      effective.add(permission);
    }
  }

  for (const permission of revocations) {
    effective.delete(permission);
  }

  return effective;
}

export function hasPermission(
  subject:
    | Pick<AuthenticatedUser, "roles" | "permissions">
    | Pick<AuthenticatedServicePrincipal, "permissions">,
  permission: Permission
): boolean {
  return resolveEffectivePermissions(subject).has(permission);
}

export function requirePermission(
  subject:
    | Pick<AuthenticatedUser, "roles" | "permissions">
    | Pick<AuthenticatedServicePrincipal, "permissions">,
  permission: Permission
): void {
  if (!hasPermission(subject, permission)) {
    throw new AppError("FORBIDDEN", `Missing permission '${permission}'`);
  }
}

function isDefaultPermissionRole(role: string): role is keyof typeof ROLE_DEFAULT_PERMISSIONS {
  return role === "user" || role === "admin" || role === "superadmin";
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
