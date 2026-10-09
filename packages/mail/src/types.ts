import type { LocaleCode } from "@vivd-catalyst/core";

export interface MailRecipient {
  email: string;
  displayLabel?: string;
}

export interface PasswordResetMail {
  template: "password-reset";
  params: {
    link: string;
    validMinutes: number;
  };
}

export interface PlatformInvitationMail {
  template: "platform-invitation";
  params: {
    link: string;
    validDays: number;
    inviterLabel: string;
  };
}

export type MailTemplate = PasswordResetMail | PlatformInvitationMail;
export type MailTemplateId = MailTemplate["template"];

export type MailMessage = MailTemplate & {
  to: MailRecipient;
  locale: LocaleCode;
};

export type MailSendResult = { ok: true } | { ok: false; reason: string };

/**
 * Renders and delivers one transactional email. Callers pick a template and typed params;
 * they never compose subjects, bodies, or provider payloads.
 */
export interface MailSender {
  send(message: MailMessage): Promise<MailSendResult>;
}

export interface MailSenderIdentity {
  fromAddress: string;
  fromName: string;
  replyTo?: string;
  /** Client instance display name used in template copy. */
  productName: string;
}

export interface RenderedMail {
  to: MailRecipient;
  subject: string;
  text: string;
  html: string;
}

/** Provider adapter: delivers one already-rendered mail. */
export interface MailTransport {
  deliver(mail: RenderedMail, identity: MailSenderIdentity): Promise<MailSendResult>;
}

/** A mail that a provider kept instead of delivering it. */
export interface CapturedMail extends RenderedMail {
  id: string;
  sentAt: string;
}

/** What a mail adapter hands back. */
export interface MailProviderInstance {
  transport: MailTransport;
  /** Present when the provider keeps mails instead of delivering them. */
  listCaptured?: () => CapturedMail[];
}

declare module "@vivd-catalyst/core" {
  /** What the `mail` port creates. */
  interface ProviderInstances {
    mail: MailProviderInstance;
  }
}
