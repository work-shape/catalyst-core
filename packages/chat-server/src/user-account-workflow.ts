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
import { requestAccountDeletion } from "./account-deletion";
import type { DeletionOutcome } from "./subject-deletion";
import type { ChatServerOptions } from "./types";

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
    const updated = await this.options.stores.users.updateUser({
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

  /**
   * Accepts the deletion of the signed-in user's account. `deferred` means the account is
   * closed and its job removes what is left.
   */
  async deleteCurrentUser(
    actor: AuthenticatedUser,
    context: RuntimeCallContext
  ): Promise<DeletionOutcome<{ ok: true }>> {
    if (actor.principal?.kind === "service" || actor.delegatedActor) {
      throw new AppError("FORBIDDEN", "Account deletion must be requested by the signed-in user");
    }

    const existing = await this.getCurrentUserOrThrow(actor);
    const outcome = await requestAccountDeletion(this.options, {
      userId: existing.id,
      requestedBy: "self",
      actor: auditActorFromUser(actor),
      actorUserId: existing.id,
      correlationId: context.correlationId,
      alreadyRequested: existing.status === "deleting"
    });
    return outcome.status === "deleted" ? { status: "deleted", result: { ok: true } } : outcome;
  }

  private async getCurrentUserOrThrow(actor: AuthenticatedUser): Promise<UserRecord> {
    const users = await this.options.stores.users.listUsers({
      clientInstanceId: this.options.clientInstanceId
    });
    const user = users.find((candidate) => candidate.id === actor.id);
    if (!user) {
      throw new AppError("NOT_FOUND", "User account is not available");
    }
    return user;
  }
}
