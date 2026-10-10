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

export const ACTIONS = [
  "agent.read",
  "agent.write",
  "agent.delete",
  "skill.read",
  "skill.write",
  "skill.delete",
  "skill.approve",
  "users.manage",
  "usage.view",
  "audit.view",
  "api_access.manage",
  "agent_models.manage",
  "assets.release"
] as const;

export type PlatformAction = (typeof ACTIONS)[number];

export const LEGACY_PERMISSION_ACTIONS = {
  "agent_skills.approve": ["skill.approve"],
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

export type AccessDecision =
  | { allowed: true; source: "role" | "legacy" | "legacy_ref" | "grant" }
  | { allowed: false; reason: "no_grant" | "denied" | "unknown_action" | "holder_inactive" };

export interface PersistedAccess {
  holderActive: boolean;
  grants: PermissionGrant[];
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
}

export interface Authorizer {
  forActor(actor: AuthenticatedIdentity): Promise<ActorAccess>;
}

/** The free-text reference `x` of a tool is checked as the action `ref:x`. */
export const PERMISSION_REF_ACTION_PREFIX = "ref:";

/** A Namespace prefix: lowercase words joined by single hyphens, ending in one hyphen. */
export const NAMESPACE_PREFIX_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*-$/u;
export const NAMESPACE_PREFIX_MIN_LENGTH = 2;
export const NAMESPACE_PREFIX_MAX_LENGTH = 32;

/** The actions a grant row can be written for until the slice that brings each further check. */
export const GRANTABLE_ACTIONS = [
  "agent.read",
  "agent.write",
  "agent.delete",
  "skill.read",
  "skill.write",
  "skill.delete"
] as const satisfies readonly PlatformAction[];

export type GrantableAction = (typeof GRANTABLE_ACTIONS)[number];

export function isPlatformAction(action: string): action is PlatformAction {
  return ACTIONS.some((candidate) => candidate === action);
}

export function isGrantableAction(action: string): action is GrantableAction {
  return GRANTABLE_ACTIONS.some((candidate) => candidate === action);
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
  source: "role" | "legacy" | "legacy_ref" | "grant";
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
      return (
        entry.namespace !== undefined &&
        entry.namespace.length > 0 &&
        resource?.name !== undefined &&
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

function evaluateRegisteredAction(
  entries: readonly AccessEntry[],
  action: string,
  resource: AccessResource | undefined
): AccessDecision {
  const covering = entries.filter(
    (entry) => entry.action === action && entryCovers(entry, resource)
  );
  if (covering.some((entry) => entry.effect === "deny")) {
    return { allowed: false, reason: "denied" };
  }
  const allow = covering.find((entry) => entry.effect === "allow");
  return allow ? { allowed: true, source: allow.source } : { allowed: false, reason: "no_grant" };
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

/** The store behind grants and Namespaces: the evaluator's port plus the administration writes. */
export interface AccessAdministrationStore extends AccessStore {
  /**
   * Throws CONFLICT `duplicate_grant`, VALIDATION_FAILED `unknown_namespace` for an
   * unregistered prefix, and `userInDeletionError` for a user whose deletion was requested.
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
    /** Leaves out the rows whose holder is a user with the superadmin role. */
    excludeSuperadminHolders?: boolean;
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
  listNamespaces(input: { clientInstanceId: ClientInstanceId }): Promise<NamespaceUsage[]>;
  /** The active agent or skill an asset-scoped grant names. */
  getGrantableAsset(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
  }): Promise<{ id: string; kind: string; name: string } | undefined>;
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
