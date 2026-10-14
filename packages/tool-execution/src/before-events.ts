import { PLATFORM_ASSET_TOOLS } from "./platform-asset-tools";
import {
  GUARDRAIL_ASSET_KIND,
  type GuardrailAnswer,
  type GuardrailSubject,
  type OperationBeforeEvent,
  type OperationCall,
  type OperationDefinition,
  type OperationDenial,
  type PlatformEventAnswer,
  type PlatformEventContext,
  type PlatformEventName
} from "@vivd-catalyst/core";

// The before-events of a call, asked once its caller's right is known: `operation.before_call`
// with the call's input, the operation's own, and one per subject its `beforeEvents` names.
// What the guardrails at them answered becomes the call's policy or its refusal.

/** What the before-events of a call are asked from: a run's context. */
export interface BeforeEventsOf {
  definition: Pick<OperationDefinition, "name" | "events" | "beforeEvents" | "inputWithoutSecrets">;
  call: Pick<OperationCall, "input" | "origin">;
  emit(
    name: PlatformEventName,
    phase: "before",
    payload?: Record<string, never> | { subjectKind: string },
    before?: Pick<PlatformEventContext, "checkable" | "filterBy" | "aboutGuardrails"> & {
      subject?: PlatformEventContext["subject"];
    }
  ): Promise<PlatformEventAnswer>;
  /** Told the events of the operation's own `beforeEvents` before they are asked. */
  asked?(events: readonly OperationBeforeEvent[]): void;
}

/** What one before-event answered, with the subject it asked about where it was not the call. */
type SubjectAnswer = PlatformEventAnswer & { subject?: GuardrailSubject };

/** The answers of the call's before-events, each with what its guardrails may read. */
export async function askBeforeEvents(context: BeforeEventsOf): Promise<SubjectAnswer[]> {
  const { definition, call } = context;
  // Read before any is asked: whether the call is about guardrails decides who answers.
  const own = (await definition.beforeEvents?.(call.input, call.origin)) ?? [];
  const about = aboutGuardrails(definition.name, call.input, own)
    ? { aboutGuardrails: true as const }
    : {};
  const answers: SubjectAnswer[] = [
    await context.emit(
      "operation.before_call",
      "before",
      {},
      {
        // The input as JSON: a pattern or a judge reads the arguments of the call, a secret
        // such as a password marked, so it never reaches a judge's model. A hit names the
        // operation and not the run, whose actor is a person.
        subject: { kind: "operation", name: definition.name },
        checkable: () => ({
          input: JSON.stringify(definition.inputWithoutSecrets?.(call.input) ?? call.input) ?? ""
        }),
        filterBy: { operation: definition.name },
        ...about
      }
    )
  ];
  if (definition.events?.before) {
    answers.push(await context.emit(definition.events.before, "before", {}, about));
  }
  context.asked?.(own);
  for (const event of own) {
    const answer = await context.emit(
      event.name,
      "before",
      { subjectKind: event.subject.kind },
      {
        subject: event.subject,
        checkable: event.checkable,
        filterBy:
          event.name === "operation.before_call"
            ? { operation: event.subject.name }
            : { kind: event.subject.kind },
        ...about
      }
    );
    answers.push({ ...answer, subject: event.subject });
  }
  return answers;
}

/**
 * The asset operations that act on, or read, the assets of the kind their input names. Reads
 * are among them, so no published guardrail hides the guardrails from those who change them.
 */
const ASSET_OPERATIONS_OF_A_KIND: ReadonlySet<string> = new Set([
  "assets.list",
  "assets.get",
  "assets.revisions.list",
  "assets.put",
  "assets.delete",
  "assets.revert",
  "assets.publish",
  "assets.discard_draft",
  "assets.validate"
]);

/** The agent's tools that save or check the asset its conversation is about. */
const SUBJECT_ASSET_TOOLS: ReadonlySet<string> = new Set([
  PLATFORM_ASSET_TOOLS.put.name,
  PLATFORM_ASSET_TOOLS.validate.name
]);

/**
 * Whether a call reads, writes, publishes, deletes or tests guardrails and nothing else, decided by
 * the operation and never by the shape of an input another operation takes: an operation of
 * `guardrails.*`; an asset operation on the kind `guardrail`; a sync of guardrails alone; the
 * agent's save or check of the guardrail its conversation is about, whose events say so. A
 * sync that carries another kind beside them is not: its guardrails are its other assets' too.
 */
function aboutGuardrails(
  operation: string,
  input: unknown,
  own: readonly OperationBeforeEvent[]
): boolean {
  if (operation.startsWith("guardrails.")) return true;
  if (SUBJECT_ASSET_TOOLS.has(operation)) {
    return own.length > 0 && own.every((event) => event.subject.kind === GUARDRAIL_ASSET_KIND);
  }
  if (typeof input !== "object" || input === null) return false;
  if (ASSET_OPERATIONS_OF_A_KIND.has(operation)) {
    return "kind" in input && input.kind === GUARDRAIL_ASSET_KIND;
  }
  if (operation === "assets.sync" && "items" in input && Array.isArray(input.items)) {
    const items: unknown[] = input.items;
    return (
      items.length > 0 &&
      items.every(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          "kind" in item &&
          item.kind === GUARDRAIL_ASSET_KIND
      )
    );
  }
  return false;
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
/** A guardrail as a refusal names it. */
export interface GuardrailNamed {
  id: string;
  label: string;
}

/** The guardrail whose `require_approval` asked for an approval, where one did. */
export function approvalAskedBy(answers: readonly SubjectAnswer[]): GuardrailNamed | undefined {
  const asking = answers
    .flatMap((answer) => answer.guardrails)
    .find((answer) => answer.outcome === "require_approval");
  return asking ? { id: asking.guardrailName, label: asking.displayName } : undefined;
}

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
