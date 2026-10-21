import { AUDIT_ACTOR_KINDS, AUDIT_OUTCOMES, AUDIT_TIERS } from "@work-shape/catalyst-asset-schemas";
import type { AuditActor, AuditEvent } from "./audit";
import type { ISODateString } from "./time";

/**
 * Audit projection turns the raw, append-only `AuditEvent` evidence stream into
 * a curated activity timeline for the admin UI.
 *
 * The raw events stay the source of truth (and are still served verbatim from
 * `/api/v1/instance/audit-events`). This layer groups the events of one request together,
 * picks the event that titles them, resolves who really acted, and hides runtime
 * lifecycle noise unless something failed. It is a pure function so it can be
 * unit tested and run either on the server or the client.
 */

export type AuditActivityActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

/**
 * Tier drives the default visibility of an activity.
 * - governance: admin / identity / retention actions — always shown
 * - workflow: conversations and model turns — always shown
 * - runtime: tool and workspace-command lifecycle — evidence only, unless failed
 * - telemetry: recovery / projection bookkeeping — hidden unless failed
 */
export type AuditActivityTier = (typeof AUDIT_TIERS)[number];

export type AuditActivityOutcome = (typeof AUDIT_OUTCOMES)[number];

export interface AuditActivityActor {
  kind: AuditActivityActorKind;
  label: string;
  /** Set when an assistant/service acted on behalf of a human. */
  onBehalfOf?: string;
  roles?: string[];
}

export interface AuditActivityTarget {
  /** conversation | user | tool | command | workspace | document | ... */
  kind: string;
  id: string;
  label?: string;
}

export interface AuditActivity {
  correlationId: string;
  /** Most recent moment in the group; the timeline sorts on this. */
  at: ISODateString;
  /**
   * The type of the event that titles the activity. The interface says it in words of its own
   * catalogs; the server sends no prose.
   */
  type: string;
  /** What a tool says it did (`workspace.exec`), where the titling event is a tool's. */
  action?: string;
  tier: AuditActivityTier;
  outcome: AuditActivityOutcome;
  actor: AuditActivityActor;
  target?: AuditActivityTarget;
  reason?: string;
  /** Number of raw events folded into this activity. */
  eventCount: number;
  /** How many identical consecutive reads were collapsed (1 = none). */
  repeatCount: number;
  evidence: AuditEvent[];
}

export interface ProjectAuditActivitiesOptions {
  /** "default" hides successful runtime/telemetry noise; "all" keeps everything. */
  view?: "default" | "all";
  /** Cap the number of activities returned after grouping. */
  limit?: number;
}

const GOVERNANCE_READ_TYPES = new Set([
  "governance.audit_events_viewed",
  "governance.users_viewed",
  "governance.usage_viewed"
]);

function tierForType(type: string): AuditActivityTier {
  if (
    type.startsWith("governance.") ||
    type.startsWith("user.") ||
    type.startsWith("auth.") ||
    type.startsWith("audit.") ||
    type.startsWith("collaboration_workspace.") ||
    type === "conversation.deleted" ||
    type.startsWith("conversation.cleanup") ||
    type.startsWith("conversation.retention")
  ) {
    return "governance";
  }
  if (type.startsWith("message.") || type.startsWith("conversation.")) {
    return "workflow";
  }
  if (type.startsWith("feedback.")) {
    return "workflow";
  }
  if (
    type.startsWith("agent_run") ||
    type.startsWith("agent_runtime") ||
    type.startsWith("model_context_projection") ||
    type === "workspace_command.recovered_stale"
  ) {
    return "telemetry";
  }
  return "runtime";
}

/** Higher rank wins the right to title the activity. */
function rankForType(type: string): number {
  if (type.startsWith("governance.")) return 100;
  if (type.startsWith("user.")) return 95;
  if (type.startsWith("auth.")) return 90;
  if (type.startsWith("collaboration_workspace.")) return 88;
  if (type.startsWith("conversation.")) return 85;
  if (type === "message.completed" || type === "message.failed" || type === "message.cancelled") {
    return 80;
  }
  if (type === "message.created") return 75;
  if (type.startsWith("workspace.")) return 40;
  if (type.startsWith("tool.") || type.startsWith("operation.")) return 38;
  if (type.startsWith("workspace_command.")) return 35;
  return 10;
}

function metadataString(event: AuditEvent, key: string): string | undefined {
  const value = event.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

/** What a tool says it did, in a name of its own, whichever of its events carries it. */
function actionForEvent(event: AuditEvent): string | undefined {
  return event.type.startsWith("tool.") || event.type.startsWith("operation.")
    ? metadataString(event, "auditAction")
    : undefined;
}

export function reasonForEvent(event: AuditEvent): string | undefined {
  if (event.reason) {
    return event.reason;
  }
  return metadataString(event, "reason") ?? metadataString(event, "code");
}

function resolveActor(actor: AuditActor | undefined): AuditActivityActor {
  if (!actor) {
    return { kind: "system", label: "System" };
  }
  if (actor.delegatedActor) {
    return {
      kind: "assistant",
      label: actor.delegatedActor.displayLabel ?? "Assistant",
      onBehalfOf: actor.displayLabel,
      roles: actor.roles
    };
  }
  if (actor.principalKind === "service") {
    return {
      kind: "service",
      label: actor.principalDisplayLabel ?? actor.displayLabel ?? "Service",
      roles: actor.roles
    };
  }
  return {
    kind: "user",
    label: actor.displayLabel ?? actor.externalUserId ?? "User",
    roles: actor.roles
  };
}

function resolveTarget(event: AuditEvent): AuditActivityTarget | undefined {
  const { type, subject } = event;
  const conversationId = metadataString(event, "conversationId");

  if (type.startsWith("message.")) {
    const id = conversationId ?? subject;
    return id ? { kind: "conversation", id } : undefined;
  }
  if (type.startsWith("conversation.")) {
    return subject ? { kind: "conversation", id: subject } : undefined;
  }
  if (type.startsWith("collaboration_workspace.")) {
    return subject ? { kind: "collaboration_workspace", id: subject } : undefined;
  }
  if (type.startsWith("user.") || type.startsWith("governance.user_")) {
    return subject ? { kind: "user", id: subject } : undefined;
  }
  // The call of an agent's tool is an operation whose subject is the tool.
  if (
    type.startsWith("tool.") ||
    (type.startsWith("operation.") && metadataString(event, "origin") === "agent")
  ) {
    const auditSubject = metadataString(event, "auditSubject");
    const id = auditSubject ?? subject;
    return id ? { kind: "tool", id, label: subject } : undefined;
  }
  if (type.startsWith("workspace_command.")) {
    return subject ? { kind: "command", id: subject } : undefined;
  }
  return undefined;
}

/**
 * A discovery that stored its catalog and left out an operation that held the Connection's
 * credential. It succeeded, and an operation that was accepted before can be `unknown` after
 * it, so it is shown like a failure and not hidden with the discoveries that went well.
 */
function leftOutForTheCredential(event: AuditEvent): boolean {
  const rejected = event.metadata?.rejectedCount;
  return event.type === "connection.discovered" && typeof rejected === "number" && rejected > 0;
}

function aggregateOutcome(headline: AuditEvent, events: AuditEvent[]): AuditActivityOutcome {
  if (headline.status === "denied") return "denied";
  if (headline.status === "failed") return "failed";
  if (events.some((event) => event.status === "denied")) return "denied";
  if (events.some((event) => event.status === "failed")) return "warning";
  if (leftOutForTheCredential(headline)) return "warning";
  return "success";
}

function pickHeadline(events: AuditEvent[]): AuditEvent {
  return events.reduce((best, candidate) => {
    const bestRank = rankForType(best.type);
    const candidateRank = rankForType(candidate.type);
    if (candidateRank > bestRank) return candidate;
    if (candidateRank === bestRank && candidate.createdAt > best.createdAt) return candidate;
    return best;
  });
}

function withAction(action: string | undefined): { action?: string } {
  return action ? { action } : {};
}

interface BuiltActivity {
  activity: AuditActivity;
  headlineType: string;
  actorKey: string;
}

function buildActivity(events: AuditEvent[]): BuiltActivity {
  const ascending = [...events].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt)
  );
  const headline = pickHeadline(ascending);
  const actorSource = headline.actor ? headline : ascending.find((event) => event.actor);
  const actor = resolveActor(actorSource?.actor);
  const target = resolveTarget(headline) ?? ascending.map(resolveTarget).find(Boolean);
  const reason = reasonForEvent(headline) ?? ascending.map(reasonForEvent).find(Boolean);
  const at = ascending.at(-1)?.createdAt ?? headline.createdAt;

  return {
    activity: {
      correlationId: headline.correlationId,
      at,
      type: headline.type,
      ...withAction(actionForEvent(headline)),
      tier: tierForType(headline.type),
      outcome: aggregateOutcome(headline, ascending),
      actor,
      target,
      reason,
      eventCount: ascending.length,
      repeatCount: 1,
      // Evidence reads newest-first inside the drilldown.
      evidence: [...ascending].reverse()
    },
    headlineType: headline.type,
    actorKey: `${actor.kind}:${actor.label}`
  };
}

/** Collapse consecutive identical governance reads (e.g. repeated audit-log views). */
function collapseRepeatedReads(built: BuiltActivity[]): AuditActivity[] {
  const result: AuditActivity[] = [];
  let previous: BuiltActivity | undefined;

  for (const current of built) {
    const isRepeat =
      previous !== undefined &&
      GOVERNANCE_READ_TYPES.has(current.headlineType) &&
      current.headlineType === previous.headlineType &&
      current.actorKey === previous.actorKey;

    const last = result.at(-1);
    if (isRepeat && last) {
      last.repeatCount += 1;
      last.eventCount += current.activity.eventCount;
      continue;
    }

    result.push(current.activity);
    previous = current;
  }

  return result;
}

function isDefaultVisible(activity: AuditActivity): boolean {
  return (
    activity.tier === "governance" || activity.tier === "workflow" || activity.outcome !== "success"
  );
}

export function projectAuditActivities(
  events: AuditEvent[],
  options: ProjectAuditActivitiesOptions = {}
): AuditActivity[] {
  const view = options.view ?? "default";

  const groups = new Map<string, AuditEvent[]>();
  for (const event of events) {
    const existing = groups.get(event.correlationId);
    if (existing) {
      existing.push(event);
    } else {
      groups.set(event.correlationId, [event]);
    }
  }

  const built = [...groups.values()]
    .map(buildActivity)
    .sort((left, right) => right.activity.at.localeCompare(left.activity.at));

  let activities = collapseRepeatedReads(built);

  if (view === "default") {
    activities = activities.filter(isDefaultVisible);
  }
  if (options.limit !== undefined) {
    activities = activities.slice(0, options.limit);
  }

  return activities;
}
