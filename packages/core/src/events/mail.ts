import {
  MAIL_AUDIT_MAX_DOMAINS,
  MAIL_SEND_REFUSAL_REASONS,
  MAIL_SENDER_RESOURCE_KIND
} from "@work-shape/catalyst-asset-schemas";
import type { PlatformEventDefinition } from "./definition";

export const mailEvents = {
  // A mail `mail.send` handed to its provider (MAIL-SEND). The subject is the sender. Counts
  // and domains only: no address, display name of a recipient, subject or body. `outcome` is
  // `uncertain` where the answer was lost after the request left (`operation_interrupted`).
  // `origin` is the Workflow run or the conversation the call came from.
  "mail.sent": {
    name: "mail.sent",
    subject: MAIL_SENDER_RESOURCE_KIND,
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: [
        "operationRunId",
        "origin",
        "sender",
        "target",
        "recipients",
        "skipped",
        "domains",
        "moreDomains",
        "attachments",
        "outcome"
      ],
      properties: {
        operationRunId: { type: "string" },
        origin: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "id"],
          properties: {
            kind: { enum: ["workflow_run", "conversation"] },
            id: { type: "string" }
          }
        },
        sender: { type: "string" },
        target: { enum: ["live", "test"] },
        recipients: {
          type: "object",
          additionalProperties: false,
          required: ["to", "cc", "bcc"],
          properties: {
            to: { type: "integer", minimum: 0 },
            cc: { type: "integer", minimum: 0 },
            bcc: { type: "integer", minimum: 0 }
          }
        },
        skipped: { type: "integer", minimum: 0 },
        domains: { type: "array", items: { type: "string" }, maxItems: MAIL_AUDIT_MAX_DOMAINS },
        moreDomains: { type: "integer", minimum: 0 },
        attachments: {
          type: "object",
          additionalProperties: false,
          required: ["count", "bytes"],
          properties: {
            count: { type: "integer", minimum: 0 },
            bytes: { type: "integer", minimum: 0 }
          }
        },
        outcome: { enum: ["accepted", "uncertain"] }
      }
    }
  },
  // A mail `mail.send` sent to nobody: the reason, and for `recipient_not_allowed` the one
  // refused domain. Never an address, the subject, the body or the provider's text.
  "mail.refused": {
    name: "mail.refused",
    subject: MAIL_SENDER_RESOURCE_KIND,
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["operationRunId", "origin", "sender", "target", "reason"],
      properties: {
        operationRunId: { type: "string" },
        origin: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "id"],
          properties: {
            kind: { enum: ["workflow_run", "conversation"] },
            id: { type: "string" }
          }
        },
        sender: { type: "string" },
        target: { enum: ["live", "test", "dry_run"] },
        reason: { enum: [...MAIL_SEND_REFUSAL_REASONS] },
        domain: { type: "string" }
      }
    }
  }
} as const satisfies Record<string, PlatformEventDefinition>;
