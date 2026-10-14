import type { StorePage } from "@vivd-catalyst/core";
import { randomBytes } from "node:crypto";
import { STANDALONE_AUTH_SOURCE } from "@vivd-catalyst/auth";
import {
  AppError,
  isSuperadmin,
  asUserId,
  unknownLegacyEntries,
  auditActorFromIdentity,
  auditActorFromUser,
  isAuthenticatedServicePrincipal,
  type AuthenticatedIdentity,
  type OperationExecutionContext,
  type AuthenticatedUser,
  type RuntimeCallContext,
  type UserId,
  type UserRecord,
  userInDeletionError,
  type UserRole,
  type UserStatus
} from "@vivd-catalyst/core";
import { requestAccountDeletion } from "./account-deletion";
import type { ChatServerOptions } from "./types";
import { recordGovernanceAccess } from "./governance-actions";
import { createPasswordSetupLink, PLATFORM_INVITATION_VALID_DAYS } from "./password-setup-workflow";
import type { DeletionOutcome } from "./subject-deletion";
import { changedPermissionEntries, requireMayAdministerUser } from "./user-administration-rights";

/** What a changing user administration operation takes from its Operation Run. */
type ChangeContext = Pick<OperationExecutionContext, "actor" | "audit" | "correlationId">;

interface CreateUserCommand {
  displayLabel: string;
  email?: string;
  roles?: UserRole[];
  permissionRefs?: string[];
  permissions?: string[];
  status?: UserStatus;
  passwordSignIn?: {
    password: string;
  };
}

interface UpdateUserCommand {
  userId: UserId;
  displayLabel?: string;
  email?: string | null;
  roles?: UserRole[];
  permissionRefs?: string[];
  permissions?: string[];
  status?: UserStatus;
}

interface UpsertUserIdentityCommand {
  userId: UserId;
  authSource: string;
  externalUserId: string;
  displayLabel?: string;
  email?: string;
  emailVerified?: boolean;
}

interface DeleteUserIdentityCommand {
  userId: UserId;
  authSource: string;
  externalUserId: string;
}

interface DeleteUserCommand {
  userId: UserId;
}

interface SendUserInvitationCommand {
  userId: UserId;
}

interface ResetUserPasswordCommand {
  userId: UserId;
  password: string;
}

export class UserAdministrationWorkflow {
  constructor(private readonly options: ChatServerOptions) {}

  async listUsers(
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    page?: StorePage
  ): Promise<UserRecord[]> {
    await this.recordAccess(user, context, "governance.users_viewed");
    const users = await this.options.stores.users.listUsers({
      clientInstanceId: this.options.clientInstanceId,
      page,
      excludeSuperadmins: !isSuperadmin(user)
    });
    if (isSuperadmin(user)) {
      return users;
    }
    return users.filter((candidate) => !isSuperadmin(candidate));
  }

  async createUser(
    operationId: string,
    context: ChangeContext,
    command: CreateUserCommand
  ): Promise<UserRecord> {
    const actor = personOf(context.actor);
    requireMayAdministerUser(operationId, actor, undefined, {
      roles: command.roles,
      permissions: command.permissions
    });
    this.requireAssignablePermissions(command.permissions);
    if (command.passwordSignIn && !command.email) {
      throw new AppError("VALIDATION_FAILED", "Email is required to create a password sign-in");
    }

    let created = await this.options.stores.users.createUser({
      clientInstanceId: this.options.clientInstanceId,
      displayLabel: command.displayLabel,
      email: command.email,
      roles: command.roles,
      permissionRefs: command.permissionRefs,
      permissions: command.permissions,
      grantedBy: asUserId(actor.id),
      status: command.status
    });
    await this.recordUserMutation(context, "user.created", created);
    if (command.passwordSignIn) {
      created = await this.setOrCreatePasswordSignIn(context, created, {
        password: command.passwordSignIn.password,
        auditType: "user.password_sign_in_created"
      });
    }
    return created;
  }

  async updateUser(
    operationId: string,
    context: ChangeContext,
    command: UpdateUserCommand
  ): Promise<UserRecord> {
    const actor = personOf(context.actor);
    const existing = await this.getUserOrThrow(command.userId);
    requireMayAdministerUser(operationId, actor, existing, {
      roles: command.roles,
      permissions: command.permissions
    });
    requireNotInDeletion(existing);
    this.requireAssignablePermissions(command.permissions, existing.permissions);
    const updated = await this.options.stores.users.updateUser({
      clientInstanceId: this.options.clientInstanceId,
      userId: command.userId,
      displayLabel: command.displayLabel,
      email: command.email,
      roles: command.roles,
      permissionRefs: command.permissionRefs,
      permissions: command.permissions,
      grantedBy: asUserId(actor.id),
      status: command.status
    });
    await this.recordUserMutation(context, "user.updated", updated);
    return updated;
  }

  async deleteUser(
    operationId: string,
    context: ChangeContext,
    command: DeleteUserCommand
  ): Promise<DeletionOutcome<UserRecord>> {
    const actor = personOf(context.actor);
    // The operation's `authorize` refused everybody else before. Asked again where it deletes.
    requireMayAdministerUser(operationId, actor, undefined, { superadminOnly: true });
    if (command.userId === actor.id) {
      throw new AppError("VALIDATION_FAILED", "Superadmins cannot delete their own user account");
    }

    const existing = await this.getUserOrThrow(command.userId);
    await this.requireAtLeastOneRemainingSuperadmin(existing);
    return requestAccountDeletion(this.options, {
      userId: command.userId,
      requestedBy: "admin",
      actor: auditActorFromUser(actor),
      actorUserId: asUserId(actor.id),
      correlationId: context.correlationId,
      alreadyRequested: existing.status === "deleting"
    });
  }

  async upsertIdentity(
    operationId: string,
    context: ChangeContext,
    command: UpsertUserIdentityCommand
  ): Promise<UserRecord> {
    const actor = personOf(context.actor);
    const existing = await this.getUserOrThrow(command.userId);
    requireMayAdministerUser(operationId, actor, existing);
    requireNotInDeletion(existing);
    const updated = await this.options.stores.users.upsertUserIdentity({
      clientInstanceId: this.options.clientInstanceId,
      userId: command.userId,
      authSource: command.authSource,
      externalUserId: command.externalUserId,
      displayLabel: command.displayLabel,
      email: command.email,
      emailVerified: command.emailVerified
    });
    const { audit: auditRecorder } = context;
    await auditRecorder.record({
      type: "user.identity_upserted",
      status: "success",
      actor: auditActorFromIdentity(context.actor),
      subject: updated.id,
      correlationId: context.correlationId,
      metadata: {
        authSource: command.authSource,
        externalUserId: command.externalUserId,
        emailVerified: command.emailVerified ?? false
      }
    });
    return updated;
  }

  async deleteIdentity(
    operationId: string,
    context: ChangeContext,
    command: DeleteUserIdentityCommand
  ): Promise<UserRecord> {
    const actor = personOf(context.actor);
    const existing = await this.getUserOrThrow(command.userId);
    requireMayAdministerUser(operationId, actor, existing);
    requireNotInDeletion(existing);
    const updated = await this.options.stores.users.deleteUserIdentity({
      clientInstanceId: this.options.clientInstanceId,
      userId: command.userId,
      authSource: command.authSource,
      externalUserId: command.externalUserId
    });
    const { audit: auditRecorder } = context;
    await auditRecorder.record({
      type: "user.identity_deleted",
      status: "success",
      actor: auditActorFromIdentity(context.actor),
      subject: updated.id,
      correlationId: context.correlationId,
      metadata: {
        authSource: command.authSource,
        externalUserId: command.externalUserId
      }
    });
    return updated;
  }

  /**
   * Sets a user's password. The password goes to the auth store, which keeps its own slow
   * hash, and nowhere else: no audit row, log line or answer names it. The operation is
   * registered as `secret` and marks the password in its hashed input, so the run keeps
   * neither an answer nor a hash of the password, and a repeated call sets nothing.
   */
  async resetPassword(
    operationId: string,
    context: ChangeContext,
    command: ResetUserPasswordCommand
  ): Promise<{ ok: true }> {
    const actor = personOf(context.actor);
    const setPassword = this.options.standaloneAuth?.setPassword;
    if (!setPassword) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Password reset requires standalone auth to be enabled for this client instance"
      );
    }
    const user = await this.getUserOrThrow(command.userId);
    requireMayAdministerUser(operationId, actor, user);
    requireNotInDeletion(user);
    const identity = user.identities.find(
      (candidate) => candidate.authSource === STANDALONE_AUTH_SOURCE
    );
    if (!identity) {
      await this.setOrCreatePasswordSignIn(context, user, {
        password: command.password,
        auditType: "user.password_sign_in_created"
      });
      return { ok: true };
    }
    await setPassword({
      externalUserId: identity.externalUserId,
      password: command.password
    });
    const { audit: auditRecorder } = context;
    await auditRecorder.record({
      type: "user.password_reset",
      status: "success",
      actor: auditActorFromIdentity(context.actor),
      subject: user.id,
      correlationId: context.correlationId,
      metadata: {
        authSource: identity.authSource
      }
    });
    return { ok: true };
  }

  /**
   * Emails a single-use link that lets the user set their own password. A user without a
   * password sign-in gets one with an unguessable placeholder password first; an existing
   * password keeps working until the link is used.
   */
  async sendInvitation(
    operationId: string,
    context: ChangeContext,
    command: SendUserInvitationCommand
  ): Promise<{ ok: true }> {
    const actor = personOf(context.actor);
    const { mail, standaloneAuth } = this.options;
    if (!mail || !standaloneAuth) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Invitations require mail and standalone auth to be enabled for this client instance"
      );
    }
    let user = await this.getUserOrThrow(command.userId);
    requireMayAdministerUser(operationId, actor, user);
    if (user.status !== "active") {
      throw new AppError("VALIDATION_FAILED", "Only active users can be invited");
    }
    if (!user.identities.some((identity) => identity.authSource === STANDALONE_AUTH_SOURCE)) {
      user = await this.setOrCreatePasswordSignIn(context, user, {
        password: randomBytes(32).toString("base64url"),
        auditType: "user.password_sign_in_created"
      });
    }
    const identity = user.identities.find(
      (candidate) => candidate.authSource === STANDALONE_AUTH_SOURCE
    );
    const email = identity?.email ?? user.email;
    if (!identity || !email) {
      throw new AppError("VALIDATION_FAILED", "Email is required to send an invitation");
    }
    if (user.email && user.email.trim().toLowerCase() !== email.trim().toLowerCase()) {
      // The password sign-in keeps the address it was created with; changing the user's email
      // does not move it, so the link would go to the old address.
      throw new AppError(
        "CONFLICT",
        "The user's email no longer matches the email of their password sign-in, so an invitation cannot be sent"
      );
    }

    const token = await standaloneAuth.createPasswordSetupToken({
      externalUserId: identity.externalUserId,
      ttlMs: PLATFORM_INVITATION_VALID_DAYS * 24 * 60 * 60 * 1000
    });
    const result = await mail.sender.send({
      template: "platform-invitation",
      to: { email, displayLabel: user.displayLabel },
      locale: this.options.config.localization.defaultLocale,
      params: {
        link: createPasswordSetupLink(mail.appUrl, token),
        validDays: PLATFORM_INVITATION_VALID_DAYS,
        inviterLabel: actor.displayLabel
      }
    });
    const { audit: auditRecorder } = context;
    await auditRecorder.record({
      type: "user.invitation_sent",
      status: result.ok ? "success" : "failed",
      actor: auditActorFromIdentity(context.actor),
      subject: user.id,
      correlationId: context.correlationId,
      metadata: {
        template: "platform-invitation",
        ...(result.ok ? {} : { reason: result.reason })
      }
    });
    if (!result.ok) {
      throw new AppError("INTERNAL", "The invitation email could not be sent", undefined, {
        exposeMessage: true
      });
    }
    return { ok: true };
  }

  private async setOrCreatePasswordSignIn(
    context: ChangeContext,
    user: UserRecord,
    input: {
      password: string;
      auditType: "user.password_sign_in_created" | "user.password_reset";
    }
  ): Promise<UserRecord> {
    const setOrCreatePasswordSignIn = this.options.standaloneAuth?.setOrCreatePasswordSignIn;
    if (!setOrCreatePasswordSignIn) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Password sign-in requires standalone auth to be enabled for this client instance"
      );
    }
    if (!user.email) {
      throw new AppError("VALIDATION_FAILED", "Email is required to create a password sign-in");
    }
    await this.requireAvailablePasswordEmail(user);

    const signIn = await setOrCreatePasswordSignIn({
      email: user.email,
      displayLabel: user.displayLabel,
      roles: user.roles,
      permissionRefs: user.permissionRefs,
      permissions: user.permissions,
      password: input.password
    });
    await this.requireAvailablePasswordIdentity(user, signIn.externalUserId);
    const updated = await this.options.stores.users.upsertUserIdentity({
      clientInstanceId: this.options.clientInstanceId,
      userId: user.id,
      authSource: STANDALONE_AUTH_SOURCE,
      externalUserId: signIn.externalUserId,
      displayLabel: signIn.displayLabel,
      email: signIn.email,
      emailVerified: signIn.emailVerified
    });
    const { audit: auditRecorder } = context;
    await auditRecorder.record({
      type: input.auditType,
      status: "success",
      actor: auditActorFromIdentity(context.actor),
      subject: user.id,
      correlationId: context.correlationId,
      metadata: {
        authSource: STANDALONE_AUTH_SOURCE
      }
    });
    return updated;
  }

  private async requireAvailablePasswordEmail(user: UserRecord): Promise<void> {
    const normalizedEmail = user.email?.trim().toLowerCase();
    if (!normalizedEmail) {
      return;
    }
    const users = await this.options.stores.users.listUsers({
      clientInstanceId: this.options.clientInstanceId
    });
    const conflict = users.find(
      (candidate) =>
        candidate.id !== user.id &&
        (candidate.email?.trim().toLowerCase() === normalizedEmail ||
          candidate.identities.some(
            (identity) =>
              identity.authSource === STANDALONE_AUTH_SOURCE &&
              identity.email?.trim().toLowerCase() === normalizedEmail
          ))
    );
    if (conflict) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Another user already uses this email, so a password sign-in would be ambiguous"
      );
    }
  }

  private async requireAvailablePasswordIdentity(
    user: UserRecord,
    externalUserId: string
  ): Promise<void> {
    const users = await this.options.stores.users.listUsers({
      clientInstanceId: this.options.clientInstanceId
    });
    const conflict = users.find(
      (candidate) =>
        candidate.id !== user.id &&
        candidate.identities.some(
          (identity) =>
            identity.authSource === STANDALONE_AUTH_SOURCE &&
            identity.externalUserId === externalUserId
        )
    );
    if (conflict) {
      throw new AppError(
        "VALIDATION_FAILED",
        "This password sign-in is already linked to another user"
      );
    }
  }

  private async getUserOrThrow(userId: UserId): Promise<UserRecord> {
    const users = await this.options.stores.users.listUsers({
      clientInstanceId: this.options.clientInstanceId
    });
    const user = users.find((candidate) => candidate.id === userId);
    if (!user) {
      throw new AppError("NOT_FOUND", "User not found");
    }
    return user;
  }

  private requireAssignablePermissions(
    permissions: readonly string[] | undefined,
    existingPermissions: readonly string[] = []
  ): void {
    // A list entry is a key or its revocation. Anything else held no right before and has no
    // row to be written as.
    const [unknown] = unknownLegacyEntries(permissions ?? []);
    if (unknown !== undefined) {
      throw new AppError("VALIDATION_FAILED", `'${unknown}' is not a permission`);
    }
    if (
      changedPermissionEntries(permissions, existingPermissions).includes("config_assets.release")
    ) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Release permission can only be carried by service tokens"
      );
    }
  }

  private async requireAtLeastOneRemainingSuperadmin(deletedUser: UserRecord): Promise<void> {
    if (!isSuperadmin(deletedUser)) {
      return;
    }
    const users = await this.options.stores.users.listUsers({
      clientInstanceId: this.options.clientInstanceId
    });
    const remainingActiveSuperadmin = users.some(
      (user) => user.id !== deletedUser.id && user.status === "active" && isSuperadmin(user)
    );
    if (!remainingActiveSuperadmin) {
      throw new AppError("VALIDATION_FAILED", "At least one active superadmin must remain");
    }
  }

  // The list is a plain read and records its access itself.
  private async recordAccess(
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    auditType: string
  ): Promise<void> {
    await recordGovernanceAccess({ options: this.options, user, context, auditType });
  }

  private async recordUserMutation(
    context: ChangeContext,
    type: string,
    user: UserRecord
  ): Promise<void> {
    const { audit: auditRecorder } = context;
    await auditRecorder.record({
      type,
      status: "success",
      actor: auditActorFromIdentity(context.actor),
      subject: user.id,
      correlationId: context.correlationId,
      metadata: {
        status: user.status,
        roles: user.roles,
        permissionRefs: user.permissionRefs,
        permissions: user.permissions
      }
    });
  }
}

/**
 * The early answer for a user whose deletion was requested. The store refuses the same in the
 * statement that writes, for a deletion requested after this check. Only the deletion can be
 * asked again.
 */
function requireNotInDeletion(user: UserRecord): void {
  if (user.status === "deleting") throw userInDeletionError();
}

function personOf(actor: AuthenticatedIdentity): AuthenticatedUser {
  if (isAuthenticatedServicePrincipal(actor)) {
    throw new AppError("FORBIDDEN", "Service principals cannot access user-scoped routes");
  }
  return actor;
}
