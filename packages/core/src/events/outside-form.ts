import type { JsonObject } from "../json";
import type { PlatformEventDefinition } from "./definition";

// The events of an outside form a Workflow step mails (ADR-0033). The subject is the step's
// Operation Run. The recipient's domain and the form's size only: no address, name or answer.
const OUTSIDE_FORM_AUDIT = {
  subject: "operation",
  legacy: false,
  audited: true,
  phases: ["after"] as const,
  payload: {
    type: "object",
    additionalProperties: false,
    required: ["recipientDomain", "fields", "pages"],
    properties: {
      recipientDomain: { type: "string" },
      fields: { type: "integer", minimum: 0 },
      pages: { type: "integer", minimum: 1 }
    }
  } satisfies JsonObject
};

export const outsideFormEvents = {
  "outside_form.requested": { ...OUTSIDE_FORM_AUDIT, name: "outside_form.requested" },
  "outside_form.mail_failed": { ...OUTSIDE_FORM_AUDIT, name: "outside_form.mail_failed" }
} satisfies Record<string, PlatformEventDefinition>;
