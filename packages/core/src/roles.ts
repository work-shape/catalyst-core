import {
  ACTIONS,
  PROJECT_ACTIONS,
  ROLE_GRANT_SCOPE_KINDS,
  ROLE_PENDING_CHANGES,
  ROLE_PENDING_DECISIONS,
  type GrantEffect,
  type PlatformAction,
  type RoleGrantScopeKind,
  type RolePendingDecision
} from "@work-shape/catalyst-asset-schemas";
import type { ClientInstanceId, UserId } from "./ids";

// Roles as data (ADR-0028). `user` and `admin` hold rows of `permission_grants` once a holder
// of `roles.edit_built_in` edits them, and their release default until then; `superadmin` is
// the floor and stays code.

/** The roles every instance has. Their ids are their names, and no custom role takes one. */
export const BUILT_IN_ROLES = ["user", "admin", "superadmin"] as const;
export type BuiltInRole = (typeof BUILT_IN_ROLES)[number];

/** The built-in roles that are edited and reset. `superadmin` is neither. */
export const EDITABLE_BUILT_IN_ROLES = ["user", "admin"] as const;
export type EditableBuiltInRole = (typeof EDITABLE_BUILT_IN_ROLES)[number];

/**
 * The rights only a superadmin hands out: a grant of one, to a person, a role or a group, and
 * a role that carries one. Nobody else gives or takes them, also not through a role.
 */
export const SUPERADMIN_GRANTED_ACTIONS = [
  "api_access.manage",
  "agent_models.manage"
] as const satisfies readonly PlatformAction[];

/**
 * The rights whose default sits with `superadmin` alone. Unlike the list above, anybody who
 * holds one may give it on, to a person or a role, under the rule of no escalation.
 * `roles.edit_built_in` edits and resets `user` and `admin` (Felix, 2026-10-21, amending
 * ADR-0028 point 1). `users.delete` deletes an account and its data, `jobs.retry` runs a
 * background job again that the product gave up on, and `system.view` shows how the instance
 * runs, the Settings group "System" (RIGHTS-1e: D5, UX audit ruling 2).
 */
export const SUPERADMIN_DEFAULT_ACTIONS = [
  "roles.edit_built_in",
  "users.delete",
  "jobs.retry",
  "system.view"
] as const satisfies readonly PlatformAction[];

/**
 * The release's default of each built-in role, every action at instance scope. For `user` and
 * `admin` it is what a role nobody edited holds, what "Reset to default" restores, and what the
 * migration step compares an edited role with to find what a release added or removed.
 * `superadmin` holds every action the release knows except `assets.release`, computed and never
 * stored, so a new action is reachable by somebody from the first start.
 */
export const ROLE_DEFAULT_ACTIONS: Record<BuiltInRole, readonly PlatformAction[]> = {
  user: [],
  admin: ACTIONS.filter(
    (action) =>
      action !== "assets.release" &&
      !isMembershipOnlyAction(action) &&
      !isSuperadminGrantedAction(action) &&
      !SUPERADMIN_DEFAULT_ACTIONS.some((candidate) => candidate === action)
  ),
  // A project is reached through membership alone: no role holds its rights (PRJ-1).
  superadmin: ACTIONS.filter(
    (action) => action !== "assets.release" && !isMembershipOnlyAction(action)
  )
};

/** The rights only membership of a workspace carries, a project's (permissions.ts). */
function isMembershipOnlyAction(action: string): boolean {
  return PROJECT_ACTIONS.some((candidate) => candidate === action);
}

export function isBuiltInRole(role: string): role is BuiltInRole {
  return BUILT_IN_ROLES.some((candidate) => candidate === role);
}

export function isEditableBuiltInRole(role: string): role is EditableBuiltInRole {
  return EDITABLE_BUILT_IN_ROLES.some((candidate) => candidate === role);
}

export function isSuperadminGrantedAction(action: string): boolean {
  return SUPERADMIN_GRANTED_ACTIONS.some((candidate) => candidate === action);
}

export {
  ROLE_GRANT_SCOPE_KINDS,
  ROLE_PENDING_CHANGES,
  ROLE_PENDING_DECISIONS,
  type RoleGrantScopeKind,
  type RolePendingDecision
};

/** One right a role holds, at its scope. */
export interface RoleGrant {
  action: string;
  effect: GrantEffect;
  scopeKind: RoleGrantScopeKind;
  /** The workspace or the asset; absent at instance scope. */
  scopeId?: string;
}

/**
 * An action a release added to (`added`) or took out of (`removed`) the default of a built-in
 * role somebody had edited. The release changed nothing of the role; the action waits until a
 * holder of `roles.edit_built_in` adds it or leaves it out, or takes it away or keeps it.
 */
export interface RolePendingAction {
  action: string;
  change: (typeof ROLE_PENDING_CHANGES)[number];
}

/**
 * A stored role: every custom role, and a built-in one from its first edit. A built-in role
 * without a record holds its release default and is equal to it.
 */
export interface RoleRecord {
  clientInstanceId: ClientInstanceId;
  id: string;
  name: string;
  description?: string;
  builtIn: boolean;
  grants: RoleGrant[];
  /**
   * The default a stored built-in role was last reconciled with. The migration step compares it
   * with the release's to find what the release changed. Absent for a custom role.
   */
  defaultActions?: string[];
  pendingActions: RolePendingAction[];
}

/** The store of roles. Each write takes the rights locks (`RightsLock`) itself. */
export interface RoleStore {
  /** The stored roles, built-in ones first and then by name. */
  listRoles(input: { clientInstanceId: ClientInstanceId }): Promise<RoleRecord[]>;
  getRole(input: {
    clientInstanceId: ClientInstanceId;
    roleId: string;
  }): Promise<RoleRecord | undefined>;
  /**
   * Writes the role and replaces its grants with `grants`, in one transaction. Throws CONFLICT
   * `role_name_taken` when another role of the instance has the name.
   */
  saveRole(input: RoleRecord & { grantedBy: UserId }): Promise<RoleRecord>;
  /**
   * Removes the role and its grants. A built-in role holds its release default again. Throws
   * CONFLICT `role_in_use` for a custom role a person still holds.
   */
  deleteRole(input: {
    clientInstanceId: ClientInstanceId;
    roleId: string;
  }): Promise<RoleRecord | undefined>;
}
