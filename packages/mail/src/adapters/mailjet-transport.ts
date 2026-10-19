import {
  providerCheckResultOfStatus,
  type ProviderCheckContext,
  type ProviderCheckResult
} from "@work-shape/catalyst-core";
import type {
  MailRecipient,
  MailSendResult,
  MailSenderIdentity,
  MailTransport,
  RenderedMail
} from "../types";

const MAILJET_SEND_URL = "https://api.mailjet.com/v3.1/send";
// The account behind the key pair: authenticated, read-only, and it sends nothing.
const MAILJET_CHECK_URL = "https://api.mailjet.com/v3/REST/user";
// Protects the sender from a mail provider that never answers. Past it the send's outcome is
// uncertain: the request may have reached Mailjet.
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

  async deliver(
    mail: RenderedMail,
    identity: MailSenderIdentity,
    context?: { signal?: AbortSignal }
  ): Promise<MailSendResult> {
    const replyTo = mail.replyTo ?? (identity.replyTo ? { email: identity.replyTo } : undefined);
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
              From: { Email: identity.fromAddress, Name: mail.fromName ?? identity.fromName },
              To: mail.to.map(contact),
              ...(mail.cc && mail.cc.length > 0 ? { Cc: mail.cc.map(contact) } : {}),
              ...(mail.bcc && mail.bcc.length > 0 ? { Bcc: mail.bcc.map(contact) } : {}),
              ...(replyTo ? { ReplyTo: contact(replyTo) } : {}),
              Subject: mail.subject,
              TextPart: mail.text,
              HTMLPart: mail.html,
              ...(mail.inlineImages && mail.inlineImages.length > 0
                ? {
                    InlinedAttachments: mail.inlineImages.map((image) => ({
                      ContentType: image.contentType,
                      Filename: image.filename,
                      ContentID: image.contentId,
                      Base64Content: Buffer.from(image.content).toString("base64")
                    }))
                  }
                : {})
            }
          ]
        }),
        signal: context?.signal
          ? AbortSignal.any([context.signal, AbortSignal.timeout(MAILJET_SEND_TIMEOUT_MS)])
          : AbortSignal.timeout(MAILJET_SEND_TIMEOUT_MS)
      });
    } catch (error) {
      // Refused before anything left: nothing was sent and it may be tried again. Any other
      // error, a timeout among them, may have come after Mailjet took the request.
      return notConnected(error)
        ? { ok: false, reason: "provider_unreachable", failure: "unsent" }
        : { ok: false, reason: "provider_uncertain", failure: "uncertain" };
    }
    const payload: unknown = await response.json().catch(() => undefined);
    if (response.status >= 500) {
      return { ok: false, reason: `provider_http_${response.status}`, failure: "uncertain" };
    }
    if (response.status === 429) {
      // Mailjet took nothing: its limit refused the request before reading it.
      return { ok: false, reason: "provider_http_429", failure: "unsent" };
    }
    const message = firstMessage(payload);
    const status = message && "Status" in message ? message.Status : undefined;
    if (!response.ok || status !== "success") {
      return {
        ok: false,
        reason: response.ok ? "provider_rejected" : `provider_http_${response.status}`,
        failure: "rejected",
        providerCode: errorCodeOf(message) ?? `http_${response.status}`
      };
    }
    const messageId = messageIdOf(message);
    return messageId === undefined ? { ok: true } : { ok: true, messageId };
  }

  /** Whether Mailjet answers this key pair. No mail is sent and the answer's body is not read. */
  async check({ signal }: ProviderCheckContext): Promise<ProviderCheckResult> {
    let response: Response;
    try {
      response = await this.fetch(MAILJET_CHECK_URL, {
        headers: { authorization: this.authorization },
        signal
      });
    } catch {
      return { ok: false, errorClass: "unreachable" };
    }
    await response.body?.cancel().catch(() => undefined);
    return providerCheckResultOfStatus(response.status);
  }
}

/** Errors of a connection that was never made: nothing reached Mailjet. */
const NOT_CONNECTED_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT"
]);

function notConnected(error: unknown): boolean {
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  const code =
    typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
  return typeof code === "string" && NOT_CONNECTED_CODES.has(code);
}

function contact(recipient: MailRecipient): { Email: string; Name?: string } {
  return {
    Email: recipient.email,
    ...(recipient.displayLabel ? { Name: recipient.displayLabel } : {})
  };
}

type MailjetMessage = object;

function firstMessage(payload: unknown): MailjetMessage | undefined {
  if (typeof payload !== "object" || payload === null || !("Messages" in payload)) {
    return undefined;
  }
  const messages = payload.Messages;
  if (!Array.isArray(messages)) {
    return undefined;
  }
  const first: unknown = messages[0];
  return typeof first === "object" && first !== null ? first : undefined;
}

/** Mailjet's own code of the first error, such as `mj-0013`. Its text is never kept. */
function errorCodeOf(message: MailjetMessage | undefined): string | undefined {
  const errors = message && "Errors" in message ? message.Errors : undefined;
  if (!Array.isArray(errors)) return undefined;
  const first: unknown = errors[0];
  const code =
    typeof first === "object" && first !== null && "ErrorCode" in first
      ? first.ErrorCode
      : undefined;
  return typeof code === "string" && /^[A-Za-z0-9_.-]{1,100}$/u.test(code) ? code : undefined;
}

/** The id Mailjet gave the mail: of its first recipient, as all of them share one message. */
function messageIdOf(message: MailjetMessage | undefined): string | undefined {
  const to = message && "To" in message ? message.To : undefined;
  if (!Array.isArray(to)) return undefined;
  const first: unknown = to[0];
  const id =
    typeof first === "object" && first !== null && "MessageID" in first
      ? first.MessageID
      : undefined;
  return typeof id === "number" || (typeof id === "string" && id.length <= 256)
    ? String(id)
    : undefined;
}
