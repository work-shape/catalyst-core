import type { LocaleCode, WorkflowMessageMailParams } from "@work-shape/catalyst-core";

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

/** A counts-only digest and an Inbox link; no notice title, text or run value. */
export interface WorkflowNoticeMail {
  template: "workflow-notice";
  params: {
    /** Number of notices in this digest. Never derived from the title or text. */
    count?: number;
    /** The addressee's Inbox address. */
    link: string;
  };
}

/**
 * A mail of `mail.send`: what its author wrote and mapped, as Markdown, in the instance's frame
 * (`MailFrame`). Its envelope is the message's: several recipients, cc, bcc, Reply-To and the
 * display name of the From line.
 */
export interface WorkflowMessageMail {
  template: "workflow-message";
  params: WorkflowMessageMailParams;
}

/**
 * A report of a run that failed for a platform reason, to the operator's support address
 * (PLATFORM-REPORT): ids, the error code, the instance and the times, and the person's note if
 * they wrote one. Never anything of the conversation, its files or a log.
 */
export interface PlatformReportMail {
  template: "platform-report";
  params: {
    instance: { id: string; displayName: string; environment: string; appUrl?: string };
    runId: string;
    /** The workspace command that failed, where a tool's failure names one. */
    commandId?: string;
    errorCode: string;
    /** When the run or the command failed. */
    failedAt: string;
    reportedAt: string;
    /** What the person wrote, as they wrote it. */
    note?: string;
  };
}

export type MailTemplate =
  | PasswordResetMail
  | PlatformInvitationMail
  | WorkflowNoticeMail
  | WorkflowMessageMail
  | PlatformReportMail;
export type MailTemplateId = MailTemplate["template"];

/** A platform mail to one person. */
export type SinglePersonMailMessage = (
  PasswordResetMail | PlatformInvitationMail | WorkflowNoticeMail
) & {
  to: MailRecipient;
  locale: LocaleCode;
};

/** A mail of `mail.send`, with the envelope it was given. `to` holds one recipient or more. */
export type WorkflowMessageMailMessage = WorkflowMessageMail & {
  to: readonly MailRecipient[];
  cc?: readonly MailRecipient[];
  bcc?: readonly MailRecipient[];
  replyTo?: MailRecipient;
  /** The display name on the From line; the address stays the sender's. */
  fromName?: string;
  locale: LocaleCode;
};

/**
 * A platform report to the operator. Its From is always the instance's system sender; Reply-To
 * names the person only where they asked for an answer.
 */
export type PlatformReportMailMessage = PlatformReportMail & {
  to: MailRecipient;
  replyTo?: MailRecipient;
  locale: LocaleCode;
};

export type MailMessage =
  SinglePersonMailMessage | WorkflowMessageMailMessage | PlatformReportMailMessage;

/**
 * How a send ended. A failure says whether the mail went out:
 * - `rejected`: the provider refused it before accepting it (an invalid address, a refused
 *   sender). `providerCode` is the provider's own code; its text is never kept.
 * - `unsent`: no connection to the provider could be made. Nothing left, so it may be tried
 *   again.
 * - `uncertain`: the request left and its answer was lost (a timeout, a 5xx). The provider
 *   takes no idempotency key, so the mail may or may not have gone out and is not sent again.
 */
export type MailSendResult =
  | { ok: true; messageId?: string }
  | {
      ok: false;
      reason: string;
      failure?: "rejected" | "unsent" | "uncertain";
      providerCode?: string;
    };

/**
 * Renders and delivers one transactional email. Callers pick a template and typed params;
 * they never compose subjects, bodies, or provider payloads.
 */
export interface MailSender {
  send(message: MailMessage, context?: { signal?: AbortSignal }): Promise<MailSendResult>;
  /**
   * The mail as it would go out, with its embedded images as `data:` URIs so a preview loads
   * nothing from a host. Sends nothing.
   */
  preview?(message: MailMessage): Promise<RenderedMail>;
}

/** An image carried inside the mail (`cid:`), never loaded from a host. */
export interface InlineMailImage {
  /** The content id the HTML part refers to as `cid:<contentId>`. */
  contentId: string;
  contentType: "image/png" | "image/jpeg" | "image/gif";
  filename: string;
  content: Uint8Array;
}

/**
 * The instance's frame around a mail of `mail.send`: its logo, embedded in the mail, its accent
 * colour and the operator's legal footer (`infrastructure.mail.outbound.footer`).
 */
export interface MailFrame {
  accentColor: string;
  /** Read once and kept; nothing where the instance has no logo or it cannot be read. */
  logo?: () => Promise<InlineMailImage | undefined>;
  footer?: Partial<Record<LocaleCode, string>>;
}

export interface MailSenderIdentity {
  fromAddress: string;
  fromName: string;
  replyTo?: string;
  /** Client instance display name used in template copy. */
  productName: string;
  /** The frame of a mail of `mail.send`. The other templates have none. */
  frame?: MailFrame;
}

export interface RenderedMail {
  /** One recipient or more. The templates of one person have one. */
  to: readonly MailRecipient[];
  cc?: readonly MailRecipient[];
  bcc?: readonly MailRecipient[];
  /** Where replies go, where the message names one; else the sender's `replyTo`. */
  replyTo?: MailRecipient;
  /** The display name of the From line, where the message names one; else the sender's. */
  fromName?: string;
  subject: string;
  text: string;
  html: string;
  /** Images the HTML part refers to by `cid:`. */
  inlineImages?: readonly InlineMailImage[];
}

/** Provider adapter: delivers one already-rendered mail. */
export interface MailTransport {
  deliver(
    mail: RenderedMail,
    identity: MailSenderIdentity,
    context?: { signal?: AbortSignal }
  ): Promise<MailSendResult>;
}

/**
 * A mail that a provider kept instead of delivering it. `to` is its first recipient, which is
 * all a mail to one person has; `recipients` lists every one.
 */
export interface CapturedMail {
  id: string;
  sentAt: string;
  from: { email: string; name: string };
  to: MailRecipient;
  recipients: { to: MailRecipient[]; cc: MailRecipient[]; bcc: MailRecipient[] };
  replyTo?: MailRecipient;
  subject: string;
  text: string;
  html: string;
  /** The embedded images by content id and type, without their bytes. */
  inlineImages?: { contentId: string; contentType: string; bytes: number }[];
}

/** What a mail adapter hands back. */
export interface MailProviderInstance {
  transport: MailTransport;
  /** Present when the provider keeps mails instead of delivering them. */
  listCaptured?: () => CapturedMail[];
}

declare module "@work-shape/catalyst-core" {
  /** What the `mail` port creates. */
  interface ProviderInstances {
    mail: MailProviderInstance;
  }
}
