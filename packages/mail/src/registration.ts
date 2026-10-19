import type { ProviderDefinition } from "@work-shape/catalyst-core";
import { captureMailProvider } from "./adapters/capture";
import { mailjetMailProvider } from "./adapters/mailjet";
import type { MailProviderInstance } from "./types";

export { CaptureMailTransport } from "./adapters/capture-transport";
export { MailjetTransport, type MailjetTransportOptions } from "./adapters/mailjet-transport";
export {
  MAIL_LOGO_MAX_BYTES,
  createInlineImageLoader,
  imageTypeOf,
  type InlineImageLoaderOptions
} from "./adapters/inline-image";

/** Every mail adapter of this package. The only file that imports them. */
export const mailProviderDefinitions: readonly ProviderDefinition<"mail", MailProviderInstance>[] =
  [mailjetMailProvider, captureMailProvider];
