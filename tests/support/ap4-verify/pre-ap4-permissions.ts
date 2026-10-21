import { ACTIONS, type PlatformAction } from "@work-shape/catalyst-asset-schemas";
// Frozen copy of packages/core/src/permissions.ts at 6c1ab255 (the commit before AP-4), for the AP-4 verifier.
// Without the prefix scope that NS-RETIRE retired: the verifier seeds no row of it.
import {
  operationDenialError,
  type AuthenticatedServicePrincipal,
  type AuthenticatedUser,
  type ClientInstanceId,
  type UserId,
  type ISODateString
} from "@work-shape/catalyst-core";

const PERMISSIONS = [
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

const LEGACY_PERMISSION_ACTIONS = {
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

const ROLE_DEFAULT_ACTIONS: Record<"user" | "admin" | "superadmin", readonly PlatformAction[]> = {
  user: [],
  admin: ACTIONS.filter(
    (action) =>
      action !== "assets.release" &&
      action !== "api_access.manage" &&
      action !== "agent_models.manage" &&
      // Came after AP-4 and outside the admin default (AP-5b1); the frozen list is today's.
      action !== "roles.edit_built_in"
  ),
  superadmin: ACTIONS.filter((action) => action !== "assets.release")
};

function legacyPermissionsFor(actions: readonly PlatformAction[]): Permission[] {
  return PERMISSIONS.filter((permission) =>
    LEGACY_PERMISSION_ACTIONS[permission].every((action) => actions.includes(action))
  );
}

const ROLE_DEFAULT_PERMISSIONS: Record<"user" | "admin" | "superadmin", readonly Permission[]> = {
  user: legacyPermissionsFor(ROLE_DEFAULT_ACTIONS.user),
  admin: legacyPermissionsFor(ROLE_DEFAULT_ACTIONS.admin),
  superadmin: legacyPermissionsFor(ROLE_DEFAULT_ACTIONS.superadmin)
};

interface PermissionGrant {
  id: string;
  clientInstanceId: ClientInstanceId;
  holderKind: "user" | "service_principal" | "role" | "group";
  holderId: string;
  action: string;
  effect: "allow" | "deny";
  scopeKind: "instance" | "workspace" | "asset";
  scopeId?: string;
  grantedBy: UserId;
  createdAt: ISODateString;
}

interface AccessResource {
  kind?: string;
  name?: string;
  assetId?: string;
  workspaceId?: string;
}

/**
 * The actions a member of a workspace holds on what that workspace owns, by being a member.
 * Opening a published App is one: it acts with its viewer's rights and shows nothing more.
 */
const WORKSPACE_MEMBER_ACTIONS = ["app.use"] as const satisfies readonly PlatformAction[];

type AccessSource = "role" | "legacy" | "legacy_ref" | "grant" | "membership";

type AccessDecision =
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

export interface ActorAccess {
  authorize(action: string, resource?: AccessResource): AccessDecision;
  /** Throws FORBIDDEN with the action and reason. */
  require(action: string, resource?: AccessResource): void;
  /**
   * A grant row allows the active holder the action at one of these scope kinds, on whichever
   * asset or workspace. It tells that something of the kind may be open to the
   * holder and decides no call: a covering deny is not read.
   */
  holdsGrantAt(action: string, scopeKinds: readonly PermissionGrant["scopeKind"][]): boolean;
}

/** The free-text reference `x` of a tool is checked as the action `ref:x`. */
const PERMISSION_REF_ACTION_PREFIX = "ref:";

// What could be granted where is left out of the copy. It allowed no row at instance scope:
// the whole instance was a role's.

function isPlatformAction(action: string): action is PlatformAction {
  return ACTIONS.some((candidate) => candidate === action);
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
interface AccessEntry {
  action: string;
  effect: "allow" | "deny";
  scopeKind: PermissionGrant["scopeKind"];
  scopeId?: string;
  source: AccessSource;
}

/**
 * Everything the four sources say about one holder, in the order role defaults, legacy column,
 * references, grant rows. The evaluator and the effective-rights list both read this.
 */
function listAccessEntries(holder: AccessHolder, persisted: PersistedAccess): AccessEntry[] {
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
      source: "grant"
    });
  }
  return entries;
}

function entryCovers(entry: AccessEntry, resource: AccessResource | undefined): boolean {
  switch (entry.scopeKind) {
    case "instance":
      return true;
    case "asset":
      return entry.scopeId !== undefined && resource?.assetId === entry.scopeId;
    case "workspace":
      return entry.scopeId !== undefined && resource?.workspaceId === entry.scopeId;
    default:
      return false;
  }
}

/** What one action on one resource comes to, with the entry that decided it. */
interface AccessExplanation {
  decision: AccessDecision;
  /** The covering deny that refuses, or the first covering allow. Absent when nothing covers. */
  entry?: AccessEntry;
}

/**
 * Decides one registered action over a holder's entries: any covering deny refuses, any
 * covering allow permits, otherwise nothing grants it. The evaluator decides with this, and so
 * does a screen that explains a decision from the entries of `permissions.effective`.
 */
function explainAccessEntries(
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
function evaluateAccess(input: {
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

function isDefaultPermissionRole(role: string): role is keyof typeof ROLE_DEFAULT_PERMISSIONS {
  return role === "user" || role === "admin" || role === "superadmin";
}

export function isPermission(permission: string): permission is Permission {
  return PERMISSIONS.some((key) => key === permission);
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

/** The key a request's token read a scope as. */
export function permissionForAuthScope(scope: string): Permission | undefined {
  return PERMISSIONS.find((permission) => PERMISSION_AUTH_SCOPES[permission] === scope);
}
