import type {
  GuardrailAnswer,
  GuardrailSubject,
  OperationCall,
  OperationDefinition,
  OperationDenial,
  PlatformEventAnswer,
  PlatformEventContext,
  PlatformEventName
} from "@vivd-catalyst/core";

// The before-events of a call, asked once its caller's right is known: `operation.before_call`
// with the call's input, the operation's own, and one per subject its `beforeEvents` names.
// What the guardrails at them answered becomes the call's policy or its refusal.

/** What the before-events of a call are asked from: a run's context. */
export interface BeforeEventsOf {
  definition: Pick<OperationDefinition, "name" | "events" | "beforeEvents">;
  call: Pick<OperationCall, "input" | "origin">;
  emit(
    name: PlatformEventName,
    phase: "before",
    payload?: Record<string, never> | { subjectKind: string },
    before?: Pick<PlatformEventContext, "checkable" | "filterBy"> & {
      subject?: PlatformEventContext["subject"];
    }
  ): Promise<PlatformEventAnswer>;
}

/** What one before-event answered, with the subject it asked about where it was not the call. */
type SubjectAnswer = PlatformEventAnswer & { subject?: GuardrailSubject };

/** The answers of the call's before-events, each with what its guardrails may read. */
export async function askBeforeEvents(context: BeforeEventsOf): Promise<SubjectAnswer[]> {
  const { definition, call } = context;
  const answers: SubjectAnswer[] = [
    await context.emit(
      "operation.before_call",
      "before",
      {},
      {
        // The input as JSON: a pattern or a judge reads the arguments of the call. A hit names
        // the operation and not the run, whose actor is a person.
        subject: { kind: "operation", name: definition.name },
        checkable: () => ({ input: JSON.stringify(call.input) ?? "" }),
        filterBy: { operation: definition.name }
      }
    )
  ];
  if (definition.events?.before) {
    answers.push(await context.emit(definition.events.before, "before"));
  }
  for (const event of (await definition.beforeEvents?.(call.input, call.origin)) ?? []) {
    const answer = await context.emit(
      event.name,
      "before",
      { subjectKind: event.subject.kind },
      { subject: event.subject, checkable: event.checkable, filterBy: { kind: event.subject.kind } }
    );
    answers.push({ ...answer, subject: event.subject });
  }
  return answers;
}

/** The refusal a caller reads: which guardrail, about what, and why, never the content. */
function guardrailRefusalMessage(
  refusing: GuardrailAnswer,
  answers: readonly SubjectAnswer[]
): string {
  const subject = answers.find((answer) => answer.guardrails.includes(refusing))?.subject;
  const about = subject?.name ? ` ${subject.kind} '${subject.name}'` : " the call";
  const reason = refusing.reason === "" ? "" : `: ${refusing.reason}`;
  return `Guardrail '${refusing.displayName}' blocked${about}${reason}`;
}

/**
 * The refusal of a call a guardrail stopped. The guardrail that refused names itself and its
 * reason; where only a hold refused a read, which cannot wait, the one that asked for the
 * approval is named. An emitter that names no guardrail leaves the event that asked.
 */
export function guardrailDenial(answers: readonly SubjectAnswer[], event: string): OperationDenial {
  const named = answers.flatMap((answer) => answer.guardrails);
  const refusing =
    named.find((answer) => answer.outcome === "block") ??
    named.find((answer) => answer.outcome !== "allow");
  return refusing
    ? {
        kind: "guardrail",
        guardrailId: refusing.guardrailName,
        message: guardrailRefusalMessage(refusing, answers)
      }
    : { kind: "guardrail", guardrailId: event };
}
