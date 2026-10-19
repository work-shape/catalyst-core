import {
  ROLE_DEFAULT_ACTIONS,
  isBuiltInRole,
  isEditableBuiltInRole,
  isSuperadminGrantedAction,
  type BuiltInRole,
  type ClientInstanceId,
  type HeldRight,
  type RoleGrant,
  type RoleRecord,
  type RoleStore
} from "@work-shape/catalyst-core";
import { rightAtScope, scopeAssets } from "./person-rights";
import type { PrincipalRightsOptions } from "./principal-rights";

/** What the rights of a role are read from. */
export interface RoleRightsOptions extends PrincipalRightsOptions {
  roles: Pick<RoleStore, "getRole">;
}

/** The grants of the release's default of a built-in role: one instance-wide allow per action. */
export function defaultRoleGrants(role: BuiltInRole): RoleGrant[] {
  return ROLE_DEFAULT_ACTIONS[role].map((action) => ({
    action,
    effect: "allow",
    scopeKind: "instance"
  }));
}

/**
 * What a role holds now, or nothing for a role the instance does not have: a stored role its
 * rows, a built-in one nobody edited its release default, and `superadmin` the floor.
 */
export async function currentRoleGrants(
  options: RoleRightsOptions,
  roleId: string
): Promise<RoleGrant[] | undefined> {
  if (roleId === "superadmin") return defaultRoleGrants("superadmin");
  const stored = await options.roles.getRole({
    clientInstanceId: options.clientInstanceId,
    roleId
  });
  if (stored) return stored.grants;
  return isEditableBuiltInRole(roleId) ? defaultRoleGrants(roleId) : undefined;
}

/** Whether the role, as it is now, allows an action only a superadmin hands out. */
export function carriesSuperadminGrantedAction(grants: readonly RoleGrant[]): boolean {
  return grants.some(
    (grant) => grant.effect === "allow" && isSuperadminGrantedAction(grant.action)
  );
}

/** The rights grants name, each at its scope, as the rule of no escalation asks them. */
export async function rightsOfGrants(
  options: PrincipalRightsOptions,
  grants: readonly RoleGrant[]
): Promise<HeldRight[]> {
  const assets = await scopeAssets(options, grants);
  return grants.map((grant) => rightAtScope(grant, assets));
}

/** A role a person can be given: a built-in one, or a custom role the instance has. */
export async function isKnownRole(options: RoleRightsOptions, roleId: string): Promise<boolean> {
  return isBuiltInRole(roleId) || (await currentRoleGrants(options, roleId)) !== undefined;
}

/** A built-in role nobody edited: its release default, and `superadmin` the floor. */
export function unstoredBuiltInRole(
  clientInstanceId: ClientInstanceId,
  roleId: BuiltInRole
): RoleRecord {
  return {
    clientInstanceId,
    id: roleId,
    name: roleId,
    builtIn: true,
    grants: defaultRoleGrants(roleId),
    ...(isEditableBuiltInRole(roleId) ? { defaultActions: [...ROLE_DEFAULT_ACTIONS[roleId]] } : {}),
    pendingActions: []
  };
}
