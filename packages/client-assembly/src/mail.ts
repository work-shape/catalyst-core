import { AppError } from "@vivd-catalyst/core";
import type { ChatServerOptions } from "@vivd-catalyst/chat-server";
import type { ClientInstanceConfig } from "@vivd-catalyst/config-schema";
import {
  CaptureMailTransport,
  MailjetTransport,
  TemplateMailSender,
  type MailSenderIdentity
} from "@vivd-catalyst/mail";
import type { ClientInstanceEnv } from "./env";

export function createClientInstanceMail(input: {
  config: ClientInstanceConfig;
  env: ClientInstanceEnv;
}): ChatServerOptions["mail"] {
  const { mail, clientInstance } = input.config;
  if (!mail.enabled || !mail.sender || !mail.appUrl) {
    return undefined;
  }
  const identity: MailSenderIdentity = {
    fromAddress: mail.sender.fromAddress,
    fromName: mail.sender.fromName ?? clientInstance.displayName,
    replyTo: mail.sender.replyTo,
    productName: clientInstance.displayName
  };

  if (mail.provider === "capture") {
    const transport = new CaptureMailTransport();
    return {
      sender: new TemplateMailSender(transport, identity),
      appUrl: mail.appUrl,
      listCaptured: () => transport.list()
    };
  }

  const apiKey = input.env[mail.apiKeyEnvName];
  const apiSecret = input.env[mail.apiSecretEnvName];
  if (!apiKey || !apiSecret) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Mail is enabled but '${mail.apiKeyEnvName}' or '${mail.apiSecretEnvName}' is not set`
    );
  }
  return {
    sender: new TemplateMailSender(new MailjetTransport({ apiKey, apiSecret }), identity),
    appUrl: mail.appUrl
  };
}
