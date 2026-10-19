import { randomUUID } from "node:crypto";
import type {
  CapturedMail,
  MailSendResult,
  MailSenderIdentity,
  MailTransport,
  RenderedMail
} from "../types";

const MAX_CAPTURED_MAILS = 50;

/**
 * Keeps rendered mails in memory instead of delivering them. Used for local development and
 * end-to-end tests; release config validation refuses it in production. It keeps the envelope
 * as a provider would send it: the From line, every recipient, cc, bcc and Reply-To.
 */
export class CaptureMailTransport implements MailTransport {
  private readonly mails: CapturedMail[] = [];

  async deliver(mail: RenderedMail, identity: MailSenderIdentity): Promise<MailSendResult> {
    const [first] = mail.to;
    if (!first) return { ok: false, reason: "provider_rejected", failure: "rejected" };
    const id = randomUUID();
    const replyTo = mail.replyTo ?? (identity.replyTo ? { email: identity.replyTo } : undefined);
    this.mails.push({
      id,
      sentAt: new Date().toISOString(),
      from: { email: identity.fromAddress, name: mail.fromName ?? identity.fromName },
      to: first,
      recipients: { to: [...mail.to], cc: [...(mail.cc ?? [])], bcc: [...(mail.bcc ?? [])] },
      ...(replyTo ? { replyTo } : {}),
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      ...(mail.inlineImages && mail.inlineImages.length > 0
        ? {
            inlineImages: mail.inlineImages.map((image) => ({
              contentId: image.contentId,
              contentType: image.contentType,
              bytes: image.content.byteLength
            }))
          }
        : {})
    });
    if (this.mails.length > MAX_CAPTURED_MAILS) {
      this.mails.shift();
    }
    return { ok: true, messageId: `capture-${id}` };
  }

  list(): CapturedMail[] {
    return [...this.mails];
  }
}
