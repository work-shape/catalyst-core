import {
  AppError,
  asUserId,
  auditActorFromUser,
  isGrantableAction,
  isPlatformAction,
  isSuperadmin,
  listAccessEntries,
  type AccessEntry,
  type AccessHolder,
  type ActorAccess,
  type AuthenticatedUser,
  type JsonObject,
  type Namespace,
  type NamespaceUsage,
  type PermissionGrant,
  type RuntimeCallContext,
  type StorePage,
  type UserRecord
} from "@vivd-catalyst/core";
import type { ChatServerOptions } from "./types";

type AccessCallContext = Pick<RuntimeCallContext, "correlationId">;

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
 * `users.manage`, is every operation's `requires`. What this slice writes is narrower than what
 * the table holds: a user as holder, read, write and delete on agents and skills, a Namespace
 * or one asset as scope.
 */
export class AccessWorkflow {
  constructor(private readonly options: ChatServerOptions) {}

  async grant(
    actor: AuthenticatedUser,
    context: AccessCallContext,
    command: GrantCommand
  ): Promise<PermissionGrant> {
    if (command.holderKind !== "user") {
      throw refused("invalid_scope", "A grant can be written for a user only");
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
    const scope = await this.grantScope(command);
    const holder = await this.findUser(command.holderId);
    if (!holder) {
      throw new AppError("NOT_FOUND", "User not found", { reason: "unknown_holder" });
    }
    requireManageableHolder(actor, holder);
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

  async revoke(
    actor: AuthenticatedUser,
    context: AccessCallContext,
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

  /** The user list hides superadmins from everyone else, and so do the rows they hold. */
  listGrants(
    actor: AuthenticatedUser,
    filter: {
      holderKind?: PermissionGrant["holderKind"];
      holderId?: string;
      action?: string;
      scopeKind?: PermissionGrant["scopeKind"];
      page?: StorePage;
    }
  ): Promise<PermissionGrant[]> {
    return this.options.stores.access.listGrants({
      clientInstanceId: this.options.clientInstanceId,
      ...filter,
      excludeSuperadminHolders: !isSuperadmin(actor)
    });
  }

  /** What the four sources say about one holder. It reads the same entries the evaluator reads. */
  async effective(
    actor: AuthenticatedUser,
    access: ActorAccess,
    input: { holderKind: "user" | "service_principal"; holderId: string }
  ): Promise<{ holderActive: boolean; items: AccessEntry[] }> {
    const holder = await this.findHolder(actor, access, input);
    const persisted = await this.options.stores.access.loadPersistedAccess({
      clientInstanceId: this.options.clientInstanceId,
      holder: { kind: holder.kind, id: holder.id }
    });
    return { holderActive: persisted.holderActive, items: listAccessEntries(holder, persisted) };
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
      if (command.scopeId === undefined || command.namespace !== undefined) {
        throw refused("invalid_scope", "An asset grant names an asset id and no Namespace");
      }
      const asset = await this.options.stores.access.getGrantableAsset({
        clientInstanceId: this.options.clientInstanceId,
        assetId: command.scopeId
      });
      // The action carries the kind, so a skill action on an agent could never match.
      if (!asset || !command.action.startsWith(`${asset.kind}.`)) {
        throw refused("invalid_scope", "The asset is not an active asset of the action's kind");
      }
      return { scopeKind: "asset", scopeId: asset.id };
    }
    throw refused("invalid_scope", "A grant can be written for a Namespace or one asset only");
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
        permissions: user.permissions,
        permissionRefs: user.permissionRefs
      };
    }
    // Service principals are administered behind `api_access.manage`.
    access.require("api_access.manage");
    const principals = await this.options.stores.apiAccess.listServicePrincipals({
      clientInstanceId: this.options.clientInstanceId
    });
    const principal = principals.find((candidate) => candidate.id === input.holderId);
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
      permissions: principal.permissions,
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

function refused(reason: string, message: string): AppError {
  return new AppError("VALIDATION_FAILED", message, { reason });
}

/** A caller who is not a superadmin writes no row for a holder who is one. */
function requireManageableHolder(actor: AuthenticatedUser, holder: UserRecord): void {
  if (isSuperadmin(holder) && !isSuperadmin(actor)) {
    throw new AppError("FORBIDDEN", "Only superadmins can manage superadmin users");
  }
}

/** Holder id, action and scope. No name of another user leaves through the audit log. */
function grantAuditMetadata(grant: PermissionGrant): JsonObject {
  return {
    grantId: grant.id,
    holderKind: grant.holderKind,
    holderId: grant.holderId,
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
