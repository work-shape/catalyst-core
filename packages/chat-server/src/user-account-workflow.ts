import { STANDALONE_AUTH_SOURCE } from "@vivd-catalyst/auth";
import {
  AppError,
  asUserId,
  auditActorFromUser,
  authenticatedUserFromRecord,
  type AuthenticatedUser,
  type RuntimeCallContext,
  type UserRecord
} from "@vivd-catalyst/core";
import type { ChatServerOptions } from "./types";
import { pendingCleanupCountOf } from "./conversation-cleanup";
import { cleanupProductUserData, type UserDeletionTotals } from "./user-deletion";

interface UpdateCurrentUserCommand {
  displayLabel: string;
}

interface ChangeCurrentUserPasswordCommand {
  currentPassword: string;
  newPassword: string;
}

export class UserAccountWorkflow {
  constructor(private readonly options: ChatServerOptions) {}

  async updateCurrentUser(
    actor: AuthenticatedUser,
    context: RuntimeCallContext,
    command: UpdateCurrentUserCommand
  ): Promise<AuthenticatedUser> {
    const updated = await this.options.userStore.updateUser({
      clientInstanceId: this.options.clientInstanceId,
      userId: asUserId(actor.id),
      displayLabel: command.displayLabel
    });

    await this.options.auditRecorder.record({
      type: "user.profile_updated",
      status: "success",
      actor: auditActorFromUser(actor),
      subject: updated.id,
      correlationId: context.correlationId,
      metadata: {
        fields: ["displayLabel"]
      }
    });

    return authenticatedUserFromRecord({
      user: updated,
      identity: {
        authSource: actor.authSource,
        externalUserId: actor.externalUserId
      },
      correlationId: context.correlationId
    });
  }

  async changeCurrentUserPassword(
    actor: AuthenticatedUser,
    context: RuntimeCallContext,
    command: ChangeCurrentUserPasswordCommand
  ): Promise<{ ok: true }> {
    if (actor.authSource !== STANDALONE_AUTH_SOURCE) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Password changes are only available for standalone auth accounts"
      );
    }

    const changePassword = this.options.standaloneAuth?.changePassword;
    if (!changePassword) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Password changes require standalone auth to be enabled for this client instance"
      );
    }

    await changePassword({
      externalUserId: actor.externalUserId,
      currentPassword: command.currentPassword,
      newPassword: command.newPassword
    });
    await this.options.auditRecorder.record({
      type: "user.password_changed",
      status: "success",
      actor: auditActorFromUser(actor),
      subject: actor.id,
      correlationId: context.correlationId,
      metadata: {
        authSource: actor.authSource
      }
    });

    return { ok: true };
  }

  async deleteCurrentUser(
    actor: AuthenticatedUser,
    context: RuntimeCallContext
  ): Promise<{ ok: true }> {
    if (actor.principal?.kind === "service" || actor.delegatedActor) {
      throw new AppError("FORBIDDEN", "Account deletion must be requested by the signed-in user");
    }

    const existing = await this.getCurrentUserOrThrow(actor);
    let deletionTotals: UserDeletionTotals;
    try {
      deletionTotals = await cleanupProductUserData({
        options: this.options,
        actor,
        context,
        userId: asUserId(actor.id)
      });
    } catch (error) {
      const pendingCleanupCount = pendingCleanupCountOf(error);
      if (pendingCleanupCount !== undefined) {
        await this.options.auditRecorder.record({
          type: "user.delete_failed",
          status: "failed",
          actor: auditActorFromUser(actor),
          subject: existing.id,
          correlationId: context.correlationId,
          metadata: { requestedBy: "self", pendingCleanupCount }
        });
      }
      throw error;
    }
    await this.deleteStandalonePasswordSignIns(existing);
    const deleted = await this.options.userStore.deleteUser({
      clientInstanceId: this.options.clientInstanceId,
      userId: asUserId(actor.id)
    });

    await this.options.auditRecorder.record({
      type: "user.deleted",
      status: "success",
      actor: auditActorFromUser(actor),
      subject: deleted.id,
      correlationId: context.correlationId,
      metadata: {
        requestedBy: "self",
        roles: deleted.roles,
        permissionRefs: deleted.permissionRefs,
        permissions: deleted.permissions,
        ...deletionTotals
      }
    });

    return { ok: true };
  }

  private async getCurrentUserOrThrow(actor: AuthenticatedUser): Promise<UserRecord> {
    const users = await this.options.userStore.listUsers({
      clientInstanceId: this.options.clientInstanceId
    });
    const user = users.find((candidate) => candidate.id === actor.id);
    if (!user) {
      throw new AppError("NOT_FOUND", "User account is not available");
    }
    return user;
  }

  private async deleteStandalonePasswordSignIns(user: UserRecord): Promise<void> {
    const deletePasswordSignIn = this.options.standaloneAuth?.deletePasswordSignIn;
    if (!deletePasswordSignIn) {
      return;
    }
    const identities = user.identities.filter(
      (identity) => identity.authSource === STANDALONE_AUTH_SOURCE
    );
    for (const identity of identities) {
      await deletePasswordSignIn({
        externalUserId: identity.externalUserId
      });
    }
  }
}
