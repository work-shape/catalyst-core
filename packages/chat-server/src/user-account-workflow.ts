import { STANDALONE_AUTH_SOURCE } from "@vivd-catalyst/auth";
import {
  AppError,
  asUserId,
  auditActorFromUser,
  authenticatedUserFromRecord,
  type AuthenticatedUser,
  type RuntimeCallContext
} from "@vivd-catalyst/core";
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
}
