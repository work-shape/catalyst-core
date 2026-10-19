import { createNotices, registerMailSendOperation } from "@work-shape/catalyst-server";
import {
  MAIL_SENDER_RESOURCE_KIND,
  MAIL_SENDER_SYSTEM,
  MAIL_SENDER_USE_ACTION,
  StoreBackedAuditRecorder,
  type AccessResource,
  localeCodes,
  type LocaleCode,
  type OperationRegistry,
  type PlatformStores,
  type ClientInstanceId
} from "@work-shape/catalyst-core";
import type { ChatServerOptions } from "@work-shape/catalyst-server";
import {
  createClientBranding,
  getEnabledToolNames,
  type ClientInstanceConfig
} from "@work-shape/catalyst-config-schema";
import type { ProviderCreateContext, ProviderRegistry } from "@work-shape/catalyst-core";
import {
  TemplateMailSender,
  createInlineImageLoader,
  mailAccentColor,
  type MailFrame,
  type MailSenderIdentity
} from "@work-shape/catalyst-mail";
import { MAIL_SEND_TOOL_NAME } from "@work-shape/catalyst-tool-execution";

/**
 * The outbound mail of `mail.send` (MAIL-1), where release config switches it on. While it is
 * off the operation, its tool and its sender `system` do not exist on the instance. Config
 * validation refuses `outbound` without a mail provider, so `enabled` implies one.
 */
export function outboundMailOf(config: ClientInstanceConfig) {
  const mail = config.infrastructure.mail;
  return mail?.outbound.enabled ? { ...mail, outbound: mail.outbound } : undefined;
}

/** The senders `mail.send` sends as: `system` while outbound mail is on. */
export function mailSendersOf(config: ClientInstanceConfig): readonly string[] {
  return outboundMailOf(config) ? [MAIL_SENDER_SYSTEM] : [];
}

/**
 * The tools release config enables, with `mail.send` while outbound mail is on: an agent whose
 * definition lists it is offered it there and nowhere else.
 */
export function releaseToolNames(config: ClientInstanceConfig): Set<string> {
  const names = getEnabledToolNames(config);
  if (outboundMailOf(config)) names.add(MAIL_SEND_TOOL_NAME);
  return names;
}

/**
 * The right a person needs to be offered `mail.send` in chat: `mail_sender.use` on `system`.
 * A person without it is not offered the tool; each call is still decided by the operation.
 */
export function mailSendToolRights(
  config: ClientInstanceConfig
): Readonly<Record<string, { action: string; resource: AccessResource }>> {
  if (!outboundMailOf(config)) return {};
  return {
    [MAIL_SEND_TOOL_NAME]: {
      action: MAIL_SENDER_USE_ACTION,
      resource: {
        kind: MAIL_SENDER_RESOURCE_KIND,
        name: MAIL_SENDER_SYSTEM,
        assetId: MAIL_SENDER_SYSTEM
      }
    }
  };
}

/** The instance's default language as the mail frame reads it. */
function defaultLocaleOf(config: ClientInstanceConfig): LocaleCode {
  const locale = config.localization.defaultLocale;
  return localeCodes.find((code) => code === locale) ?? "en";
}

/** The frame of `workflow-message`: the instance's logo, accent colour and legal footer. */
function mailFrameOf(config: ClientInstanceConfig): MailFrame | undefined {
  const outbound = outboundMailOf(config);
  if (!outbound) return undefined;
  const branding = createClientBranding(config);
  return {
    accentColor: mailAccentColor(branding.accentColor),
    ...(branding.logoUrl
      ? {
          logo: createInlineImageLoader({
            url: branding.logoUrl,
            baseUrl: outbound.appUrl,
            contentId: "logo"
          })
        }
      : {}),
    ...(outbound.outbound.footer ? { footer: outbound.outbound.footer } : {})
  };
}

/**
 * Registers `mail.send` with the system sender, where outbound mail is on and the instance has
 * its mailer. Every process that runs Workflow steps or agents registers it alike.
 */
export function registerInstanceMailSend(
  registry: Pick<OperationRegistry, "register">,
  input: {
    config: ClientInstanceConfig;
    clientInstanceId: ClientInstanceId;
    stores: PlatformStores;
    mail: ChatServerOptions["mail"];
  }
): void {
  const outbound = outboundMailOf(input.config);
  if (!outbound || !input.mail) return;
  registerMailSendOperation(registry, {
    clientInstanceId: input.clientInstanceId,
    stores: input.stores,
    sender: input.mail.sender,
    system: {
      fromAddress: outbound.sender.fromAddress,
      fromName: outbound.sender.fromName ?? input.config.clientInstance.displayName,
      ...(outbound.sender.replyTo ? { replyTo: outbound.sender.replyTo } : {})
    },
    recipientDomains: outbound.outbound.recipientDomains,
    limits: outbound.outbound.limits,
    defaultLocale: defaultLocaleOf(input.config)
  });
}

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
  const frame = mailFrameOf(input.config);
  const identity: MailSenderIdentity = {
    fromAddress: mail.sender.fromAddress,
    fromName: mail.sender.fromName ?? clientInstance.displayName,
    replyTo: mail.sender.replyTo,
    productName: clientInstance.displayName,
    ...(frame ? { frame } : {})
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
