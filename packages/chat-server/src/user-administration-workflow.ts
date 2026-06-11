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
    const created = await this.options.userStore.createUser({
      clientInstanceId: this.options.clientInstanceId,
      displayLabel: command.displayLabel,
      email: command.email,
      roles: command.roles,
      permissionRefs: command.permissionRefs,
      status: command.status
    });
    await this.recordUserMutation(actor, context, "user.created", created);
    return created;
  }

  async updateUser(
    actor: AuthenticatedUser,
    context: RuntimeCallContext,
    command: UpdateUserCommand
  ): Promise<UserRecord> {
    await this.authorize(actor, context, "governance.user_update_authorized");
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
    const users = await this.options.userStore.listUsers({
      clientInstanceId: this.options.clientInstanceId
    });
    const user = users.find((candidate) => candidate.id === command.userId);
    if (!user) {
      throw new AppError("NOT_FOUND", "User not found");
    }
    const identity = user.identities.find(
      (candidate) => candidate.authSource === STANDALONE_AUTH_SOURCE
    );
    if (!identity) {
      throw new AppError(
        "VALIDATION_FAILED",
        "User has no standalone auth identity, so there is no password to reset"
      );
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

  private async authorize(
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    auditType: string
  ): Promise<void> {
    await authorizeGovernanceAction({
      options: this.options,
      user,
      context,
      requiredRole: "superadmin",
      auditType,
      deniedMessage: "User administration requires a superadmin role"
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
