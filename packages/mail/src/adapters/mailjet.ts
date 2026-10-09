import { z } from "zod";
import { defineProvider, secretRef } from "@vivd-catalyst/core";
import type { MailProviderInstance } from "../types";
import { MailjetTransport } from "./mailjet-transport";

const mailjetConfigSchema = z.object({
  apiKeySecret: secretRef().default("MAILJET_API_KEY"),
  apiSecretSecret: secretRef().default("MAILJET_API_SECRET")
});

export const mailjetMailProvider = defineProvider({
  port: "mail",
  type: "mailjet",
  configSchema: mailjetConfigSchema,
  external: true,
  async create(config, { secrets }): Promise<MailProviderInstance> {
    return {
      transport: new MailjetTransport({
        apiKey: await secrets.resolve(config.apiKeySecret),
        apiSecret: await secrets.resolve(config.apiSecretSecret)
      })
    };
  },
  describe() {
    return { endpointHost: "api.mailjet.com" };
  }
});
