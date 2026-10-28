import type { LocalizedStringConfig } from "./config";
import type { JsonObject } from "./json";

// The before-events guardrails answer at and what an operation hands them, apart from the rest
// of the kind so that a call's and a tool's context can name them.

/**
 * The before-events a guardrail can be bound to: those the platform runs guardrails at. A
 * guardrail on any other event would never run, so release config refuses it. Each is an
 * event of the registry, `events.ts`, which its test holds.
 */
export const GUARDRAIL_EVENTS = [
  "asset.before_write",
  "operation.before_call",
  "app.before_publish",
  "agent.before_publish",
  "skill.before_publish",
  "workflow.before_publish",
  "data_store.before_publish",
  "form_page.before_publish",
  "approval_request.before_create"
] as const;
export type GuardrailEvent = (typeof GUARDRAIL_EVENTS)[number];

export function isGuardrailEvent(name: string): name is GuardrailEvent {
  return GUARDRAIL_EVENTS.some((event) => event === name);
}

/** What a before-event is about, as a hit names it. Never content and never a person. */
export interface GuardrailSubject {
  /** The asset kind, `operation`, or the kind of an approval request. */
  kind: string;
  /** The asset's id, where there is one. Never a run's, which names the person who acted. */
  id?: string;
  /** The asset's name or the operation's. */
  name?: string;
  /** The authored display title, used in a refusal rather than the internal name. */
  title?: LocalizedStringConfig;
  /**
   * The workspace that owns the asset, where one does. Read by a shipped guardrail bound to an
   * event for a workspace's assets only, never by a filter.
   */
  workspaceId?: string;
}

/**
 * One before-event of a call about one of its subjects, beside its own `operation.before_call`:
 * an asset it writes, an App or a Workflow it makes live, or the operation it calls in turn, as
 * an App's action calls a Data Store's insert. A filter's `kind` is the subject's, its
 * `operation` the name of the operation called in turn.
 */
export interface OperationBeforeEvent {
  name: Exclude<GuardrailEvent, "approval_request.before_create">;
  subject: GuardrailSubject;
  /** The event's checkable fields, read only where a guardrail applies and never kept. */
  checkable(): GuardrailFields | Promise<GuardrailFields>;
  /**
   * What the call's input gains where it is held for an approval, so the call the approval
   * answers reads what the approval was asked about, such as the revision of a Page it copies:
   * the one this event's guardrails read, or, where none applied, the one there is when the
   * call is held. Only the keys the operation declares in `heldInputKeys` are kept.
   */
  heldInput?(): JsonObject | undefined | Promise<JsonObject | undefined>;
}

/**
 * The fields of a before-event by the names it declares checkable. `null` is a field too large
 * to be read: a guardrail that stops or holds answers on it as on a match, one that warns
 * warns. A field of files that are not all text is read by the kind of check, see
 * `GuardrailFilesField`.
 */
export type GuardrailFields = Partial<Record<string, string | null | GuardrailFilesField>>;

/**
 * A field of files, one of which at least is no text, such as an image. A pattern reads the
 * text files and the printable runs of every other file, as `strings` finds them, so text
 * beside a NUL byte is still found and a photo adds next to nothing. A judge reads the text
 * files and the long printable runs of an image or a font, which a photo has next to none of;
 * `null` where that is more than a check reads. `notJudgeable` where a file is no text and
 * neither an image nor a font: a judge cannot be told what it holds.
 */
export interface GuardrailFilesField {
  pattern: string | null;
  judge: string | null;
  notJudgeable?: true;
}
