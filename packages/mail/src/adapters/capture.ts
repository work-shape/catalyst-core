import { z } from "zod";
import { defineProvider } from "@vivd-catalyst/core";
import type { MailProviderInstance } from "../types";
import { CaptureMailTransport } from "./capture-transport";

/** Keeps mails in memory. Config validation refuses it outside development. */
export const captureMailProvider = defineProvider({
  port: "mail",
  type: "capture",
  configSchema: z.object({}),
  external: false,
  create(): MailProviderInstance {
    const transport = new CaptureMailTransport();
    return { transport, listCaptured: () => transport.list() };
  },
  // It keeps mails in the process: there is nothing to reach.
  async check() {
    return { ok: true };
  },
  describe() {
    return {};
  }
});
