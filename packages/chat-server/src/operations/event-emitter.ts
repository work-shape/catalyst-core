import {
  EVENTS,
  auditActorFromIdentity,
  type AuditEventStatus,
  type AuditRecorder,
  type JsonObject,
  type PlatformEventEmitter
} from "@vivd-catalyst/core";

const AUDIT_STATUSES: readonly AuditEventStatus[] = ["success", "failed", "denied"];

/**
 * The events of a call until EW-1 supplies emission and guardrails: no guardrail exists, so a
 * before-event allows, and an audited after-event becomes one audit row. The row holds what
 * the emitter was handed, which is names, ids and codes, never an input or an output.
 */
export function createAuditingEventEmitter(audit: AuditRecorder): PlatformEventEmitter {
  return {
    async emit(name, payload, context) {
      if (context.phase === "before" || !EVENTS[name].audited) {
        return "allow";
      }
      const { status, reason, ...metadata } = payload;
      await audit.record({
        type: name,
        status: AUDIT_STATUSES.find((candidate) => candidate === status) ?? "success",
        actor: auditActorFromIdentity(context.actor),
        subject: context.subject.id,
        ...(typeof reason === "string" ? { reason } : {}),
        correlationId: context.correlationId,
        metadata: withoutUndefined({
          ...metadata,
          subjectKind: context.subject.kind,
          origin: context.origin.kind,
          workspaceId: context.workspaceId
        })
      });
      return "allow";
    }
  };
}

function withoutUndefined(values: Record<string, JsonObject[string] | undefined>): JsonObject {
  return Object.fromEntries(
    Object.entries(values).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]]))
  );
}
