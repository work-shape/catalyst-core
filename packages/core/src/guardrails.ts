import { GUARDRAIL_NAME_MAX_LENGTH, GUARDRAIL_NAME_PATTERN } from "@vivd-catalyst/asset-schemas";
import type { PlatformEventName } from "./events";
import type { ClientInstanceId } from "./ids";
import type { ISODateString } from "./time";

/**
 * A Guardrail is an asset of kind `guardrail`: one check bound to a before-event, with the
 * outcome of a hit. Release config defines them so far; the release seed writes them into the
 * asset store, where Build lists them, and they are read-only in the product. Spec:
 * events-workflows-and-guardrails.md, Guardrails.
 */
export const GUARDRAIL_ASSET_KIND = "guardrail";

/** The rights of the kind. Reading also shows a guardrail's hits. */
export const GUARDRAIL_ACTIONS = {
  read: "guardrail.read",
  write: "guardrail.write",
  delete: "guardrail.delete"
} as const;

export { GUARDRAIL_NAME_MAX_LENGTH, GUARDRAIL_NAME_PATTERN };
export const GUARDRAIL_NAME_RULE =
  "Guardrail name must be lowercase words of letters and digits joined by hyphens or underscores";

/**
 * The before-events a guardrail can be bound to: those the platform runs guardrails at. A
 * guardrail on any other event would never run, so release config refuses it.
 */
export const GUARDRAIL_EVENTS = [
  "approval_request.before_create"
] as const satisfies readonly PlatformEventName[];
export type GuardrailEvent = (typeof GUARDRAIL_EVENTS)[number];

/** What a hit does: `warn` lets the action go on with the reason beside it, `block` stops it. */
export const GUARDRAIL_OUTCOMES = ["warn", "block"] as const;
export type GuardrailOutcome = (typeof GUARDRAIL_OUTCOMES)[number];

/** The kinds of check. `model_judge`: a model reads the content against the instruction. */
export const GUARDRAIL_CHECK_KINDS = ["model_judge"] as const;
export type GuardrailCheckKind = (typeof GUARDRAIL_CHECK_KINDS)[number];

export interface ModelJudgeCheck {
  kind: "model_judge";
  /** The model binding that judges. It answers with no tools. */
  modelBindingId: string;
  /** The rule in the operator's words. The model answers in its language. */
  instruction: string;
}

export type GuardrailCheck = ModelJudgeCheck;

/** Narrows the event. For `approval_request.before_create`, `kind` is the request's kind. */
export interface GuardrailFilter {
  kind?: string;
}

/** One Guardrail as the asset store keeps it. */
export interface GuardrailConfig {
  name: string;
  displayName: string;
  description?: string;
  on: GuardrailEvent;
  filter?: GuardrailFilter;
  check: GuardrailCheck;
  outcome: GuardrailOutcome;
  /** `release`: written by the release seed from release config and read-only in the product. */
  origin: "release";
}

/**
 * One time a guardrail warned or blocked. It names who acted and what kind of thing was
 * checked, never the content: the reason is the guardrail's one sentence.
 */
export interface GuardrailHit {
  id: string;
  guardrailName: string;
  event: GuardrailEvent;
  outcome: GuardrailOutcome;
  /** The guardrail's reason. Empty where the check could not run and the guardrail warns. */
  message: string;
  /** What was checked: for `approval_request.before_create` the kind of the request. */
  subjectKind: string;
  actor: { id: string; displayLabel: string };
  createdAt: ISODateString;
}

export type NewGuardrailHit = Omit<GuardrailHit, "id" | "createdAt">;

/** The only code that reads or writes the hits of guardrails. */
export interface GuardrailStore {
  /** Takes the lock of the release seed for this instance until the surrounding transaction ends. */
  lockReleaseSeed(input: { clientInstanceId: ClientInstanceId }): Promise<void>;
  recordHits(input: {
    clientInstanceId: ClientInstanceId;
    hits: readonly NewGuardrailHit[];
  }): Promise<void>;
  /** The newest hits of one guardrail, newest first. */
  listHits(input: {
    clientInstanceId: ClientInstanceId;
    guardrailName: string;
    limit: number;
  }): Promise<GuardrailHit[]>;
  /** Deletes the hits older than the audit retention. Answers how many it deleted. */
  deleteHitsOlderThan(input: { clientInstanceId: ClientInstanceId; days: number }): Promise<number>;
}

/** The reason of the refusal of every write of a Guardrail through the asset operations. */
export const GUARDRAIL_READ_ONLY_REASON = "guardrail_release_config_only";
