import type { ProviderDefinition } from "@vivd-catalyst/core";
import { captureMailProvider } from "./adapters/capture";
import { mailjetMailProvider } from "./adapters/mailjet";
import type { MailProviderInstance } from "./types";

export { CaptureMailTransport } from "./adapters/capture-transport";
export { MailjetTransport, type MailjetTransportOptions } from "./adapters/mailjet-transport";

/** Every mail adapter of this package. The only file that imports them. */
export const mailProviderDefinitions: readonly ProviderDefinition<"mail", MailProviderInstance>[] =
  [mailjetMailProvider, captureMailProvider];
