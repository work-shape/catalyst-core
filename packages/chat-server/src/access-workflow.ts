import {
  AppError,
  userInDeletionError,
  asUserId,
  auditActorFromUser,
  hasAuthScope,
  requireAuthScope,
  isAuthenticatedServicePrincipal,
  isGrantableAction,
  isGrantableAt,
  isPlatformAction,
  isPrincipalGrantableAction,
  moduleOffError,
  isSuperadmin,
  listAccessEntries,
  operationDenialError,
  type AccessEntry,
  type AccessHolder,
  type ActorAccess,
  type AuthenticatedIdentity,
  type AuthenticatedUser,
  type OperationAuthorization,
  type OperationExecutionContext,
  type GrantScopeAsset,
  type JsonObject,
  type Namespace,
  type NamespaceUsage,
  type PermissionGrant,
  type ServicePrincipalRecord,
  type StorePage,
  type UserRecord
} from "@vivd-catalyst/core";
import {
  SERVICE_PRINCIPALS_ACTION,
  authorizePrincipalAdministration
} from "./api-access-administration-workflow";
import { assetRight, authorizeGivingToPrincipal } from "./principal-rights";
import type { ChatServerOptions } from "./types";

type AccessCallContext = Pick<OperationExecutionContext, "correlationId">;
/**
 * A grant write asks again what its `authorize` asked, of the same answer on the caller's
 * rights: `access` is the call's one snapshot and is not read anew. What is read anew is the
 * holder. The check is repeated so the write refuses by itself, whoever calls it.
 */
type GrantWriteContext = Pick<OperationExecutionContext, "correlationId" | "access">;

/**
 * Administration of people requires this right. Principal rows use `SERVICE_PRINCIPALS_ACTION`.
 */
const MANAGE_ACTION = "users.manage";
/** What a credential carries to change, and to read, service principals. */
const API_ACCESS_WRITE_SCOPE = "api_access:write";
const API_ACCESS_READ_SCOPE = "api_access:read";
const GRANT_OPERATION = "permissions.grant";
const REVOKE_OPERATION = "permissions.revoke";

export interface GrantViewContext {
  hiddenUserIds: ReadonlySet<string>;
  scopeAssets: ReadonlyMap<string, GrantScopeAsset>;
}

interface GrantCommand {
  holderKind: PermissionGrant["holderKind"];
  holderId: string;
  action: string;
  scopeKind: PermissionGrant["scopeKind"];
  scopeId?: string;
  namespace?: string;
  effect: PermissionGrant["effect"];
}

interface NamespaceListsCommand {
  allowedToolNames?: string[] | null;
  allowedModelBindingIds?: string[] | null;
}

/**
 * Grants and Namespaces as an instance administrator writes them. The right itself,
 * `users.manage`, guards reads of other people and the Namespace writes. The two grant
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
    return command.holderKind === "user"
      ? this.authorizeUserHolderWrite(actor, operation, command.holderId)
      : { allowed: true };
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
    if (command.holderKind === "service_principal") {
      return this.grantToPrincipal(actor, context, command);
    }
    if (command.holderKind !== "user") {
      throw refused(
        "invalid_scope",
        "A grant can be written for a user or a service principal only"
      );
    }
    if (!isPlatformAction(command.action)) {
      throw refused("unknown_action", `'${command.action}' is not an action`);
    }
    if (!isGrantableAction(command.action)) {
      throw refused(
        "action_not_grantable",
        `'${command.action}' cannot be granted in a Namespace or on one asset`
      );
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
    const scope = await this.grantScope(command);
    const holder = await this.findUser(command.holderId);
    if (!holder) {
      throw new AppError("NOT_FOUND", "User not found", { reason: "unknown_holder" });
    }
    // Asked before the policy by `authorizeGrant`, and again here on the holder as it is now.
    requireManageableHolder(actor, holder);
    // The store refuses the same for a deletion requested after this read.
    if (holder.status === "deleting") throw userInDeletionError();
    const grant = await this.options.stores.access.createGrant({
      clientInstanceId: this.options.clientInstanceId,
      holderKind: "user",
      holderId: holder.id,
      action: command.action,
      effect: command.effect,
      ...scope,
      grantedBy: asUserId(actor.id)
    });
    await this.record(actor, context, "permission.granted", grant.id, grantAuditMetadata(grant));
    return grant;
  }

  /**
   * The four limits of a service principal's row, each refused by name. Who: asked before the
   * policy by `authorizeGrant`, and again here. What: a use right of the one list in `core`
   * that a kind of this instance registers; a right of the list whose kind this instance has
   * not loaded is refused like one outside the list, so no row waits for a kind to arrive.
   * Effect: allow. Where: one named asset of the right's kind, so nothing created later is
   * reachable by a principal that was not given it. And the writer holds the right there: the
   * rule of no escalation, asked last, of the asset as it is now.
   */
  private async grantToPrincipal(
    actor: AuthenticatedUser,
    context: GrantWriteContext,
    command: GrantCommand
  ): Promise<PermissionGrant> {
    requireAuthorized(authorizePrincipalHolderWrite(actor, context.access, GRANT_OPERATION));
    const { action } = command;
    if (!isPrincipalGrantableAction(action)) {
      throw refused(
        "action_not_grantable_to_principal",
        `'${action}' cannot be granted to a service principal: a service principal is granted the use rights of a resource and nothing else`
      );
    }
    const module = this.options.modules.offModuleOf("kind", kindOfAction(action));
    if (module !== undefined) {
      throw moduleOffError(module);
    }
    const kind = this.options.configAssets.kinds.get(kindOfAction(action));
    if (!kind || !Object.values(kind.actions).some((right) => right === action)) {
      throw refused(
        "action_not_grantable_to_principal",
        `'${action}' cannot be granted on this instance: no asset kind it has loaded registers the right`
      );
    }
    if (command.effect !== "allow") {
      throw refused(
        "effect_not_grantable_to_principal",
        "A service principal is allowed a right and never denied one: revoke the grant instead"
      );
    }
    if (command.scopeKind !== "asset") {
      throw refused(
        "invalid_scope",
        "A service principal is granted a right on one named asset only"
      );
    }
    const asset = await this.grantableAsset(command);
    const principal = await this.findPrincipal(command.holderId);
    if (!principal) {
      throw new AppError("NOT_FOUND", "Service principal not found", {
        reason: "unknown_holder"
      });
    }
    requireAuthorized(
      authorizeGivingToPrincipal({ actor, access: context.access }, principal, [
        assetRight(action, asset)
      ])
    );
    // The store refuses the same for a principal deleted after this read.
    const grant = await this.options.stores.access.createGrant({
      clientInstanceId: this.options.clientInstanceId,
      holderKind: "service_principal",
      holderId: principal.id,
      action,
      effect: "allow",
      scopeKind: "asset",
      scopeId: asset.id,
      grantedBy: asUserId(actor.id)
    });
    await this.record(actor, context, "permission.granted", grant.id, grantAuditMetadata(grant));
    return grant;
  }

  async revoke(
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
    if (existing.holderKind === "user") {
      const holder = await this.findUser(existing.holderId);
      if (holder) {
        requireManageableHolder(actor, holder);
      }
    }
    if (existing.holderKind === "service_principal") {
      // The list does not show the row to this caller, so neither does a refusal.
      if (!seesPrincipals(actor, context.access)) {
        throw new AppError("NOT_FOUND", "Grant not found");
      }
      requireAuthorized(authorizePrincipalHolderWrite(actor, context.access, REVOKE_OPERATION));
    }
    if (existing.scopeKind === "instance") {
      throw refused(
        "invalid_scope",
        "An instance-wide right is changed on the page of the user or the service principal"
      );
    }
    const revoked = await this.options.stores.access.deleteGrant({
      clientInstanceId: this.options.clientInstanceId,
      grantId
    });
    if (!revoked) {
      throw new AppError("NOT_FOUND", "Grant not found");
    }
    await this.record(
      actor,
      context,
      "permission.revoked",
      revoked.id,
      grantAuditMetadata(revoked)
    );
    return revoked;
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
      // An instance-wide right is shown and changed as the legacy list on the Users and API
      // access screens, under their rules, until the User page shows rows one by one.
      excludeInstanceScope: true
    });
  }

  /** What the four sources say about one holder. It reads the same entries the evaluator reads. */
  async effective(
    actor: AuthenticatedUser,
    access: ActorAccess,
    input: { holderKind: "user" | "service_principal"; holderId: string }
  ): Promise<{ holderActive: boolean; items: AccessEntry[] }> {
    // A person always reads their own rights. Other people remain behind user administration.
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
      holderActive: persisted.holderActive,
      items: listAccessEntries(holder, persisted).filter(
        (entry) => entry.source !== "membership" || kindActions.has(entry.action)
      )
    };
  }

  async createNamespace(
    actor: AuthenticatedUser,
    context: AccessCallContext,
    command: { prefix: string; displayName: string } & NamespaceListsCommand
  ): Promise<Namespace> {
    const lists = this.namespaceLists(command);
    const namespace = await this.options.stores.access.createNamespace({
      clientInstanceId: this.options.clientInstanceId,
      prefix: command.prefix,
      displayName: command.displayName,
      ...(lists.allowedToolNames ? { allowedToolNames: lists.allowedToolNames } : {}),
      ...(lists.allowedModelBindingIds
        ? { allowedModelBindingIds: lists.allowedModelBindingIds }
        : {}),
      createdBy: asUserId(actor.id)
    });
    await this.record(
      actor,
      context,
      "namespace.created",
      namespace.prefix,
      namespaceAuditMetadata(namespace)
    );
    return namespace;
  }

  async updateNamespace(
    actor: AuthenticatedUser,
    context: AccessCallContext,
    command: { prefix: string; displayName?: string } & NamespaceListsCommand
  ): Promise<Namespace> {
    const namespace = await this.options.stores.access.updateNamespace({
      clientInstanceId: this.options.clientInstanceId,
      prefix: command.prefix,
      ...(command.displayName === undefined ? {} : { displayName: command.displayName }),
      ...this.namespaceLists(command)
    });
    if (!namespace) {
      throw new AppError("NOT_FOUND", "Namespace not found");
    }
    await this.record(
      actor,
      context,
      "namespace.updated",
      namespace.prefix,
      namespaceAuditMetadata(namespace)
    );
    return namespace;
  }

  listNamespaces(): Promise<NamespaceUsage[]> {
    return this.options.stores.access.listNamespaces({
      clientInstanceId: this.options.clientInstanceId
    });
  }

  async deleteNamespace(
    actor: AuthenticatedUser,
    context: AccessCallContext,
    prefix: string
  ): Promise<Namespace> {
    const namespace = await this.options.stores.access.deleteNamespace({
      clientInstanceId: this.options.clientInstanceId,
      prefix
    });
    if (!namespace) {
      throw new AppError("NOT_FOUND", "Namespace not found");
    }
    await this.record(
      actor,
      context,
      "namespace.deleted",
      namespace.prefix,
      namespaceAuditMetadata(namespace)
    );
    return namespace;
  }

  private async grantScope(
    command: GrantCommand
  ): Promise<Pick<PermissionGrant, "scopeKind" | "scopeId" | "namespace">> {
    if (command.scopeKind === "namespace") {
      if (command.namespace === undefined || command.scopeId !== undefined) {
        throw refused("invalid_scope", "A Namespace grant names a prefix and no scope id");
      }
      return { scopeKind: "namespace", namespace: command.namespace };
    }
    if (command.scopeKind === "asset") {
      return { scopeKind: "asset", scopeId: (await this.grantableAsset(command)).id };
    }
    if (command.scopeKind === "workspace") {
      if (command.scopeId === undefined || command.namespace !== undefined) {
        throw refused("invalid_scope", "A workspace grant names a workspace id and no Namespace");
      }
      // The store refuses a workspace that is not a Shared Workspace of this instance, under
      // the lock that keeps a row from appearing while the workspace is deleted.
      return { scopeKind: "workspace", scopeId: command.scopeId };
    }
    throw refused(
      "invalid_scope",
      "A grant can be written for a Namespace, one asset or one workspace only"
    );
  }

  /** The active asset of the action's kind an asset grant names. */
  private async grantableAsset(command: GrantCommand): Promise<Omit<GrantScopeAsset, "active">> {
    if (command.scopeId === undefined || command.namespace !== undefined) {
      throw refused("invalid_scope", "An asset grant names an asset id and no Namespace");
    }
    const asset = await this.options.stores.access.getGrantableAsset({
      clientInstanceId: this.options.clientInstanceId,
      assetId: command.scopeId
    });
    // The action carries the kind, so a skill action on an agent could never match.
    if (!asset || asset.kind !== kindOfAction(command.action)) {
      throw refused("invalid_scope", "The asset is not an active asset of the action's kind");
    }
    return asset;
  }

  /** An entry of a list must exist on this instance: an enabled tool, a known model binding. */
  private namespaceLists(command: NamespaceListsCommand): NamespaceListsCommand {
    const refs = this.options.configAssets.validationRefs;
    const unknownTool = command.allowedToolNames?.find(
      (name) => !refs.enabledToolNames.includes(name)
    );
    if (unknownTool !== undefined) {
      throw new AppError("VALIDATION_FAILED", `'${unknownTool}' is not an enabled tool`, {
        reason: "unknown_tool",
        toolName: unknownTool
      });
    }
    const unknownBinding = command.allowedModelBindingIds?.find(
      (id) => !refs.modelBindingIds.includes(id)
    );
    if (unknownBinding !== undefined) {
      throw new AppError("VALIDATION_FAILED", `'${unknownBinding}' is not a model binding`, {
        reason: "unknown_model_binding",
        modelBindingId: unknownBinding
      });
    }
    return {
      ...(command.allowedToolNames === undefined
        ? {}
        : { allowedToolNames: unique(command.allowedToolNames) }),
      ...(command.allowedModelBindingIds === undefined
        ? {}
        : { allowedModelBindingIds: unique(command.allowedModelBindingIds) })
    };
  }

  private async findHolder(
    actor: AuthenticatedUser,
    access: ActorAccess,
    input: { holderKind: "user" | "service_principal"; holderId: string }
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
    const principal = await this.findPrincipal(input.holderId);
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
   * else, and so does the attribution of a grant or a Namespace.
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

  private async findUser(userId: string): Promise<UserRecord | undefined> {
    const users = await this.options.stores.users.listUsers({
      clientInstanceId: this.options.clientInstanceId
    });
    return users.find((candidate) => candidate.id === userId);
  }

  private async findPrincipal(
    servicePrincipalId: string
  ): Promise<ServicePrincipalRecord | undefined> {
    const principals = await this.options.stores.apiAccess.listServicePrincipals({
      clientInstanceId: this.options.clientInstanceId
    });
    return principals.find((candidate) => candidate.id === servicePrincipalId);
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

/** The asset kind an action is a right of: `agent` of `agent.read`. */
function kindOfAction(action: string): string {
  return action.slice(0, action.indexOf("."));
}

function refused(reason: string, message: string): AppError {
  return new AppError("VALIDATION_FAILED", message, { reason });
}

/**
 * No right is missing that the caller could be given, so the refusal names the operation and
 * its text says who writes the row.
 */
function holderNotAdministrable(operation: string, message: string): OperationAuthorization {
  return { allowed: false, action: operation, reason: "holder_not_administrable", message };
}

/** Whom the list of service principals is shown to, and so the rows they hold. */
function seesPrincipals(actor: AuthenticatedUser, access: ActorAccess): boolean {
  return (
    access.authorize(SERVICE_PRINCIPALS_ACTION).allowed &&
    hasAuthScope(actor, API_ACCESS_READ_SCOPE)
  );
}

/**
 * Who writes a service principal's grant row: whoever administers service principals, by that
 * one check and no second rule. The credential is asked what the operations that administer
 * principals ask of it, so a key issued for managing users writes no row for a principal.
 */
function authorizePrincipalHolderWrite(
  actor: AuthenticatedUser,
  access: ActorAccess,
  operation: string
): OperationAuthorization {
  const administration = authorizePrincipalAdministration({ actor, access }, operation);
  if (!administration.allowed) {
    return administration;
  }
  return hasAuthScope(actor, API_ACCESS_WRITE_SCOPE)
    ? { allowed: true }
    : {
        allowed: false,
        // The right is held. What is missing is a scope of the credential, and it is named.
        action: `auth_scope:${API_ACCESS_WRITE_SCOPE}`,
        reason: "no_grant",
        message: `Missing auth scope '${API_ACCESS_WRITE_SCOPE}'`
      };
}

function requireAuthorized(authorization: OperationAuthorization): void {
  if (!authorization.allowed) {
    throw operationDenialError({
      kind: "forbidden",
      action: authorization.action,
      reason: authorization.reason,
      ...(authorization.message === undefined ? {} : { message: authorization.message })
    });
  }
}

/** A caller who is not a superadmin writes no row for a holder who is one. */
function mayManageHolder(actor: AuthenticatedUser, holder: UserRecord): boolean {
  return !isSuperadmin(holder) || isSuperadmin(actor);
}

function requireManageableHolder(actor: AuthenticatedUser, holder: UserRecord): void {
  if (!mayManageHolder(actor, holder)) {
    throw new AppError("FORBIDDEN", "Only superadmins can manage superadmin users");
  }
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
    ...(grant.scopeId === undefined ? {} : { scopeId: grant.scopeId }),
    ...(grant.namespace === undefined ? {} : { namespace: grant.namespace })
  };
}

/** The prefix and whether each list restricts. The lists themselves stay out of the log. */
function namespaceAuditMetadata(namespace: Namespace): JsonObject {
  return {
    prefix: namespace.prefix,
    restrictsTools: namespace.allowedToolNames !== undefined,
    restrictsModels: namespace.allowedModelBindingIds !== undefined
  };
}

function unique(values: string[] | null): string[] | null {
  return values === null ? null : [...new Set(values)];
}
