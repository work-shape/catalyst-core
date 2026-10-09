import { STANDALONE_AUTH_SOURCE } from "@vivd-catalyst/auth";
import {
  AppError,
  type AuditActor,
  type LocaleCode,
  type RuntimeCallContext,
  type UserRecord
} from "@vivd-catalyst/core";
import type { ResolvedChatServerOptions } from "./types";

export const PASSWORD_RESET_VALID_MINUTES = 60;
export const PLATFORM_INVITATION_VALID_DAYS = 7;

const HOUR_MS = 60 * 60 * 1000;
// Protects a mailbox from being flooded with reset mails. Over it no mail is sent; the caller
// reads the same answer as always, so the answer says nothing about a mailbox.
const RESET_MAILS_PER_MAILBOX_PER_HOUR = 3;
// Protects the mail sender from one address requesting resets for many mailboxes, and is sized
// for an office behind one address. Over it no mail is sent, and the answer stays the same.
const RESET_MAILS_PER_ADDRESS_PER_HOUR = 200;

interface RequestPasswordResetCommand {
  email: string;
  locale: LocaleCode;
  remoteAddress: string;
  /** Delivery runs after the response; failures are reported here instead of to the caller. */
  onDeliveryError(error: unknown): void;
}

interface CompletePasswordSetupCommand {
  token: string;
  password: string;
}

/**
 * The token travels in the URL fragment so it never reaches server logs, proxies, or the
 * Referer header.
 */
export function createPasswordSetupLink(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/u, "")}/#password-setup=${token}`;
}

export class PasswordSetupWorkflow {
  constructor(private readonly options: ResolvedChatServerOptions) {}

  /**
   * Always answers the same way and never waits for delivery, so neither the response nor its
   * timing reveals whether an account exists.
   */
  async requestPasswordReset(
    command: RequestPasswordResetCommand,
    context: Pick<RuntimeCallContext, "correlationId">
  ): Promise<{ ok: true }> {
    if (!this.options.mail || !this.options.standaloneAuth) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Password reset by email is not enabled for this client instance"
      );
    }
    const email = command.email.trim().toLowerCase();
    const limiter = this.options.rateLimiter;
    const allowed =
      (
        await limiter.consume(`password-reset-mail|address:${command.remoteAddress}`, {
          limit: RESET_MAILS_PER_ADDRESS_PER_HOUR,
          windowMs: HOUR_MS
        })
      ).allowed &&
      (
        await limiter.consume(`password-reset-mail|mailbox:${email}`, {
          limit: RESET_MAILS_PER_MAILBOX_PER_HOUR,
          windowMs: HOUR_MS
        })
      ).allowed;
    if (allowed) {
      void this.deliverPasswordReset(email, command.locale, context).catch(command.onDeliveryError);
    }
    return { ok: true };
  }

  async completePasswordSetup(
    command: CompletePasswordSetupCommand,
    context: Pick<RuntimeCallContext, "correlationId">
  ): Promise<{ ok: true }> {
    const standaloneAuth = this.options.standaloneAuth;
    if (!standaloneAuth) {
      throw new AppError("VALIDATION_FAILED", "This link is invalid or has expired");
    }
    const completed = await standaloneAuth.completePasswordSetup(command);
    const user = await this.findUserByPasswordSignIn(completed.externalUserId);
    if (user) {
      await this.options.auditRecorder.record({
        type: "user.password_reset",
        status: "success",
        actor: selfActor(user),
        subject: user.id,
        correlationId: context.correlationId,
        metadata: {
          authSource: STANDALONE_AUTH_SOURCE,
          via: "emailed_link"
        }
      });
    }
    return { ok: true };
  }

  private async deliverPasswordReset(
    email: string,
    locale: LocaleCode,
    context: Pick<RuntimeCallContext, "correlationId">
  ): Promise<void> {
    const { mail, standaloneAuth } = this.options;
    if (!mail || !standaloneAuth) {
      return;
    }
    const signIn = await standaloneAuth.findPasswordSignIn({ email });
    const user = signIn ? await this.findUserByPasswordSignIn(signIn.externalUserId) : undefined;
    if (!signIn || !user || user.status !== "active") {
      return;
    }
    const token = await standaloneAuth.createPasswordSetupToken({
      externalUserId: signIn.externalUserId,
      ttlMs: PASSWORD_RESET_VALID_MINUTES * 60 * 1000
    });
    const result = await mail.sender.send({
      template: "password-reset",
      to: { email: signIn.email, displayLabel: signIn.displayLabel },
      locale,
      params: {
        link: createPasswordSetupLink(mail.appUrl, token),
        validMinutes: PASSWORD_RESET_VALID_MINUTES
      }
    });
    await this.options.auditRecorder.record({
      type: "user.password_reset_requested",
      status: result.ok ? "success" : "failed",
      // Requested anonymously: no actor, so the event is not attributed to the affected user.
      subject: user.id,
      correlationId: context.correlationId,
      metadata: {
        template: "password-reset",
        ...(result.ok ? {} : { reason: result.reason })
      }
    });
  }

  private async findUserByPasswordSignIn(externalUserId: string): Promise<UserRecord | undefined> {
    const users = await this.options.stores.users.listUsers({
      clientInstanceId: this.options.clientInstanceId
    });
    return users.find((candidate) =>
      candidate.identities.some(
        (identity) =>
          identity.authSource === STANDALONE_AUTH_SOURCE &&
          identity.externalUserId === externalUserId
      )
    );
  }
}

/** The person following an emailed link is not signed in, but acts as themselves. */
function selfActor(user: UserRecord): AuditActor {
  return {
    userId: user.id,
    displayLabel: user.displayLabel,
    roles: user.roles
  };
}
