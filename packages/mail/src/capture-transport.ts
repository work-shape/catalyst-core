import type { MailSendResult, MailTransport, RenderedMail } from "./types";

const MAX_CAPTURED_MAILS = 50;

export interface CapturedMail extends RenderedMail {
  sentAt: string;
}

/**
 * Keeps rendered mails in memory instead of delivering them. Used for local development and
 * end-to-end tests; release config validation refuses it in production.
 */
export class CaptureMailTransport implements MailTransport {
  private readonly mails: CapturedMail[] = [];

  async deliver(mail: RenderedMail): Promise<MailSendResult> {
    this.mails.push({ ...mail, sentAt: new Date().toISOString() });
    if (this.mails.length > MAX_CAPTURED_MAILS) {
      this.mails.shift();
    }
    return { ok: true };
  }

  list(): CapturedMail[] {
    return [...this.mails];
  }
}
