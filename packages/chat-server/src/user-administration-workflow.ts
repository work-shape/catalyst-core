import { STANDALONE_AUTH_SOURCE } from "@vivd-catalyst/auth";
import {
  AppError,
  auditActorFromUser,
  type AuthenticatedUser,
  type RuntimeCallContext,
  type UserId,
  type UserRecord,
  type UserRole,
  type UserStatus
} from "@vivd-catalyst/core";
import type { ChatServerOptions } from "./types";
import { authorizeGovernanceAction } from "./governance-actions";

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

interface ResetUserPasswordCommand {
  userId: UserId;
  password: string;
}

export class UserAdministrationWorkflow {
  constructor(private readonly options: ChatServerOptions) {}

  async listUsers(user: AuthenticatedUser, context: RuntimeCallContext): Promise<UserRecord[]> {
    await this.authorize(user, context, "governance.users_viewed");
    const users = await this.options.userStore.listUsers({
      clientInstanceId: this.options.clientInstanceId
    });
    if (this.isSuperadmin(user)) {
      return users;
    }
    return users.filter((candidate) => !candidate.roles.includes("superadmin"));
  }

  async createUser(
    actor: AuthenticatedUser,
    context: RuntimeCallContext,
    command: CreateUserCommand
  ): Promise<UserRecord> {
    await this.authorize(actor, context, "governance.user_create_authorized");
    this.requireAssignableRoles(actor, command.roles);
    if (command.passwordSignIn && !command.email) {
      throw new AppError("VALIDATION_FAILED", "Email is required to create a password sign-in");
    }

    let created = await this.options.userStore.createUser({
      clientInstanceId: this.options.clientInstanceId,
      displayLabel: command.displayLabel,
      email: command.email,
      roles: command.roles,
      permissionRefs: command.permissionRefs,
      permissions: command.permissions,
      status: command.status
    });
    await this.recordUserMutation(actor, context, "user.created", created);
    if (command.passwordSignIn) {
      created = await this.setOrCreatePasswordSignIn(actor, context, created, {
        password: command.passwordSignIn.password,
        auditType: "user.password_sign_in_created"
      });
    }
    return created;
  }

  async updateUser(
    actor: AuthenticatedUser,
    context: RuntimeCallContext,
    command: UpdateUserCommand
  ): Promise<UserRecord> {
    await this.authorize(actor, context, "governance.user_update_authorized");
    const existing = await this.getUserOrThrow(command.userId);
    this.requireManageableUser(actor, existing);
    this.requireAssignableRoles(actor, command.roles);
    const updated = await this.options.userStore.updateUser({
      clientInstanceId: this.options.clientInstanceId,
      userId: command.userId,
      displayLabel: command.displayLabel,
      email: command.email,
      roles: command.roles,
      permissionRefs: command.permissionRefs,
      permissions: command.permissions,
      status: command.status
    });
    await this.recordUserMutation(actor, context, "user.updated", updated);
    return updated;
  }

  async deleteUser(
    actor: AuthenticatedUser,
    context: RuntimeCallContext,
    command: DeleteUserCommand
  ): Promise<UserRecord> {
    if (!this.isSuperadmin(actor)) {
      throw new AppError("FORBIDDEN", "User deletion requires a superadmin role");
    }
    await authorizeGovernanceAction({
      options: this.options,
      user: actor,
      context,
      requiredPermission: "users.manage",
      auditType: "governance.user_delete_authorized",
      deniedMessage: "User deletion requires 'users.manage' permission"
    });
    if (command.userId === actor.id) {
      throw new AppError("VALIDATION_FAILED", "Superadmins cannot delete their own user account");
    }

    const existing = await this.getUserOrThrow(command.userId);
    await this.requireAtLeastOneRemainingSuperadmin(existing);
    await this.deleteStandalonePasswordSignIns(existing);
    const deleted = await this.options.userStore.deleteUser({
      clientInstanceId: this.options.clientInstanceId,
      userId: command.userId
    });
    await this.recordUserMutation(actor, context, "user.deleted", deleted);
    return deleted;
  }

  async upsertIdentity(
    actor: AuthenticatedUser,
    context: RuntimeCallContext,
    command: UpsertUserIdentityCommand
  ): Promise<UserRecord> {
    await this.authorize(actor, context, "governance.user_identity_upsert_authorized");
    const existing = await this.getUserOrThrow(command.userId);
    this.requireManageableUser(actor, existing);
    const updated = await this.options.userStore.upsertUserIdentity({
      clientInstanceId: this.options.clientInstanceId,
      userId: command.userId,
      authSource: command.authSource,
      externalUserId: command.externalUserId,
      displayLabel: command.displayLabel,
      email: command.email,
      emailVerified: command.emailVerified
    });
    await this.options.auditRecorder.record({
      type: "user.identity_upserted",
      status: "success",
      actor: auditActorFromUser(actor),
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
    actor: AuthenticatedUser,
    context: RuntimeCallContext,
    command: DeleteUserIdentityCommand
  ): Promise<UserRecord> {
    await this.authorize(actor, context, "governance.user_identity_delete_authorized");
    const existing = await this.getUserOrThrow(command.userId);
    this.requireManageableUser(actor, existing);
    const updated = await this.options.userStore.deleteUserIdentity({
      clientInstanceId: this.options.clientInstanceId,
      userId: command.userId,
      authSource: command.authSource,
      externalUserId: command.externalUserId
    });
    await this.options.auditRecorder.record({
      type: "user.identity_deleted",
      status: "success",
      actor: auditActorFromUser(actor),
      subject: updated.id,
      correlationId: context.correlationId,
      metadata: {
        authSource: command.authSource,
        externalUserId: command.externalUserId
      }
    });
    return updated;
  }

  async resetPassword(
    actor: AuthenticatedUser,
    context: RuntimeCallContext,
    command: ResetUserPasswordCommand
  ): Promise<{ ok: true }> {
    await this.authorize(actor, context, "governance.user_password_reset_authorized");
    const setPassword = this.options.standaloneAuth?.setPassword;
    if (!setPassword) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Password reset requires standalone auth to be enabled for this client instance"
      );
    }
    const user = await this.getUserOrThrow(command.userId);
    this.requireManageableUser(actor, user);
    const identity = user.identities.find(
      (candidate) => candidate.authSource === STANDALONE_AUTH_SOURCE
    );
    if (!identity) {
      await this.setOrCreatePasswordSignIn(actor, context, user, {
        password: command.password,
        auditType: "user.password_sign_in_created"
      });
      return { ok: true };
    }
    await setPassword({
      externalUserId: identity.externalUserId,
      password: command.password
    });
    await this.options.auditRecorder.record({
      type: "user.password_reset",
      status: "success",
      actor: auditActorFromUser(actor),
      subject: user.id,
      correlationId: context.correlationId,
      metadata: {
        authSource: identity.authSource
      }
    });
    return { ok: true };
  }

  private async setOrCreatePasswordSignIn(
    actor: AuthenticatedUser,
    context: RuntimeCallContext,
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
    const updated = await this.options.userStore.upsertUserIdentity({
      clientInstanceId: this.options.clientInstanceId,
      userId: user.id,
      authSource: STANDALONE_AUTH_SOURCE,
      externalUserId: signIn.externalUserId,
      displayLabel: signIn.displayLabel,
      email: signIn.email,
      emailVerified: signIn.emailVerified
    });
    await this.options.auditRecorder.record({
      type: input.auditType,
      status: "success",
      actor: auditActorFromUser(actor),
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
    const users = await this.options.userStore.listUsers({
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
    const users = await this.options.userStore.listUsers({
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
    const users = await this.options.userStore.listUsers({
      clientInstanceId: this.options.clientInstanceId
    });
    const user = users.find((candidate) => candidate.id === userId);
    if (!user) {
      throw new AppError("NOT_FOUND", "User not found");
    }
    return user;
  }

  private requireAssignableRoles(actor: AuthenticatedUser, roles: UserRole[] | undefined): void {
    if (roles?.includes("superadmin") && !this.isSuperadmin(actor)) {
      throw new AppError("FORBIDDEN", "Only superadmins can assign superadmin access");
    }
  }

  private requireManageableUser(actor: AuthenticatedUser, user: UserRecord): void {
    if (user.roles.includes("superadmin") && !this.isSuperadmin(actor)) {
      throw new AppError("FORBIDDEN", "Only superadmins can manage superadmin users");
    }
  }

  private isSuperadmin(user: AuthenticatedUser): boolean {
    return user.roles.includes("superadmin");
  }

  private async deleteStandalonePasswordSignIns(user: UserRecord): Promise<void> {
    const deletePasswordSignIn = this.options.standaloneAuth?.deletePasswordSignIn;
    if (!deletePasswordSignIn) {
      return;
    }
    const passwordIdentities = user.identities.filter(
      (identity) => identity.authSource === STANDALONE_AUTH_SOURCE
    );
    for (const identity of passwordIdentities) {
      await deletePasswordSignIn({
        externalUserId: identity.externalUserId
      });
    }
  }

  private async requireAtLeastOneRemainingSuperadmin(deletedUser: UserRecord): Promise<void> {
    if (!deletedUser.roles.includes("superadmin")) {
      return;
    }
    const users = await this.options.userStore.listUsers({
      clientInstanceId: this.options.clientInstanceId
    });
    const remainingActiveSuperadmin = users.some(
      (user) =>
        user.id !== deletedUser.id &&
        user.status === "active" &&
        user.roles.includes("superadmin")
    );
    if (!remainingActiveSuperadmin) {
      throw new AppError("VALIDATION_FAILED", "At least one active superadmin must remain");
    }
  }

  private async authorize(
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    auditType: string
  ): Promise<void> {
    await authorizeGovernanceAction({
      options: this.options,
      user,
      context,
      requiredPermission: "users.manage",
      auditType,
      deniedMessage: "User administration requires 'users.manage' permission"
    });
  }

  private async recordUserMutation(
    actor: AuthenticatedUser,
    context: RuntimeCallContext,
    type: string,
    user: UserRecord
  ): Promise<void> {
    await this.options.auditRecorder.record({
      type,
      status: "success",
      actor: auditActorFromUser(actor),
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
