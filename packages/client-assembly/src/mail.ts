import { createNotices } from "@work-shape/catalyst-server";
import {
  StoreBackedAuditRecorder,
  type PlatformStores,
  type ClientInstanceId
} from "@work-shape/catalyst-core";
import type { ChatServerOptions } from "@work-shape/catalyst-server";
import type { ClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import type { ProviderCreateContext, ProviderRegistry } from "@work-shape/catalyst-core";
import { TemplateMailSender, type MailSenderIdentity } from "@work-shape/catalyst-mail";

/** The mail sender of an instance, or nothing when `infrastructure.mail` is absent. */
export async function createClientInstanceMail(input: {
  config: ClientInstanceConfig;
  registry: ProviderRegistry;
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
  const provider = await input.registry.create(
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

/** The same mail adapter instance as sign-in and the development capture route. */
export function createInstanceNotices(input: {
  config: ClientInstanceConfig;
  clientInstanceId: ClientInstanceId;
  mail: ChatServerOptions["mail"];
}) {
  return (stores: PlatformStores) =>
    createNotices({
      clientInstanceId: input.clientInstanceId,
      stores,
      auditRecorder: new StoreBackedAuditRecorder({
        clientInstanceId: input.clientInstanceId,
        store: stores.audit
      }),
      mailConfigured: input.mail !== undefined,
      delivery: input.config.infrastructure.mail?.notices
    });
}
