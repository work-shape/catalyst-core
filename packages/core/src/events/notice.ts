import { NOTIFY_CHANNELS } from "@work-shape/catalyst-asset-schemas";
import type { PlatformEventDefinition } from "./definition";

export const noticeEvents = {
  // A notice left for people of the instance (NOTIFY-a): counts only, never what it said.
  "notice.mail_delivery": {
    name: "notice.mail_delivery",
    subject: "notice",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["notices", "delivered"],
      properties: {
        notices: { type: "integer", minimum: 0 },
        delivered: { type: "integer", minimum: 0 }
      }
    }
  },
  "notice.sent": {
    name: "notice.sent",
    subject: "notice",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["channels", "addressees", "inactive", "mailsSent", "mailsUnsent"],
      properties: {
        channels: { type: "array", items: { type: "string", enum: [...NOTIFY_CHANNELS] } },
        addressees: { type: "integer", minimum: 0 },
        inactive: { type: "integer", minimum: 0 },
        mailsSent: { type: "integer", minimum: 0 },
        mailsQueued: { type: "integer", minimum: 0 },
        mailsUnsent: { type: "integer", minimum: 0 }
      }
    }
  }
} as const satisfies Record<string, PlatformEventDefinition>;
