import {
  AppError,
  BUILT_IN_ROLES,
  asCollaborationWorkspaceId,
  asUserId,
  auditActorFromIdentity,
  createPlatformId,
  isAuthenticatedServicePrincipal,
  isBuiltInRole,
  isEditableBuiltInRole,
  isGrantableAction,
  isGrantableAt,
  isPlatformAction,
  isSuperadmin,
  isSuperadminGrantedAction,
  type ActorAccess,
  type AuthenticatedIdentity,
  type AuthenticatedUser,
  type BuiltInRole,
  type JsonObject,
  type OperationAuthorization,
  type OperationExecutionContext,
  type RoleGrant,
  type RolePendingDecision,
  type RoleRecord
} from "@work-shape/catalyst-core";
import type { ChatServerOptions } from "../types";
import { holderNotAdministrable } from "./grant-holder-rules";
import { authorizeHeldRightsWithin } from "./held-rights-within";
import { grantableAsset, refused } from "./principal-grant";
import { requireAuthorized, withRightsHeld } from "./rights-held";
import {
  currentRoleGrants,
  defaultRoleGrants,
  rightsOfGrants,
  unstoredBuiltInRole,
  type RoleRightsOptions
} from "./role-rights";

/** The right every role write asks for, on the instance. */
const MANAGE_ACTION = "users.manage";

/** The right a write to `user` or `admin` asks for beside it, on the instance. */
const EDIT_BUILT_IN_ACTION = "roles.edit_built_in";

/**
 * What a role holds beyond what a person can be granted: `app.use` on one App or on the Apps
 * of one workspace. A person holds it through membership of the App's workspace; a role, such
 * as one that uses two Apps of the accounting team, gives it to its holders without one.
 */
const ROLE_ONLY_SCOPES: Readonly<Record<string, readonly RoleGrant["scopeKind"][]>> = {
  "app.use": ["workspace", "asset"]
};

function isRoleGrantableAt(action: string, scopeKind: RoleGrant["scopeKind"]): boolean {
  if (ROLE_ONLY_SCOPES[action]?.includes(scopeKind)) return true;
  return isGrantableAction(action) && isGrantableAt(action, scopeKind);
}

/** What a role write takes from its Operation Run. */
type RoleWriteContext = Pick<
  OperationExecutionContext,
  "actor" | "access" | "audit" | "correlationId"
>;

/** A role as the role screen reads it. */
export interface RoleView extends RoleRecord {
  /** False for `superadmin`, the floor. */
  editable: boolean;
  defaultGrants?: RoleGrant[];
  equalsDefault?: boolean;
}

/** The write a call asks for, as the rules read it. */
export interface RoleChange {
  /** The role the call changes; none for a role it creates. */
  roleId?: string;
  /** The grants the role holds after the call; left out where the call changes none. */
  grants?: readonly RoleGrant[];
}

/**
 * Roles as data (ADR-0028). A holder of `users.manage` writes custom roles, and edits, resets or
 * decides for `user` and `admin` while also holding `roles.edit_built_in`. Only a superadmin
 * gives or takes, in any role, a right only a superadmin hands out. `superadmin` is the floor
 * and is never written. Whoever writes a
 * grant into a role holds what it gives, an allow or a deny alike, as for a grant to a person.
 * Every write is an audit event with the grants added and removed.
 */
export class RoleWorkflow {
  constructor(private readonly options: ChatServerOptions) {}

  /** The three built-in roles, then the custom roles by name. */
  async list(): Promise<RoleView[]> {
    const stored = await this.options.stores.roles.listRoles({
      clientInstanceId: this.options.clientInstanceId
    });
    const builtIn = BUILT_IN_ROLES.map((id) =>
      this.view(stored.find((role) => role.id === id) ?? this.unstored(id))
    );
    return [...builtIn, ...stored.filter((role) => !role.builtIn).map((role) => this.view(role))];
  }

  async get(roleId: string): Promise<RoleView> {
    return this.view(await this.findOrThrow(roleId));
  }

  /**
   * Who may make the change, asked before the policy and again where it writes. A role that
   * does not exist passes: the write answers that itself.
   */
  async authorizeWrite(
    actor: AuthenticatedIdentity,
    access: ActorAccess,
    operation: string,
    change: RoleChange
  ): Promise<OperationAuthorization> {
    if (isAuthenticatedServicePrincipal(actor)) {
      return holderNotAdministrable(operation, "A service principal writes no role");
    }
    const right = access.authorize(MANAGE_ACTION);
    if (!right.allowed) return { allowed: false, action: MANAGE_ACTION, reason: right.reason };
    if (change.roleId === "superadmin") {
      return holderNotAdministrable(
        operation,
        "The superadmin role is the floor: nobody edits, resets or deletes it"
      );
    }
    if (change.roleId !== undefined && isBuiltInRole(change.roleId)) {
      // A built-in role changes the rights of everybody who holds it at once: its own right,
      // held by `superadmin` by default and given on like any other (Felix, 2026-10-21).
      const edit = access.authorize(EDIT_BUILT_IN_ACTION);
      if (!edit.allowed) {
        return {
          allowed: false,
          action: EDIT_BUILT_IN_ACTION,
          reason: edit.reason,
          message: `Changing the role '${change.roleId}' needs the right '${EDIT_BUILT_IN_ACTION}'`
        };
      }
    }
    const superadmin = isSuperadmin(actor);
    if (change.grants === undefined) return { allowed: true };
    const before =
      change.roleId === undefined
        ? []
        : ((await currentRoleGrants(this.rights(), change.roleId)) ?? []);
    const { added, removed } = grantChanges(before, change.grants);
    const listed = [...added, ...removed].find((grant) => isSuperadminGrantedAction(grant.action));
    if (listed && !superadmin) {
      return superadminOnly(
        operation,
        `Only a superadmin gives or takes the right '${listed.action}', also through a role`
      );
    }
    // Lifting a deny gives back what it refused, so it asks what an allow asks.
    const gives = [...added, ...removed.filter((grant) => grant.effect === "deny")];
    return authorizeHeldRightsWithin(
      this.rights(),
      access,
      await rightsOfGrants(this.rights(), gives),
      {
        gives: {
          label: change.roleId === undefined ? "the new role" : `the role '${change.roleId}'`
        }
      }
    );
  }

  async create(
    operation: string,
    context: RoleWriteContext,
    command: { name: string; description?: string; grants: readonly RoleGrant[] }
  ): Promise<RoleView> {
    const created = await this.whileRightsHeld(context, async (held, now) => {
      requireAuthorized(await held.authorizeWrite(now.actor, now.access, operation, command));
      requireCustomRoleName(command.name);
      return held.options.stores.roles.saveRole({
        clientInstanceId: this.options.clientInstanceId,
        id: createPlatformId("role"),
        name: command.name,
        ...(command.description ? { description: command.description } : {}),
        builtIn: false,
        grants: await held.validGrants(command.grants),
        pendingActions: [],
        grantedBy: asUserId(now.actor.id)
      });
    });
    await this.record(context, "role.created", created, [], created.grants);
    return this.view(created);
  }

  async update(
    operation: string,
    context: RoleWriteContext,
    roleId: string,
    command: { name?: string; description?: string | null; grants?: readonly RoleGrant[] }
  ): Promise<RoleView> {
    const { before, after } = await this.whileRightsHeld(context, async (held, now) => {
      requireAuthorized(
        await held.authorizeWrite(now.actor, now.access, operation, { roleId, ...command })
      );
      const existing = await held.findOrThrow(roleId);
      if (existing.builtIn && (command.name !== undefined || command.description !== undefined)) {
        throw refused("role_not_renamable", "A built-in role keeps its name and description");
      }
      if (command.name !== undefined) requireCustomRoleName(command.name);
      const { description: kept, ...unchanged } = existing;
      const description = command.description === undefined ? kept : command.description;
      const saved = await held.options.stores.roles.saveRole({
        ...unchanged,
        name: command.name ?? existing.name,
        ...(description ? { description } : {}),
        grants:
          command.grants === undefined ? existing.grants : await held.validGrants(command.grants),
        grantedBy: asUserId(now.actor.id)
      });
      return { before: existing, after: saved };
    });
    const { added, removed } = grantChanges(before.grants, after.grants);
    await this.record(context, "role.updated", after, removed, added);
    return this.view(after);
  }

  async delete(operation: string, context: RoleWriteContext, roleId: string): Promise<RoleView> {
    const deleted = await this.whileRightsHeld(context, async (held, now) => {
      const existing = await held.findOrThrow(roleId);
      requireAuthorized(
        await held.authorizeWrite(now.actor, now.access, operation, { roleId, grants: [] })
      );
      if (isBuiltInRole(roleId)) {
        throw refused("role_not_deletable", "A built-in role is never deleted; reset it instead");
      }
      const removed = await held.options.stores.roles.deleteRole({
        clientInstanceId: this.options.clientInstanceId,
        roleId
      });
      return removed ?? existing;
    });
    await this.record(context, "role.deleted", deleted, deleted.grants, []);
    return this.view(deleted);
  }

  /** `user` or `admin` back to the release's default, its pending actions settled with it. */
  async reset(operation: string, context: RoleWriteContext, roleId: string): Promise<RoleView> {
    if (!isEditableBuiltInRole(roleId)) {
      throw refused("role_not_resettable", "Only the built-in roles 'user' and 'admin' are reset");
    }
    const before = await this.whileRightsHeld(context, async (held, now) => {
      // A reset writes the release's default: every allow it adds and every deny it lifts asks
      // what an edit to the same grants asks, so a reset gives back nothing its caller lacks.
      requireAuthorized(
        await held.authorizeWrite(now.actor, now.access, operation, {
          roleId,
          grants: defaultRoleGrants(roleId)
        })
      );
      const existing = await held.findOrThrow(roleId);
      await held.options.stores.roles.deleteRole({
        clientInstanceId: this.options.clientInstanceId,
        roleId
      });
      return existing;
    });
    const reset = this.unstored(roleId);
    const { added, removed } = grantChanges(before.grants, reset.grants);
    await this.record(context, "role.reset", reset, removed, added);
    return this.view(reset);
  }

  /** Applies or dismisses one action a release changed in the default of an edited role. */
  async decidePending(
    operation: string,
    context: RoleWriteContext,
    roleId: string,
    command: { action: string; decision: RolePendingDecision }
  ): Promise<RoleView> {
    const { decided, saved } = await this.whileRightsHeld(context, async (held, now) => {
      requireAuthorized(await held.authorizeWrite(now.actor, now.access, operation, { roleId }));
      const existing = await held.findOrThrow(roleId);
      const pending = existing.pendingActions.find((entry) => entry.action === command.action);
      if (!pending)
        throw new AppError("NOT_FOUND", `'${command.action}' is not pending for this role`);
      const onInstance = (grant: RoleGrant) =>
        grant.action === command.action && grant.scopeKind === "instance";
      const instanceAllow: RoleGrant = {
        action: command.action,
        effect: "allow",
        scopeKind: "instance"
      };
      // An added action becomes the role's allow on the instance, in place of a refusal of it.
      // A removed one takes only that allow away: a deny someone wrote on purpose stays.
      const grants =
        command.decision === "dismiss"
          ? existing.grants
          : pending.change === "added"
            ? [...existing.grants.filter((grant) => !onInstance(grant)), instanceAllow]
            : existing.grants.filter((grant) => !(onInstance(grant) && grant.effect === "allow"));
      // Applying writes these grants: the allow it adds, and a refusal of the action it lifts,
      // ask what an edit to the same grants asks.
      if (grants !== existing.grants) {
        requireAuthorized(
          await held.authorizeWrite(now.actor, now.access, operation, { roleId, grants })
        );
      }
      return {
        decided: pending,
        saved: await held.options.stores.roles.saveRole({
          ...existing,
          grants,
          pendingActions: existing.pendingActions.filter((entry) => entry !== pending),
          grantedBy: asUserId(now.actor.id)
        })
      };
    });
    await context.audit.record({
      type: "role.pending_decided",
      status: "success",
      actor: auditActorFromIdentity(context.actor),
      subject: roleId,
      correlationId: context.correlationId,
      metadata: {
        roleId,
        action: decided.action,
        change: decided.change,
        decision: command.decision
      }
    });
    return this.view(saved);
  }

  /**
   * Each grant names a known action other than `assets.release`, which no role holds, at a scope
   * it can be held at: any action on the whole instance, and on one workspace or one asset the
   * actions a person can be granted there and `app.use`, on a Shared Workspace or an active
   * asset of its kind.
   */
  private async validGrants(grants: readonly RoleGrant[]): Promise<RoleGrant[]> {
    const seen = new Set<string>();
    const valid: RoleGrant[] = [];
    for (const grant of grants) {
      const { action, scopeKind, scopeId } = grant;
      if (!isPlatformAction(action))
        throw refused("unknown_action", `'${action}' is not an action`);
      if (action === "assets.release") {
        throw refused(
          "action_not_grantable",
          "'assets.release' is held by service principals only"
        );
      }
      if (scopeKind === "instance") {
        if (scopeId !== undefined)
          throw refused("invalid_scope", "An instance-wide grant names no scope id");
      } else {
        if (!isRoleGrantableAt(action, scopeKind)) {
          throw refused(
            "invalid_scope",
            `'${action}' cannot be held at the scope kind '${scopeKind}'`
          );
        }
        await this.requireScope(grant);
      }
      const key = JSON.stringify([action, scopeKind, scopeId ?? ""]);
      if (seen.has(key))
        throw refused("duplicate_grant", `'${action}' is listed twice at one scope`);
      seen.add(key);
      valid.push({
        action,
        effect: grant.effect,
        scopeKind,
        ...(scopeId === undefined ? {} : { scopeId })
      });
    }
    return valid;
  }

  private async requireScope(grant: RoleGrant): Promise<void> {
    if (grant.scopeKind === "asset") {
      await grantableAsset(this.options, grant);
      return;
    }
    const workspace =
      grant.scopeId === undefined
        ? undefined
        : await this.options.stores.workspaces.getWorkspace(
            this.options.clientInstanceId,
            asCollaborationWorkspaceId(grant.scopeId)
          );
    if (workspace?.kind !== "shared") {
      throw refused("invalid_scope", "The workspace is not a Shared Workspace of this instance");
    }
  }

  private async findOrThrow(roleId: string): Promise<RoleRecord> {
    const stored = await this.options.stores.roles.getRole({
      clientInstanceId: this.options.clientInstanceId,
      roleId
    });
    if (stored) return stored;
    if (isBuiltInRole(roleId)) return this.unstored(roleId);
    throw new AppError("NOT_FOUND", "Role not found");
  }

  private unstored(roleId: BuiltInRole): RoleRecord {
    return unstoredBuiltInRole(this.options.clientInstanceId, roleId);
  }

  private view(role: RoleRecord): RoleView {
    if (role.id === "superadmin") return { ...role, editable: false };
    if (!isEditableBuiltInRole(role.id) || !role.builtIn) return { ...role, editable: true };
    const defaultGrants = defaultRoleGrants(role.id);
    const { added, removed } = grantChanges(defaultGrants, role.grants);
    return {
      ...role,
      editable: true,
      defaultGrants,
      equalsDefault: added.length === 0 && removed.length === 0
    };
  }

  private rights(): RoleRightsOptions {
    return {
      clientInstanceId: this.options.clientInstanceId,
      access: this.options.stores.access,
      roles: this.options.stores.roles
    };
  }

  /** `withRightsHeld` for a role write: the workflow on the transaction's stores. */
  private whileRightsHeld<Result>(
    context: RoleWriteContext,
    change: (
      held: RoleWorkflow,
      now: { actor: AuthenticatedUser; access: ActorAccess }
    ) => Promise<Result>
  ): Promise<Result> {
    const actor = context.actor;
    if (isAuthenticatedServicePrincipal(actor)) {
      throw new AppError("FORBIDDEN", "A service principal writes no role");
    }
    return withRightsHeld(
      this.options,
      { actor, access: context.access },
      ({ options, actor, access }) => change(new RoleWorkflow(options), { actor, access })
    );
  }

  /** The actor, the role, and the grants removed and added with action and scope. */
  private async record(
    context: RoleWriteContext,
    type: string,
    role: RoleRecord,
    removed: readonly RoleGrant[],
    added: readonly RoleGrant[]
  ): Promise<void> {
    const metadata: JsonObject = {
      roleId: role.id,
      name: role.name,
      builtIn: role.builtIn,
      added: added.map(grantMetadata),
      removed: removed.map(grantMetadata)
    };
    await context.audit.record({
      type,
      status: "success",
      actor: auditActorFromIdentity(context.actor),
      subject: role.id,
      correlationId: context.correlationId,
      metadata
    });
  }
}

/** The grants `after` has and `before` lacks, and the reverse, compared by every field. */
function grantChanges(
  before: readonly RoleGrant[],
  after: readonly RoleGrant[]
): { added: RoleGrant[]; removed: RoleGrant[] } {
  const key = (grant: RoleGrant) =>
    JSON.stringify([grant.action, grant.effect, grant.scopeKind, grant.scopeId ?? ""]);
  const beforeKeys = new Set(before.map(key));
  const afterKeys = new Set(after.map(key));
  return {
    added: after.filter((grant) => !beforeKeys.has(key(grant))),
    removed: before.filter((grant) => !afterKeys.has(key(grant)))
  };
}

/** A custom role never takes the name of a built-in one, in any case. */
function requireCustomRoleName(name: string): void {
  if (isBuiltInRole(name.trim().toLowerCase())) {
    throw new AppError("CONFLICT", `'${name}' is the name of a built-in role`, {
      reason: "role_name_taken"
    });
  }
}

function superadminOnly(operation: string, message: string): OperationAuthorization {
  return { allowed: false, action: operation, reason: "no_grant", message };
}

function grantMetadata(grant: RoleGrant): JsonObject {
  return {
    action: grant.action,
    effect: grant.effect,
    scopeKind: grant.scopeKind,
    ...(grant.scopeId === undefined ? {} : { scopeId: grant.scopeId })
  };
}
