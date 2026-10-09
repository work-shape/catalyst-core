import type { MailSendResult, MailSenderIdentity, MailTransport, RenderedMail } from "../types";

const MAILJET_SEND_URL = "https://api.mailjet.com/v3.1/send";
// Protects the sender from a mail provider that never answers. Past it the send fails as
// "provider_unreachable" and the mail is not delivered.
const MAILJET_SEND_TIMEOUT_MS = 30_000;

export interface MailjetTransportOptions {
  apiKey: string;
  apiSecret: string;
  fetch?: typeof fetch;
}

/** Mailjet Send API v3.1. Provider payload shapes stay inside this file. */
export class MailjetTransport implements MailTransport {
  private readonly authorization: string;
  private readonly fetch: typeof fetch;

  constructor(options: MailjetTransportOptions) {
    this.authorization = `Basic ${Buffer.from(`${options.apiKey}:${options.apiSecret}`).toString("base64")}`;
    this.fetch = options.fetch ?? fetch;
  }

  async deliver(mail: RenderedMail, identity: MailSenderIdentity): Promise<MailSendResult> {
    let response: Response;
    try {
      response = await this.fetch(MAILJET_SEND_URL, {
        method: "POST",
        headers: {
          authorization: this.authorization,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          Messages: [
            {
              From: { Email: identity.fromAddress, Name: identity.fromName },
              To: [
                {
                  Email: mail.to.email,
                  ...(mail.to.displayLabel ? { Name: mail.to.displayLabel } : {})
                }
              ],
              ...(identity.replyTo ? { ReplyTo: { Email: identity.replyTo } } : {}),
              Subject: mail.subject,
              TextPart: mail.text,
              HTMLPart: mail.html
            }
          ]
        }),
        signal: AbortSignal.timeout(MAILJET_SEND_TIMEOUT_MS)
      });
    } catch {
      return { ok: false, reason: "provider_unreachable" };
    }
    if (!response.ok) {
      return { ok: false, reason: `provider_http_${response.status}` };
    }
    const payload: unknown = await response.json().catch(() => undefined);
    return readMessageStatus(payload) === "success"
      ? { ok: true }
      : { ok: false, reason: "provider_rejected" };
  }
}

function readMessageStatus(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || !("Messages" in payload)) {
    return undefined;
  }
  const messages = payload.Messages;
  if (!Array.isArray(messages)) {
    return undefined;
  }
  const first: unknown = messages[0];
  if (typeof first !== "object" || first === null || !("Status" in first)) {
    return undefined;
  }
  return typeof first.Status === "string" ? first.Status : undefined;
}
