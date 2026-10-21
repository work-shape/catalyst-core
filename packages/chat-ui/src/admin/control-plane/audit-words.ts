import type { AuditActivityTarget, AuditEvent } from "@work-shape/catalyst-api-client";
import type { TranslationContextValue } from "../../shared/i18n";
import { audit } from "../../shared/i18n/audit";

// The audit log in the product's words (UXA-1b2): the server sends event types, a tool's
// action, target kinds and reason codes, and the catalogs say them. One without words is said
// by a generic line, never shown as sent.

type Translate = TranslationContextValue["t"];
type AuditKey = keyof (typeof audit)["en"];

function isAuditKey(key: string): key is AuditKey {
  return Object.hasOwn(audit.en, key);
}

function keyFor(key: string): AuditKey | undefined {
  return isAuditKey(key) ? key : undefined;
}

/** What happened: the tool's own action where it has words, else the event type's. */
export function auditEventText(type: string, action: string | undefined, t: Translate): string {
  const key =
    (action ? keyFor(`audit.action.${action}`) : undefined) ?? keyFor(`audit.event.${type}`);
  return t(key ?? "audit.eventOther");
}

/** The action a tool's event names, as the activity carries it for its titling event. */
export function auditEventAction(event: AuditEvent): string | undefined {
  if (!event.type.startsWith("tool.") && !event.type.startsWith("operation.")) return undefined;
  const action = event.metadata?.auditAction;
  return typeof action === "string" ? action : undefined;
}

/** Why it was refused or failed. Codes are matched in lower case (`FORBIDDEN`, `forbidden`). */
export function auditReasonText(reason: string, t: Translate): string {
  return t(keyFor(`audit.reason.${reason.toLowerCase()}`) ?? "audit.reasonOther");
}

/** The reason an event carries: its own, else the `reason` or `code` of its metadata. */
export function auditEventReason(event: AuditEvent): string | undefined {
  if (event.reason) return event.reason;
  for (const key of ["reason", "code"]) {
    const value = event.metadata?.[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/** What the activity is about: its kind in words, then its name; a kind without words is left out. */
export function auditTargetText(target: AuditActivityTarget, t: Translate): string {
  const name = target.label ?? target.id;
  const key = keyFor(`audit.target.${target.kind}`);
  return key ? `${t(key)}: ${name}` : name;
}
