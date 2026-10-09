import { AppError } from "./errors";
import { operationDenialError } from "./operation-denial";
import type {
  AuthenticatedIdentity,
  AuthenticatedServicePrincipal,
  AuthenticatedUser
} from "./identity";
import type { ClientInstanceId, UserId } from "./ids";
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
  namespaces: Namespace[];
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

/**
 * Rights as the legacy permissions hold them, behind the interface AP-1's evaluator will
 * implement. It knows the registered actions only and ignores the resource.
 */
export const legacyAuthorizer: Authorizer = {
  forActor(actor) {
    const authorize = (action: string): AccessDecision => {
      if (!isPlatformAction(action)) return { allowed: false, reason: "unknown_action" };
      // AP-1 replaces this line with its evaluator.
      return hasPermission(actor, legacyPermissionFor(action))
        ? { allowed: true, source: "legacy" }
        : { allowed: false, reason: "no_grant" };
    };
    return Promise.resolve({
      authorize,
      require(action) {
        const decision = authorize(action);
        if (!decision.allowed) {
          throw operationDenialError({ kind: "forbidden", action, reason: decision.reason });
        }
      }
    });
  }
};

function isPlatformAction(action: string): action is PlatformAction {
  return ACTIONS.some((candidate) => candidate === action);
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
