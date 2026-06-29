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

interface ResetUserPasswordCommand {
  userId: UserId;
  password: string;
}

export class UserAdministrationWorkflow {
  constructor(private readonly options: ChatServerOptions) {}

  async listUsers(user: AuthenticatedUser, context: RuntimeCallContext): Promise<UserRecord[]> {
    await this.authorize(user, context, "governance.users_viewed");
    return this.options.userStore.listUsers({
      clientInstanceId: this.options.clientInstanceId
    });
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
      status: command.status
    });
    await this.recordUserMutation(actor, context, "user.updated", updated);
    return updated;
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

  private async authorize(
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    auditType: string
  ): Promise<void> {
    await authorizeGovernanceAction({
      options: this.options,
      user,
      context,
      requiredRole: "admin",
      auditType,
      deniedMessage: "User administration requires an admin role"
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
        permissionRefs: user.permissionRefs
      }
    });
  }
}
