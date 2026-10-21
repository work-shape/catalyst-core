import { STANDALONE_AUTH_SOURCE } from "@work-shape/catalyst-auth";
import {
  AppError,
  asUserId,
  auditActorFromUser,
  authenticatedUserFromRecord,
  type AuthenticatedUser,
  type FollowUpMode,
  type LocaleCode,
  type RuntimeCallContext,
  type UserRecord
} from "@work-shape/catalyst-core";
import { requestAccountDeletion } from "../deletion/account-deletion";
import type { DeletionOutcome } from "../deletion/subject-deletion";
import type { ChatServerOptions } from "../types";

/** What a person changes of their own profile; a field left out stays as it is. */
interface UpdateCurrentUserCommand {
  displayLabel?: string;
  /** `null` goes back to the instance's default language. */
  locale?: LocaleCode | null;
  followUpMode?: FollowUpMode;
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
  ): Promise<AuthenticatedUser & Pick<UserRecord, "locale"> & { followUpMode: FollowUpMode }> {
    const { supportedLocales } = this.options.config.localization;
    if (command.locale && !supportedLocales.includes(command.locale)) {
      throw new AppError(
        "VALIDATION_FAILED",
        `This instance offers the languages ${supportedLocales.join(", ")}, not '${command.locale}'.`,
        { reason: "locale_not_offered" }
      );
    }
    const updated = await this.options.stores.users.updateUser({
      clientInstanceId: this.options.clientInstanceId,
      userId: asUserId(actor.id),
      ...(command.displayLabel === undefined ? {} : { displayLabel: command.displayLabel }),
      ...(command.locale === undefined ? {} : { locale: command.locale }),
      ...(command.followUpMode === undefined ? {} : { followUpMode: command.followUpMode })
    });

    await this.options.auditRecorder.record({
      type: "user.profile_updated",
      status: "success",
      actor: auditActorFromUser(actor),
      subject: updated.id,
      correlationId: context.correlationId,
      metadata: {
        fields: (["displayLabel", "locale", "followUpMode"] as const).filter(
          (field) => command[field] !== undefined
        )
      }
    });

    return {
      ...authenticatedUserFromRecord({
        user: updated,
        identity: {
          authSource: actor.authSource,
          externalUserId: actor.externalUserId
        },
        correlationId: context.correlationId
      }),
      ...(updated.locale ? { locale: updated.locale } : {}),
      followUpMode: updated.followUpMode ?? "queue"
    };
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
      correlationId: context.correlationId
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
