import { renderMail } from "./templates";
import type {
  MailMessage,
  MailSendResult,
  MailSender,
  MailSenderIdentity,
  MailTransport
} from "./types";

export class TemplateMailSender implements MailSender {
  constructor(
    private readonly transport: MailTransport,
    private readonly identity: MailSenderIdentity
  ) {}

  send(message: MailMessage, context?: { signal?: AbortSignal }): Promise<MailSendResult> {
    return this.transport.deliver(renderMail(message, this.identity), this.identity, context);
  }
}
