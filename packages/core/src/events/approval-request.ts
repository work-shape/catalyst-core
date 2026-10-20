import { LEGACY_AUDIT, type PlatformEventDefinition } from "./definition";

export const approvalRequestEvents = {
  // Guardrails bound to it answer before a request is filed. The subject is the request's kind.
  "approval_request.before_create": {
    name: "approval_request.before_create",
    subject: "approval_request",
    legacy: false,
    audited: false,
    phases: ["before"]
  },
  "approval_request.created": {
    ...LEGACY_AUDIT,
    name: "approval_request.created",
    subject: "approval_request"
  },
  "approval_request.decided": {
    ...LEGACY_AUDIT,
    name: "approval_request.decided",
    subject: "approval_request"
  },
  "approval_request.reverted": {
    ...LEGACY_AUDIT,
    name: "approval_request.reverted",
    subject: "approval_request"
  },
  "approval_request.withdrawn": {
    ...LEGACY_AUDIT,
    name: "approval_request.withdrawn",
    subject: "approval_request"
  }
} as const satisfies Record<string, PlatformEventDefinition>;
