import type { ChatServerOptions } from "@vivd-catalyst/chat-server";
import type { ClientInstanceConfig } from "@vivd-catalyst/config-schema";
import { createProvider, type ProviderCreateContext } from "@vivd-catalyst/core";
import {
  mailProviderDefinitions,
  TemplateMailSender,
  type MailSenderIdentity
} from "@vivd-catalyst/mail";

/** The mail sender of an instance, or nothing when `infrastructure.mail` is absent. */
export async function createClientInstanceMail(input: {
  config: ClientInstanceConfig;
  context: ProviderCreateContext;
}): Promise<ChatServerOptions["mail"]> {
  const { infrastructure, clientInstance } = input.config;
  const { mail } = infrastructure;
  if (!mail) {
    return undefined;
  }
  const identity: MailSenderIdentity = {
    fromAddress: mail.sender.fromAddress,
    fromName: mail.sender.fromName ?? clientInstance.displayName,
    replyTo: mail.sender.replyTo,
    productName: clientInstance.displayName
  };
  const provider = await createProvider(
    mailProviderDefinitions,
    "mail",
    { path: "infrastructure.mail", entry: mail },
    input.context
  );
  return {
    sender: new TemplateMailSender(provider.transport, identity),
    appUrl: mail.appUrl,
    ...(provider.listCaptured ? { listCaptured: provider.listCaptured } : {})
  };
}
