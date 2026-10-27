import {
  GUARDRAIL_NAME_MAX_LENGTH,
  GUARDRAIL_NAME_PATTERN,
  GUARDRAIL_OUTCOMES,
  OPERATION_ORIGIN_KINDS
} from "@work-shape/catalyst-asset-schemas";
import type { AssetScope } from "./asset-kinds";
import type { GuardrailEvent } from "./guardrail-events";
import type { ClientInstanceId } from "./ids";
import type { OperationOrigin } from "./operations";
import type { ISODateString } from "./time";

/**
 * A Guardrail is an asset of kind `guardrail`: one check bound to a before-event, with the
 * outcome of a hit. Release config defines the operator's floor, which the release seed writes
 * into the asset store as published and read-only. Builders write further guardrails as
 * drafts, owned by the instance or one workspace, and a holder of `guardrail.publish` at that
 * scope makes them enforce. Spec: events-workflows-and-guardrails.md, Guardrails.
 */
export const GUARDRAIL_ASSET_KIND = "guardrail";

/**
 * The rights of the kind. Reading also shows a guardrail's hits; writing edits and tests the
 * draft; publishing makes it enforce at its scope, which no workspace bundle carries.
 */
export const GUARDRAIL_ACTIONS = {
  read: "guardrail.read",
  write: "guardrail.write",
  publish: "guardrail.publish",
  delete: "guardrail.delete"
} as const;

/**
 * Where a guardrail comes from. `release`: the operator's floor, from release config, written
 * by the release seed and read-only in the product. `asset`: written as an asset and made live
 * by a publish; it adds checks to the floor and never removes one.
 */
export const GUARDRAIL_ORIGINS = ["release", "asset"] as const;
export type GuardrailOrigin = (typeof GUARDRAIL_ORIGINS)[number];

export * from "./guardrail-events";
export { GUARDRAIL_NAME_MAX_LENGTH, GUARDRAIL_NAME_PATTERN };
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
  "agent.before_publish": ["name", "content"],
  "workflow.before_publish": ["name", "content"],
  "data_store.before_publish": ["name", "content"],
  "form_page.before_publish": ["name", "content"],
  "approval_request.before_create": ["summary", "newContent"]
} as const satisfies Record<GuardrailEvent, readonly string[]>;

/**
 * What a filter can narrow each event by. `kind` is the asset kind of a write or the kind of a
 * request; `operation` an operation's name, or a prefix ending in `.*`; `origin` where the
 * call came from, such as `agent` or `cli`; `agent` the name of the agent that acts;
 * `workspace` the id of the Collaboration Workspace the action happens in.
 */
export const GUARDRAIL_FILTER_KEYS = {
  "asset.before_write": ["kind", "origin", "agent", "workspace"],
  "operation.before_call": ["operation", "origin", "agent", "workspace"],
  "app.before_publish": ["origin", "agent", "workspace"],
  "agent.before_publish": ["origin", "agent", "workspace"],
  "workflow.before_publish": ["origin", "agent", "workspace"],
  "data_store.before_publish": ["origin", "agent", "workspace"],
  "form_page.before_publish": ["origin", "agent", "workspace"],
  "approval_request.before_create": ["kind"]
} as const satisfies Record<GuardrailEvent, readonly (keyof GuardrailFilter)[]>;

/** Where a call can come from, as a filter's `origin` names it. */
export const GUARDRAIL_FILTER_ORIGINS =
  OPERATION_ORIGIN_KINDS satisfies readonly OperationOrigin["kind"][];

/**
 * What a hit does. `allow` lets the action go on and never overrides another guardrail's
 * answer; `warn` lets it go on with the reason beside it; `require_approval` makes a call wait
 * for another person's approval; `block` stops it. Strictest last.
 */
export { GUARDRAIL_OUTCOMES } from "@work-shape/catalyst-asset-schemas";
export type GuardrailOutcome = (typeof GUARDRAIL_OUTCOMES)[number];

/**
 * The events where something can wait for an approval: a call of an operation, which an
 * asset write and the publish of an App, a Workflow, a Data Store or a form page are too. A request for an approval
 * cannot wait for another.
 */
export const GUARDRAIL_APPROVAL_EVENTS = [
  "asset.before_write",
  "operation.before_call",
  "app.before_publish",
  "agent.before_publish",
  "workflow.before_publish",
  "data_store.before_publish",
  "form_page.before_publish"
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
  workspace?: string;
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
  /**
   * `release`: the operator's floor, set in release config. `asset`: a published guardrail.
   * `shipped`: a guardrail of the release that an instance admin can switch off.
   */
  origin: GuardrailOrigin | "shipped";
  /** Who the guardrail of an `asset` answer belongs to: the instance or one workspace. */
  scope?: AssetScope;
  /** The published revision of an `asset` answer. */
  revision?: number;
  /**
   * Set on a `block` that answers a `require_approval` where the action cannot wait for an
   * approval (`PlatformEventContext.cannotWait`).
   */
  approvalCannotWait?: true;
  /**
   * Set on the `block` of a check that could not answer: it threw or did not answer in time
   * (`refusingWhenUnavailable`). A refusal names the reason `check_unavailable`.
   */
  unavailable?: true;
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
  /**
   * `release`: written by the release seed from release config and read-only in the product.
   * `asset`: written as an asset, enforced once published.
   */
  origin: GuardrailOrigin;
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

/**
 * One recent action a dry run checks again: a write or a publish of one revision of an asset.
 * The actor key counts people and is never answered to a caller.
 */
export interface GuardrailDryRunSubject {
  kind: string;
  name: string;
  assetId: string;
  revision: number;
  /** Who acted, as a key to count distinct people by. Absent where the store kept nobody. */
  actorKey?: string;
  /** The workspace that owns the asset, where one does. */
  workspaceId?: string;
}

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
  /**
   * The writes or the publishes of asset revisions since a time, newest first, at most
   * `limit`, with how many there were. A write is a revision written, a delete is none; a
   * publish is an audited publish of an App, a Workflow or a Data Store.
   */
  listRecentSubjects(input: {
    clientInstanceId: ClientInstanceId;
    action: "write" | "publish";
    since: Date;
    /** Only these kinds. */
    kinds?: readonly string[];
    /** Never these kinds. */
    excludeKinds?: readonly string[];
    /** Only the assets this workspace owns. */
    workspaceId?: string;
    limit: number;
  }): Promise<{ subjects: GuardrailDryRunSubject[]; total: number }>;
  /**
   * How many recent calls of operations, or requests for an approval, there were since a
   * time: the actions whose content is not kept, which a dry run counts and cannot check.
   */
  countRecentActions(input: {
    clientInstanceId: ClientInstanceId;
    action: "operation_call" | "approval_request";
    since: Date;
    /** An operation's name, or a prefix ending in `.*`. */
    operation?: string;
    /** The origin kind of a call. */
    origin?: string;
    /** The kind of a request. */
    kind?: string;
    workspaceId?: string;
  }): Promise<number>;
  /** The shipped guardrails somebody switched, with who did it last. A missing one is on. */
  listShippedGuardrailSwitches(input: {
    clientInstanceId: ClientInstanceId;
  }): Promise<ShippedGuardrailSwitch[]>;
  /** Switches one shipped guardrail on or off. */
  switchShippedGuardrail(
    input: { clientInstanceId: ClientInstanceId } & ShippedGuardrailSwitch
  ): Promise<ShippedGuardrailSwitch>;
  /** Deletes the hits older than the audit retention. Answers how many it deleted. */
  deleteHitsOlderThan(input: { clientInstanceId: ClientInstanceId; days: number }): Promise<number>;
}

/**
 * A guardrail the release ships beside the operator's floor. It is on on every instance until a
 * holder of `guardrail.publish` at instance scope switches it off, and a release never switches
 * it back on. Its content is the release's and is not edited. Unlike a guardrail a person
 * writes, it may be bound to several events, and it has no check: it answers its outcome at
 * every event it is bound to. Spec: events-workflows-and-guardrails.md, Publishing needs a
 * person's click.
 */
export interface ShippedGuardrail {
  name: string;
  displayName: string;
  /** What a person it stops or holds is told. */
  reason: string;
  on: readonly GuardrailEvent[];
  /**
   * The events of `on` where it answers only for an asset a workspace owns, which the event's
   * subject names (`GuardrailSubject.workspaceId`): an instance-owned agent's publish is not
   * held by default (WS-PUB-1b).
   */
  workspaceOwnedOnly?: readonly GuardrailEvent[];
  outcome: GuardrailOutcome;
}

/**
 * Every publish of an App or a Workflow, and of an agent a workspace owns, waits for an
 * approval, which a holder of the kind's `approve` right gives with their own Publish (GR-PUB-1,
 * WS-PUB-1b).
 */
export const PUBLISH_APPROVAL_GUARDRAIL = {
  name: "publishing-needs-approval",
  displayName: "Publishing needs an instance admin's approval",
  reason:
    "A new revision of an App, a Workflow or a workspace's agent goes live once an instance admin approved it.",
  on: ["app.before_publish", "workflow.before_publish", "agent.before_publish"],
  workspaceOwnedOnly: ["agent.before_publish"],
  outcome: "require_approval"
} as const satisfies ShippedGuardrail;

export const SHIPPED_GUARDRAILS: readonly ShippedGuardrail[] = [PUBLISH_APPROVAL_GUARDRAIL];

export function shippedGuardrail(name: string): ShippedGuardrail | undefined {
  return SHIPPED_GUARDRAILS.find((guardrail) => guardrail.name === name);
}

/** Who switched a shipped guardrail last, and to what. Nobody has: it is on. */
export interface ShippedGuardrailSwitch {
  name: string;
  enabled: boolean;
  switchedBy: { id: string; label: string };
  switchedAt: ISODateString;
}

/** The reason of the refusal of every write of a release Guardrail through the asset operations. */
export const GUARDRAIL_READ_ONLY_REASON = "guardrail_release_config_only";
