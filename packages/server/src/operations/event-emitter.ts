import {
  AUDIT_EVENT_STATUSES,
  EVENTS,
  PLATFORM_EVENT_ALLOW,
  auditActorFromIdentity,
  getSubjectUserId,
  isAuthenticatedServicePrincipal,
  isGuardrailEvent,
  strictestOutcome,
  NO_BEFORE_ACTION_CHECK,
  type AuditEventStatus,
  type AuditRecorder,
  type BeforeActionCallContext,
  type BeforeActionCheck,
  type BeforeActionMatch,
  type JsonObject,
  type PlatformEventContext,
  type PlatformEventEmitter
} from "@work-shape/catalyst-core";

const AUDIT_STATUSES: readonly AuditEventStatus[] = [...AUDIT_EVENT_STATUSES];

/**
 * The events of a call. At a before-event the checks bound to it answer and the strictest of
 * their answers is the event's; an `allow` never overrides another's warning or block. An
 * audited after-event becomes one audit row. The row holds what the emitter was handed, which
 * is names, ids and codes, never an input or an output: the content a guardrail reads comes
 * through `checkable` and is never kept.
 */
export function createAuditingEventEmitter(
  audit: AuditRecorder,
  checks: Pick<BeforeActionCheck, "answer"> = NO_BEFORE_ACTION_CHECK
): PlatformEventEmitter {
  return {
    async emit(name, payload, context) {
      if (context.phase === "before") {
        if (!isGuardrailEvent(name)) {
          return PLATFORM_EVENT_ALLOW;
        }
        const answers = await checks.answer(
          {
            event: name,
            subject: context.subject,
            match: guardrailMatch(context),
            fields: async () => (await context.checkable?.()) ?? {},
            ...(context.aboutGuardrails ? { aboutProtectedKind: true } : {})
          },
          guardrailCallContext(payload, context)
        );
        return {
          outcome: strictestOutcome(answers.map((answer) => answer.outcome)),
          guardrails: answers
        };
      }
      if (!EVENTS[name].audited) {
        return PLATFORM_EVENT_ALLOW;
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
      return PLATFORM_EVENT_ALLOW;
    }
  };
}

/** Whom a check's model call is counted for: the person, the workspace, the conversation, the run. */
function guardrailCallContext(
  payload: JsonObject,
  context: PlatformEventContext
): BeforeActionCallContext {
  const { actor, origin, runtime } = context;
  const conversationId =
    origin.kind === "agent"
      ? origin.conversationId
      : origin.kind === "app"
        ? origin.conversationId
        : undefined;
  return {
    correlationId: context.correlationId,
    ...(isAuthenticatedServicePrincipal(actor) ? {} : { userId: getSubjectUserId(actor) }),
    ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(typeof payload.operationRunId === "string"
      ? { operationRunId: payload.operationRunId }
      : {}),
    ...(runtime?.deadline ? { deadline: runtime.deadline } : {}),
    ...(runtime?.signal ? { signal: runtime.signal } : {}),
    ...(context.repeated ? { repeated: true } : {}),
    ...(context.cannotWait ? { cannotWait: true } : {})
  };
}

function withoutUndefined(values: Record<string, JsonObject[string] | undefined>): JsonObject {
  return Object.fromEntries(
    Object.entries(values).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]]))
  );
}

/** The same origin and effective workspace narrow live calls and dry publish previews. */
export function guardrailMatch(
  context: Pick<PlatformEventContext, "origin" | "workspaceId" | "filterBy">
): BeforeActionMatch {
  const { origin } = context;
  return {
    ...context.filterBy,
    origin: origin.kind,
    ...(origin.kind === "agent" ? { agent: origin.agentName } : {}),
    ...(context.workspaceId ? { workspace: context.workspaceId } : {})
  };
}
