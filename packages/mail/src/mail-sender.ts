import { renderMail } from "./templates";
import type {
  InlineMailImage,
  MailMessage,
  MailSendResult,
  MailSender,
  MailSenderIdentity,
  MailTransport,
  RenderedMail
} from "./types";

export class TemplateMailSender implements MailSender {
  constructor(
    private readonly transport: MailTransport,
    private readonly identity: MailSenderIdentity
  ) {}

  async send(message: MailMessage, context?: { signal?: AbortSignal }): Promise<MailSendResult> {
    const image = await this.logoFor(message);
    const logo = image && { src: `cid:${image.contentId}`, image };
    return this.transport.deliver(renderMail(message, this.identity, logo), this.identity, context);
  }

  async preview(message: MailMessage): Promise<RenderedMail> {
    const image = await this.logoFor(message);
    const logo = image && {
      src: `data:${image.contentType};base64,${Buffer.from(image.content).toString("base64")}`,
      image
    };
    return renderMail(message, this.identity, logo);
  }

  /** Only a mail of `mail.send` sits in the frame with the logo. */
  private async logoFor(message: MailMessage): Promise<InlineMailImage | undefined> {
    if (message.template !== "workflow-message") return undefined;
    return this.identity.frame?.logo?.().catch(() => undefined);
  }
}
