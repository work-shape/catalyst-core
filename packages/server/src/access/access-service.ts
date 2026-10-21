import {
  AppError,
  asUserId,
  evaluateAccess,
  auditActorFromUser,
  isAuthenticatedServicePrincipal,
  isGrantableAction,
  isGrantableAt,
  isLegacyKeyAction,
  isPlatformAction,
  isSuperadmin,
  listAccessEntries,
  moduleOffError,
  PRINCIPAL_HOLDER_KINDS,
  requireAuthScope,
  userInDeletionError,
  type AccessEntry,
  type AccessHolder,
  type ActorAccess,
  type AuthenticatedIdentity,
  type AuthenticatedUser,
  type CollaborationWorkspace,
  type CollaborationWorkspaceId,
  type GrantScopeAsset,
  type HeldRight,
  type JsonObject,
  type OperationAuthorization,
  type PersistedAccess,
  type OperationExecutionContext,
  type PermissionGrant,
  type StorePage,
  type UserRecord
} from "@work-shape/catalyst-core";
import type { ChatServerOptions } from "../types";
import { SERVICE_PRINCIPALS_ACTION } from "./api-access-administration-service";
import {
  authorizePrincipalHolderWrite,
  holderNotAdministrable,
  mayManageHolder,
  ownRowRefusal,
  requireAuthorized,
  requireManageableHolder,
  seesPrincipals
} from "./grant-holder-rules";
import { authorizeHeldRightsWithin } from "./held-rights-within";
import { buildLimitLists, type BuildLimitListsCommand } from "./build-limit-lists";
import { rightAtScope, scopeAssets } from "./person-rights";
import { assetRight, type PrincipalRightsOptions } from "./principal-rights";
import {
  checkPrincipalGrant,
  findAdministrablePrincipal,
  grantableAsset,
  kindOfAction,
  refused
} from "./principal-grant";
import { withRightsHeld } from "./rights-held";
import {
  decideAssetActions,
  decideHeldRights,
  nameRoles,
  namePlaces,
  type Deciding,
  type PlaceNames
} from "./effective-rights";
import { READ_RUN_DATA_ACTION, authorizeRunDataGrant } from "./run-data-grant";

type AccessCallContext = Pick<OperationExecutionContext, "correlationId">;
/**
 * A grant write asks again what its `authorize` asked, under the rights locks and with the
 * caller's rights and the holder read anew (`withRightsHeld`), so the write refuses by itself,
 * whoever calls it, and nothing changes what it read before it commits.
 */
type GrantWriteContext = Pick<OperationExecutionContext, "correlationId" | "access">;
/** The call as a write sees it under the rights locks. */
type HeldGrantCall = GrantWriteContext & { actor: AuthenticatedUser };

/**
 * Administration of people requires this right. Principal rows use `SERVICE_PRINCIPALS_ACTION`.
 */
const MANAGE_ACTION = "users.manage";
/** What a credential carries to read service principals. */
const API_ACCESS_READ_SCOPE = "api_access:read";
const GRANT_OPERATION = "permissions.grant";
const REVOKE_OPERATION = "permissions.revoke";

export interface GrantViewContext {
  hiddenUserIds: ReadonlySet<string>;
  scopeAssets: ReadonlyMap<string, GrantScopeAsset>;
}

/** The holder a read of rights names. */
type HolderInput = { holderKind: (typeof PRINCIPAL_HOLDER_KINDS)[number]; holderId: string };

interface GrantCommand {
  holderKind: PermissionGrant["holderKind"];
  holderId: string;
  action: string;
  scopeKind: PermissionGrant["scopeKind"];
  scopeId?: string;
  effect: PermissionGrant["effect"];
}

/**
 * Grants as an instance administrator writes them. The right itself, `users.manage`, guards
 * reads of other people and the build limits of a workspace. The two grant
 * writes check it themselves for a user's row, with the rule that a superadmin's rows are a
 * superadmin's alone. What is written is narrower than what the table holds. For a user: the
 * actions of `GRANTABLE_ACTION_SCOPES`, each at its scope kinds. For a service principal, under
 * five limits: who writes the row (who administers service principals, and never a service
 * principal), what it gives (a use right of `PRINCIPAL_GRANTABLE_ACTIONS` that a kind of the
 * instance registers, and that the writer holds there), where (one named asset) and the
 * effect (allow).
 */
export class AccessWorkflow {
  constructor(private readonly options: ChatServerOptions) {}

  /**
   * Who may write a grant row for the holder the call names. A holder that does not exist
   * passes: the write answers that itself.
   */
  async authorizeGrant(
    actor: AuthenticatedIdentity,
    access: ActorAccess,
    operation: string,
    command: Pick<GrantCommand, "holderKind" | "holderId">
  ): Promise<OperationAuthorization> {
    if (isAuthenticatedServicePrincipal(actor)) {
      return holderNotAdministrable(operation, "A service principal writes no grant row");
    }
    if (command.holderKind === "service_principal") {
      return authorizePrincipalHolderWrite(actor, access, operation);
    }
    const right = access.authorize(MANAGE_ACTION);
    if (!right.allowed) {
      return { allowed: false, action: MANAGE_ACTION, reason: right.reason };
    }
    if (command.holderKind !== "user") return { allowed: true };
    if (command.holderId === actor.id) return ownRowRefusal(operation);
    return this.authorizeUserHolderWrite(actor, operation, command.holderId);
  }

  /**
   * Who may remove the grant row the call names. A row that does not exist passes, and so
   * does a service principal's row for a caller who is not shown service principals: the
   * write answers both the same, so the id of such a row cannot be told from an absent one.
   */
  async authorizeRevoke(
    actor: AuthenticatedIdentity,
    access: ActorAccess,
    operation: string,
    grantId: string
  ): Promise<OperationAuthorization> {
    // A service principal writes no grant row, whatever it holds: it is refused before any
    // right of its own is read, so no principal removes a row of itself or of another.
    if (isAuthenticatedServicePrincipal(actor)) {
      return holderNotAdministrable(operation, "A service principal writes no grant row");
    }
    // A caller who holds neither right that removes a row causes no read.
    const right = access.authorize(MANAGE_ACTION);
    if (!right.allowed && !access.authorize(SERVICE_PRINCIPALS_ACTION).allowed) {
      return { allowed: false, action: MANAGE_ACTION, reason: right.reason };
    }
    const existing = await this.options.stores.access.getGrant({
      clientInstanceId: this.options.clientInstanceId,
      grantId
    });
    if (existing?.holderKind === "service_principal") {
      return seesPrincipals(actor, access)
        ? authorizePrincipalHolderWrite(actor, access, operation)
        : { allowed: true };
    }
    if (existing?.holderKind !== "user") return { allowed: true };
    return right.allowed
      ? this.authorizeUserHolderWrite(actor, operation, existing.holderId)
      : { allowed: false, action: MANAGE_ACTION, reason: right.reason };
  }

  /**
   * A refusal for a superadmin's row names the operation, because no right a caller can be
   * granted opens it. A user that does not exist passes: the write answers that itself.
   */
  private async authorizeUserHolderWrite(
    actor: AuthenticatedUser,
    operation: string,
    holderId: string
  ): Promise<OperationAuthorization> {
    const holder = await this.findUser(holderId);
    return holder && !mayManageHolder(actor, holder)
      ? { allowed: false, action: operation, reason: "no_grant" }
      : { allowed: true };
  }

  async grant(
    actor: AuthenticatedUser,
    context: GrantWriteContext,
    command: GrantCommand
  ): Promise<PermissionGrant> {
    const userId = command.holderKind === "user" ? command.holderId : undefined;
    const grant = await this.whileRightsHeld(actor, context, userId, async (held, now) => {
      requireAuthorized(await held.authorizeGrant(now.actor, now.access, GRANT_OPERATION, command));
      return command.holderKind === "service_principal"
        ? held.grantToPrincipal(now.actor, now, command)
        : held.grantToUser(now.actor, now, command);
    });
    await this.record(actor, context, "permission.granted", grant.id, grantAuditMetadata(grant));
    return grant;
  }

  private async grantToUser(
    actor: AuthenticatedUser,
    context: GrantWriteContext,
    command: GrantCommand
  ): Promise<PermissionGrant> {
    if (command.holderKind !== "user") {
      throw refused(
        "invalid_scope",
        command.holderKind === "role"
          ? "A role's grants are changed on the role (roles.update)"
          : "A grant can be written for a user or a service principal only"
      );
    }
    if (!isPlatformAction(command.action)) {
      throw refused("unknown_action", `'${command.action}' is not an action`);
    }
    if (!isGrantableAction(command.action)) {
      throw refused("action_not_grantable", `'${command.action}' cannot be granted`);
    }
    // The action carries its kind. A kind of a module that is off has no rights to hand out.
    const module = this.options.modules.offModuleOf("kind", kindOfAction(command.action));
    if (module !== undefined) {
      throw moduleOffError(module);
    }
    if (!isGrantableAt(command.action, command.scopeKind)) {
      throw refused(
        "invalid_scope",
        `'${command.action}' cannot be granted at the scope kind '${command.scopeKind}'`
      );
    }
    const { scope, right } = await this.grantScope(command);
    const holder = await this.findUser(command.holderId);
    if (!holder) {
      throw new AppError("NOT_FOUND", "User not found", { reason: "unknown_holder" });
    }
    // Asked before the policy by `authorizeGrant`, and again here on the holder as it is now.
    requireManageableHolder(actor, holder);
    if (holder.id === actor.id) requireAuthorized(ownRowRefusal(GRANT_OPERATION));
    // The rule of no escalation, for an allow and a deny alike: a deny is written only by a
    // holder of what it refuses, as an allow is given only by one.
    requireAuthorized(
      await authorizeHeldRightsWithin(this.rightsOptions(), context.access, [right], {
        gives: { label: holder.displayLabel }
      })
    );
    if (command.effect === "allow") await this.requireRunDataLendable(context, right);
    // The store refuses the same for a deletion requested after this read.
    if (holder.status === "deleting") throw userInDeletionError();
    return this.options.stores.access.createGrant({
      clientInstanceId: this.options.clientInstanceId,
      holderKind: "user",
      holderId: holder.id,
      action: command.action,
      effect: command.effect,
      ...scope,
      grantedBy: asUserId(actor.id)
    });
  }

  /**
   * A service principal's row, under the limits `checkPrincipalGrant` names. Who is asked
   * before the policy by `authorizeGrant`, and again there.
   */
  private async grantToPrincipal(
    actor: AuthenticatedUser,
    context: GrantWriteContext,
    command: GrantCommand
  ): Promise<PermissionGrant> {
    const { principal, asset } = await checkPrincipalGrant(
      this.options,
      { actor, access: context.access },
      GRANT_OPERATION,
      command,
      () => this.grantableAsset(command)
    );
    // The store refuses the same for a principal deleted after this read.
    return this.options.stores.access.createGrant({
      clientInstanceId: this.options.clientInstanceId,
      holderKind: "service_principal",
      holderId: principal.id,
      action: command.action,
      effect: "allow",
      scopeKind: "asset",
      scopeId: asset.id,
      grantedBy: asUserId(actor.id)
    });
  }

  async revoke(
    actor: AuthenticatedUser,
    context: GrantWriteContext,
    grantId: string
  ): Promise<PermissionGrant> {
    // Read before the locks only to name the user they hold; read again under them.
    const named = await this.options.stores.access.getGrant({
      clientInstanceId: this.options.clientInstanceId,
      grantId
    });
    const userId = named?.holderKind === "user" ? named.holderId : undefined;
    const revoked = await this.whileRightsHeld(actor, context, userId, async (held, now) => {
      requireAuthorized(
        await held.authorizeRevoke(now.actor, now.access, REVOKE_OPERATION, grantId)
      );
      return held.revokeNow(now.actor, now, grantId);
    });
    await this.record(
      actor,
      context,
      "permission.revoked",
      revoked.id,
      grantAuditMetadata(revoked)
    );
    return revoked;
  }

  private async revokeNow(
    actor: AuthenticatedUser,
    context: GrantWriteContext,
    grantId: string
  ): Promise<PermissionGrant> {
    const existing = await this.options.stores.access.getGrant({
      clientInstanceId: this.options.clientInstanceId,
      grantId
    });
    if (!existing) {
      throw new AppError("NOT_FOUND", "Grant not found");
    }
    if (existing.holderKind === "role") {
      throw refused("invalid_scope", "A role's grants are changed on the role (roles.update)");
    }
    if (existing.holderKind === "user") {
      const holder = await this.findUser(existing.holderId);
      if (holder) {
        requireManageableHolder(actor, holder);
        if (existing.effect === "deny")
          await this.requireMayLiftDeny(actor, context, existing, holder);
      }
    }
    if (existing.holderKind === "service_principal") {
      // The list does not show the row to this caller, so neither does a refusal.
      if (
        !seesPrincipals(actor, context.access) ||
        !(await findAdministrablePrincipal(this.options, existing.holderId))
      ) {
        throw new AppError("NOT_FOUND", "Grant not found");
      }
      requireAuthorized(authorizePrincipalHolderWrite(actor, context.access, REVOKE_OPERATION));
    }
    if (existing.scopeKind === "instance" && isLegacyKeyAction(existing.action)) {
      throw refused(
        "invalid_scope",
        "A right a legacy key carries is changed on the page of the user or the service principal"
      );
    }
    const revoked = await this.options.stores.access.deleteGrant({
      clientInstanceId: this.options.clientInstanceId,
      grantId
    });
    if (!revoked) {
      throw new AppError("NOT_FOUND", "Grant not found");
    }
    return revoked;
  }

  /** `withRightsHeld` for a grant write: the workflow on the transaction's stores. */
  private whileRightsHeld<Result>(
    actor: AuthenticatedUser,
    context: GrantWriteContext,
    userId: string | undefined,
    change: (held: AccessWorkflow, now: HeldGrantCall) => Promise<Result>
  ): Promise<Result> {
    return withRightsHeld(
      this.options,
      { actor, access: context.access, ...(userId === undefined ? {} : { userId }) },
      ({ options, actor: current, access }) =>
        change(new AccessWorkflow(options), {
          correlationId: context.correlationId,
          access,
          actor: current
        })
    );
  }

  /**
   * The user list hides superadmins from everyone else, and so do the rows they hold. The
   * list of service principals is behind `service_principals.manage` and the scope of reading
   * API access, and so are the rows they hold.
   */
  listGrants(
    actor: AuthenticatedUser,
    access: ActorAccess,
    filter: {
      holderKind?: PermissionGrant["holderKind"];
      holderId?: string;
      action?: string;
      scopeKind?: PermissionGrant["scopeKind"];
      scopeId?: string;
      page?: StorePage;
    }
  ): Promise<PermissionGrant[]> {
    // Without user administration, only an explicitly principal-scoped list is readable.
    if (!access.authorize(MANAGE_ACTION).allowed && filter.holderKind === "service_principal") {
      access.require(SERVICE_PRINCIPALS_ACTION);
      requireAuthScope(actor, API_ACCESS_READ_SCOPE);
    } else {
      access.require(MANAGE_ACTION);
    }
    return this.options.stores.access.listGrants({
      clientInstanceId: this.options.clientInstanceId,
      ...filter,
      excludeSuperadminHolders: !isSuperadmin(actor),
      excludeServicePrincipalHolders: !seesPrincipals(actor, access),
      excludeOwnedPrincipalHolders: true,
      // An instance-wide right a legacy key carries is shown and changed as the legacy list on
      // the Users and API access screens, under their rules, until AP-5b shows rows one by one.
      excludeLegacyKeyRows: true
    });
  }

  /** What the four sources say about one holder. It reads the same entries the evaluator reads. */
  async effective(
    actor: AuthenticatedUser,
    access: ActorAccess,
    input: HolderInput
  ): Promise<{ holderActive: boolean; items: AccessEntry[] }> {
    const { holderActive, entries } = await this.holderEntries(actor, access, input);
    return { holderActive, items: entries };
  }

  /**
   * What one holder holds and is refused, each right decided on the server with where it
   * comes from: the role, a grant or a membership that gives it, and the deny that refuses it.
   * The read of `effective`, under its rule.
   */
  async rights(actor: AuthenticatedUser, access: ActorAccess, input: HolderInput) {
    const held = await this.holderEntries(actor, access, input);
    const { holderActive, entries } = held;
    const deciding = await this.deciding(held);
    const places = await namePlaces(this.namingOptions(), { actor, access }, [
      ...entries,
      ...deciding.workspacePlaces
    ]);
    const decided = decideHeldRights(entries, holderActive, places.factsOf, deciding);
    const origin = (entry: AccessEntry) => originView(entry, places.placeOf(entry));
    return {
      holderActive,
      roles: await nameRoles(
        this.namingOptions(),
        decided.flatMap((right) => [...right.grantedBy, right.deniedBy])
      ),
      rights: decided.map(({ grantedBy, deniedBy, onlyIn, ...right }) => ({
        ...right,
        ...places.placeOf(right),
        ...conditionsView(onlyIn, places.placeOf),
        grantedBy: grantedBy.map(origin),
        ...(deniedBy === undefined ? {} : { deniedBy: origin(deniedBy) })
      }))
    };
  }

  /**
   * What one holder may do with one asset of a kind, per right the kind names, decided on the
   * server by the evaluator with the entry that decides it, and with the App's availability.
   * An id of another kind, or of no asset of this instance, names no asset: then only what
   * holds on every asset of the kind decides. The read of `effective`, under its rule.
   */
  async check(
    actor: AuthenticatedUser,
    access: ActorAccess,
    input: HolderInput & { kind: string; assetId?: string }
  ) {
    const kind = this.options.configAssets.kinds.get(input.kind);
    if (!kind) {
      throw new AppError("NOT_FOUND", "Asset kind not found", { reason: "unknown_kind" });
    }
    const held = await this.holderEntries(actor, access, input);
    const { holderActive, entries } = held;
    const deciding = await this.deciding(held);
    const places = await namePlaces(this.namingOptions(), { actor, access }, [
      ...entries,
      ...(input.assetId === undefined
        ? []
        : [{ scopeKind: "asset" as const, scopeId: input.assetId }]),
      ...deciding.workspacePlaces
    ]);
    const asset = input.assetId === undefined ? undefined : places.assets.get(input.assetId);
    const facts = asset?.kind === kind.kind ? places.factsOf(asset.id) : undefined;
    const resource = {
      kind: kind.kind,
      ...(asset === undefined || facts === undefined
        ? {}
        : { assetId: asset.id, name: asset.name, ...facts })
    };
    const decided = decideAssetActions(entries, holderActive, kind.actions, resource, deciding);
    const deciders = decided.flatMap((action) => action.decidedBy ?? []);
    return {
      holderActive,
      roles: await nameRoles(this.namingOptions(), deciders),
      actions: decided.map(({ decidedBy, onlyIn, ...action }) => ({
        ...action,
        ...conditionsView(onlyIn, places.placeOf),
        ...(decidedBy === undefined
          ? {}
          : { decidedBy: originView(decidedBy, places.placeOf(decidedBy)) })
      }))
    };
  }

  /**
   * The holder's evaluator over the access just loaded, and the workspaces in which an asset's
   * availability gives the holder its use. The load without a workspace counts availability
   * through every membership; a call is decided narrowed to its workspace, so each membership
   * is loaded narrowed once to say where such a use holds.
   */
  private async deciding(held: {
    holder: AccessHolder;
    persisted: PersistedAccess;
  }): Promise<Deciding & { workspacePlaces: { scopeKind: "workspace"; scopeId: string }[] }> {
    const { holder, persisted } = held;
    const availableIn = new Map<string, string[]>();
    if ((persisted.availableAssets ?? []).length > 0) {
      const memberships = [...(persisted.memberWorkspaceIds ?? [])].sort();
      const narrowed = await Promise.all(
        memberships.map(async (workspaceId) => ({
          workspaceId,
          access: await this.options.stores.access.loadPersistedAccess({
            clientInstanceId: this.options.clientInstanceId,
            holder: { kind: holder.kind, id: holder.id },
            workspaceId
          })
        }))
      );
      for (const { workspaceId, access } of narrowed) {
        for (const { assetId } of access.availableAssets ?? []) {
          availableIn.set(assetId, [...(availableIn.get(assetId) ?? []), workspaceId]);
        }
      }
    }
    return {
      evaluate: (action, resource) =>
        evaluateAccess({ holder, persisted, action, ...(resource ? { resource } : {}) }),
      availableIn: (assetId) => availableIn.get(assetId) ?? [],
      workspacePlaces: [...new Set([...availableIn.values()].flat())].map((scopeId) => ({
        scopeKind: "workspace",
        scopeId
      }))
    };
  }

  /**
   * One holder's entries, for a caller allowed to read them: a person always reads their own,
   * and other people remain behind user administration.
   */
  private async holderEntries(
    actor: AuthenticatedUser,
    access: ActorAccess,
    input: HolderInput
  ): Promise<{
    holder: AccessHolder;
    persisted: PersistedAccess;
    holderActive: boolean;
    entries: AccessEntry[];
  }> {
    if (input.holderKind === "user" && input.holderId !== actor.id) {
      access.require(MANAGE_ACTION);
    }
    const holder = await this.findHolder(actor, access, input);
    const persisted = await this.options.stores.access.loadPersistedAccess({
      clientInstanceId: this.options.clientInstanceId,
      holder: { kind: holder.kind, id: holder.id }
    });
    // A membership is a source of rights on what a workspace owns. It is listed where a kind
    // of this instance names such a right, and left out where none does.
    const kindActions = new Set<string>(
      this.options.configAssets.kinds.kinds.flatMap((kind) => Object.values(kind.actions))
    );
    return {
      holder,
      persisted,
      holderActive: persisted.holderActive,
      entries: listAccessEntries(holder, persisted).filter(
        (entry) => entry.source !== "membership" || kindActions.has(entry.action)
      )
    };
  }

  private namingOptions() {
    return {
      clientInstanceId: this.options.clientInstanceId,
      stores: this.options.stores,
      kinds: this.options.configAssets.kinds
    };
  }

  /** The Shared Workspaces with their build limits, as Instance > Workspaces lists them. */
  async listWorkspaceLimits(): Promise<CollaborationWorkspace[]> {
    const workspaces = await this.options.stores.workspaces.listSharedWorkspaces({
      clientInstanceId: this.options.clientInstanceId
    });
    return workspaces.toSorted((left, right) => left.name.localeCompare(right.name));
  }

  /**
   * Sets the build limits of a Shared Workspace: what the agents it owns may use, checked at
   * every write of one of them (`asset-write-rules.ts`). A Personal Workspace has none.
   */
  async updateWorkspaceLimits(
    actor: AuthenticatedUser,
    context: AccessCallContext,
    command: { collaborationWorkspaceId: CollaborationWorkspaceId } & BuildLimitListsCommand
  ): Promise<CollaborationWorkspace> {
    const lists = buildLimitLists(this.options.configAssets.validationRefs, command);
    const workspace = await this.options.stores.workspaces.updateWorkspace({
      clientInstanceId: this.options.clientInstanceId,
      collaborationWorkspaceId: command.collaborationWorkspaceId,
      ...lists
    });
    await this.record(actor, context, "collaboration_workspace.updated", workspace.id, {
      changedFields: Object.keys(lists),
      restrictsTools: workspace.allowedToolNames !== undefined,
      restrictsModels: workspace.allowedModelBindingIds !== undefined
    });
    return workspace;
  }

  /** Where a person's row is written, with the right it gives there as the rule asks it. */
  private async grantScope(command: GrantCommand): Promise<{
    scope: Pick<PermissionGrant, "scopeKind" | "scopeId">;
    right: HeldRight;
  }> {
    const { action } = command;
    if (command.scopeKind === "asset") {
      const asset = await this.grantableAsset(command);
      return { scope: { scopeKind: "asset", scopeId: asset.id }, right: assetRight(action, asset) };
    }
    if (command.scopeKind === "instance") {
      if (command.scopeId !== undefined) {
        throw refused("invalid_scope", "An instance-wide grant names no scope id");
      }
      return { scope: { scopeKind: "instance" }, right: { action } };
    }
    if (command.scopeKind === "workspace") {
      if (command.scopeId === undefined) {
        throw refused("invalid_scope", "A workspace grant names a workspace id");
      }
      // The store refuses a workspace that is not a Shared Workspace of this instance, under
      // the lock that keeps a row from appearing while the workspace is deleted.
      return {
        scope: { scopeKind: "workspace", scopeId: command.scopeId },
        right: { action, resource: { workspaceId: command.scopeId } }
      };
    }
    throw refused(
      "invalid_scope",
      "A grant can be written for one asset, one workspace or the instance only"
    );
  }

  /**
   * Reading the data of a Workflow's runs lends what its principal reads, so giving it, or
   * lifting a deny of it, asks every right of the principal as well (D4).
   */
  private async requireRunDataLendable(context: GrantWriteContext, right: HeldRight) {
    if (right.action !== READ_RUN_DATA_ACTION || right.resource?.name === undefined) return;
    requireAuthorized(
      await authorizeRunDataGrant(
        {
          ...this.rightsOptions(),
          apiAccess: this.options.stores.apiAccess,
          configAssets: this.options.configAssets.store
        },
        context.access,
        right.resource.name
      )
    );
  }

  /**
   * Removing a person's deny gives back what it refused, so it asks what giving asks: never
   * one's own, and only by a holder of the action where the row refuses it.
   */
  private async requireMayLiftDeny(
    actor: AuthenticatedUser,
    context: GrantWriteContext,
    row: PermissionGrant,
    holder: UserRecord
  ): Promise<void> {
    if (holder.id === actor.id) requireAuthorized(ownRowRefusal(REVOKE_OPERATION));
    const assets = await scopeAssets(this.rightsOptions(), [row]);
    const right = rightAtScope(row, assets);
    requireAuthorized(
      await authorizeHeldRightsWithin(this.rightsOptions(), context.access, [right], {
        gives: { label: holder.displayLabel }
      })
    );
    await this.requireRunDataLendable(context, right);
  }

  /** The active asset of the action's kind an asset grant names. */
  private async grantableAsset(command: GrantCommand): Promise<Omit<GrantScopeAsset, "active">> {
    return grantableAsset(this.options, command);
  }

  private async findHolder(
    actor: AuthenticatedUser,
    access: ActorAccess,
    input: HolderInput
  ): Promise<AccessHolder> {
    if (input.holderKind === "user") {
      const user = await this.findUser(input.holderId);
      // The user list hides superadmins from everyone else, and so does this.
      if (!user || (isSuperadmin(user) && !isSuperadmin(actor))) {
        throw new AppError("NOT_FOUND", "User not found", { reason: "unknown_holder" });
      }
      return {
        kind: "user",
        id: user.id,
        clientInstanceId: user.clientInstanceId,
        roles: user.roles,
        permissionRefs: user.permissionRefs
      };
    }
    // Service principals are read behind `service_principals.manage` and the scope of reading
    // API access: the rule of the list of grant rows, so this says nothing the list hides.
    access.require(SERVICE_PRINCIPALS_ACTION);
    requireAuthScope(actor, API_ACCESS_READ_SCOPE);
    const principal = await findAdministrablePrincipal(this.options, input.holderId);
    if (!principal) {
      throw new AppError("NOT_FOUND", "Service principal not found", {
        reason: "unknown_holder"
      });
    }
    return {
      kind: "service_principal",
      id: principal.id,
      clientInstanceId: principal.clientInstanceId,
      roles: [],
      permissionRefs: principal.permissionRefs
    };
  }

  /**
   * The users whose ids the caller is not shown: the user list hides superadmins from everyone
   * else, and so does the attribution of a grant.
   */
  async hiddenUserIds(actor: AuthenticatedUser): Promise<ReadonlySet<string>> {
    if (isSuperadmin(actor)) {
      return new Set();
    }
    const users = await this.options.stores.users.listUsers({
      clientInstanceId: this.options.clientInstanceId
    });
    return new Set(users.filter((user) => isSuperadmin(user)).map((user) => String(user.id)));
  }

  /**
   * What grant rows are shown with: the users the caller is not shown, and the assets behind
   * the asset scopes of these rows.
   */
  async grantViewContext(
    actor: AuthenticatedUser,
    grants: readonly PermissionGrant[]
  ): Promise<GrantViewContext> {
    const assetIds = grants
      .filter((grant) => grant.scopeKind === "asset" && grant.scopeId !== undefined)
      .map((grant) => grant.scopeId ?? "");
    const [hiddenUserIds, assets] = await Promise.all([
      this.hiddenUserIds(actor),
      this.options.stores.access.listGrantScopeAssets({
        clientInstanceId: this.options.clientInstanceId,
        assetIds
      })
    ]);
    return { hiddenUserIds, scopeAssets: new Map(assets.map((asset) => [asset.id, asset])) };
  }

  private rightsOptions(): PrincipalRightsOptions {
    return { clientInstanceId: this.options.clientInstanceId, access: this.options.stores.access };
  }

  private async findUser(userId: string): Promise<UserRecord | undefined> {
    const users = await this.options.stores.users.listUsers({
      clientInstanceId: this.options.clientInstanceId
    });
    return users.find((candidate) => candidate.id === userId);
  }

  private async record(
    actor: AuthenticatedUser,
    context: AccessCallContext,
    type: string,
    subject: string,
    metadata: JsonObject
  ): Promise<void> {
    await this.options.auditRecorder.record({
      type,
      status: "success",
      actor: auditActorFromUser(actor),
      subject,
      correlationId: context.correlationId,
      metadata
    });
  }
}

/** An entry as an origin of a right: what it gives or refuses, at its named place. */
/** The workspaces a right holds in only, named as the caller may read them. */
function conditionsView(
  onlyIn: readonly string[] | undefined,
  placeOf: (place: { scopeKind: "workspace"; scopeId: string }) => PlaceNames
) {
  if (onlyIn === undefined) return {};
  return {
    onlyInWorkspaces: onlyIn.flatMap(
      (scopeId) => placeOf({ scopeKind: "workspace", scopeId }).scopeWorkspace ?? []
    )
  };
}

function originView(entry: AccessEntry, place: PlaceNames) {
  const { action: _action, ...origin } = entry;
  return { ...origin, ...place };
}

/**
 * Holder kind and id, action and scope; for a service principal's row the principal under the
 * key its other audit events carry, and the asset as the scope id. No name of another user
 * leaves through the audit log.
 */
function grantAuditMetadata(grant: PermissionGrant): JsonObject {
  return {
    grantId: grant.id,
    holderKind: grant.holderKind,
    holderId: grant.holderId,
    ...(grant.holderKind === "service_principal" ? { servicePrincipalId: grant.holderId } : {}),
    action: grant.action,
    effect: grant.effect,
    scopeKind: grant.scopeKind,
    ...(grant.scopeId === undefined ? {} : { scopeId: grant.scopeId })
  };
}
