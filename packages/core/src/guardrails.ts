import { GUARDRAIL_NAME_MAX_LENGTH, GUARDRAIL_NAME_PATTERN } from "@vivd-catalyst/asset-schemas";
import type { GuardrailEvent } from "./guardrail-events";
import type { ClientInstanceId } from "./ids";
import type { OperationOrigin } from "./operations";
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
export * from "./guardrail-events";
export const GUARDRAIL_NAME_RULE =
  "Guardrail name must be lowercase words of letters and digits joined by hyphens or underscores";

/**
 * The fields each event hands its guardrails to read, never stored: the asset's name and the
 * text of its files, the input of a call as JSON, the summary and new content of a request. A
 * check reads all of its event's fields unless it names some.
 */
export const GUARDRAIL_CHECKABLE_FIELDS = {
  "asset.before_write": ["name", "content"],
  "operation.before_call": ["input"],
  "app.before_publish": ["name", "content"],
  "workflow.before_publish": ["name", "content"],
  "data_store.before_publish": ["name", "content"],
  "approval_request.before_create": ["summary", "newContent"]
} as const satisfies Record<GuardrailEvent, readonly string[]>;

/**
 * What a filter can narrow each event by. `kind` is the asset kind of a write or the kind of a
 * request; `operation` an operation's name, or a prefix ending in `.*`; `origin` where the
 * call came from, such as `agent` or `cli`; `agent` the name of the agent that acts.
 */
export const GUARDRAIL_FILTER_KEYS = {
  "asset.before_write": ["kind", "origin", "agent"],
  "operation.before_call": ["operation", "origin", "agent"],
  "app.before_publish": ["origin", "agent"],
  "workflow.before_publish": ["origin", "agent"],
  "data_store.before_publish": ["origin", "agent"],
  "approval_request.before_create": ["kind"]
} as const satisfies Record<GuardrailEvent, readonly (keyof GuardrailFilter)[]>;

/** Where a call can come from, as a filter's `origin` names it. */
export const GUARDRAIL_FILTER_ORIGINS = [
  "agent",
  "user",
  "cli",
  "mcp",
  "app",
  "workflow",
  "schedule"
] as const satisfies readonly OperationOrigin["kind"][];

/**
 * What a hit does. `allow` lets the action go on and never overrides another guardrail's
 * answer; `warn` lets it go on with the reason beside it; `require_approval` makes a call wait
 * for another person's approval; `block` stops it. Strictest last.
 */
export const GUARDRAIL_OUTCOMES = ["allow", "warn", "require_approval", "block"] as const;
export type GuardrailOutcome = (typeof GUARDRAIL_OUTCOMES)[number];

/**
 * The events where something can wait for an approval: a call of an operation, which an
 * asset write and the publish of an App, a Workflow or a Data Store are too. A request for an approval
 * cannot wait for another.
 */
export const GUARDRAIL_APPROVAL_EVENTS = [
  "asset.before_write",
  "operation.before_call",
  "app.before_publish",
  "workflow.before_publish",
  "data_store.before_publish"
] as const satisfies readonly GuardrailEvent[];

/**
 * The kinds of check. `pattern`: an RE2 expression over the event's fields, linear in their
 * length. `model_judge`: a model reads the content against the instruction. Patterns run first
 * and a block among them skips the judges.
 */
export const GUARDRAIL_CHECK_KINDS = ["pattern", "model_judge"] as const;
export type GuardrailCheckKind = (typeof GUARDRAIL_CHECK_KINDS)[number];

export interface ModelJudgeCheck {
  kind: "model_judge";
  /** The model binding that judges. It answers with no tools. */
  modelBindingId: string;
  /** The rule in the operator's words. The model answers in its language. */
  instruction: string;
  /** The event's fields the judge reads. All of them where absent. */
  fields?: string[];
}

export interface PatternCheck {
  kind: "pattern";
  /** An RE2 expression: no backreferences and no lookaround. `(?i)` ignores case. */
  pattern: string;
  /** The event's fields matched. All of them where absent. */
  fields?: string[];
  /** The reason a person is told on a match, in the operator's words. It never quotes the match. */
  reason?: string;
}

export type GuardrailCheck = PatternCheck | ModelJudgeCheck;

/** Narrows the event. Each event takes the keys `GUARDRAIL_FILTER_KEYS` names for it. */
export interface GuardrailFilter {
  kind?: string;
  operation?: string;
  origin?: string;
  agent?: string;
}

/**
 * What one guardrail answered at a before-event. `allow` where its check found nothing or its
 * outcome is `allow`.
 */
export interface GuardrailAnswer {
  guardrailName: string;
  displayName: string;
  outcome: GuardrailOutcome;
  /** The reason in plain language. Empty where it allowed, or where a warning check could not run. */
  reason: string;
  /** `release`: the operator's floor, set in release config. */
  origin: "release";
  /**
   * Set on a `block` that answers a `require_approval` where the action cannot wait for an
   * approval (`PlatformEventContext.cannotWait`).
   */
  approvalCannotWait?: true;
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
 * One time a guardrail warned or blocked: the rule, when, the kind of what was checked and the
 * reason. It names no person and holds no content. Hits are counted by rule and period, never
 * listed by person: monitoring employees needs the works council's co-determination (§87(1)
 * no. 6 BetrVG). Who made a request is in the audit log, under its own access and retention.
 */
export interface GuardrailHit {
  id: string;
  guardrailName: string;
  event: GuardrailEvent;
  outcome: GuardrailHitOutcome;
  /** The guardrail's reason. Empty where the check could not run and the guardrail warns. */
  message: string;
  /** What was checked: the asset kind, `operation`, or the kind of an approval request. */
  subjectKind: string;
  /** The asset's id, where the subject has one. Never a run's, which names a person. */
  subjectId?: string;
  /** The asset's or the operation's name, where the subject has one. */
  subjectName?: string;
  /**
   * The outcome the guardrail answered, where the action could not wait for an approval and
   * the hit is the `block` it was answered as (`GuardrailAnswer.approvalCannotWait`).
   */
  convertedFrom?: "require_approval";
  createdAt: ISODateString;
}

/** What a hit kept: a guardrail that allows leaves none. */
export type GuardrailHitOutcome = Exclude<GuardrailOutcome, "allow">;

/** How often one guardrail warned or blocked in the last 7 and the last 30 days. */
export interface GuardrailHitCounts {
  last7Days: number;
  last30Days: number;
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
  /** How often one guardrail warned or blocked, by period, by the database's clock. */
  countHits(input: {
    clientInstanceId: ClientInstanceId;
    guardrailName: string;
  }): Promise<GuardrailHitCounts>;
  /** Deletes the hits older than the audit retention. Answers how many it deleted. */
  deleteHitsOlderThan(input: { clientInstanceId: ClientInstanceId; days: number }): Promise<number>;
}

/** The reason of the refusal of every write of a Guardrail through the asset operations. */
export const GUARDRAIL_READ_ONLY_REASON = "guardrail_release_config_only";
