import type { AuditActor, AuditEvent } from "./audit";
import type { ISODateString } from "./time";

/**
 * Audit projection turns the raw, append-only `AuditEvent` evidence stream into
 * a curated activity timeline for the admin UI.
 *
 * The raw events stay the source of truth (and are still served verbatim from
 * `/api/audit-events`). This layer groups the events of one request together,
 * gives them domain labels, resolves who really acted, and hides runtime
 * lifecycle noise unless something failed. It is a pure function so it can be
 * unit tested and run either on the server or the client.
 */

export type AuditActivityActorKind = "user" | "assistant" | "service" | "system";

/**
 * Tier drives the default visibility of an activity.
 * - governance: admin / identity / retention actions — always shown
 * - workflow: conversations and model turns — always shown
 * - runtime: tool and workspace-command lifecycle — evidence only, unless failed
 * - telemetry: recovery / projection bookkeeping — hidden unless failed
 */
export type AuditActivityTier = "governance" | "workflow" | "runtime" | "telemetry";

export type AuditActivityOutcome = "success" | "failed" | "denied" | "warning";

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
  label: string;
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

const ACTIVITY_LABELS: Record<string, string> = {
  "auth.session_token_issued": "Signed in",
  "conversation.created": "Started a conversation",
  "conversation.deleted": "Deleted a conversation",
  "conversation.retention_expired": "Conversation retention expired",
  "conversation.retention_expiration_failed": "Conversation retention failed",
  "conversation.title_generated": "Generated a conversation title",
  "conversation.title_generation_failed": "Conversation title generation failed",
  "message.created": "Sent a message",
  "message.completed": "Assistant responded",
  "message.failed": "Assistant response failed",
  "message.cancelled": "Cancelled a response",
  "tool.authorization_checked": "Checked tool authorization",
  "tool.started": "Started a tool",
  "tool.completed": "Ran a tool",
  "tool.failed": "Tool failed",
  "workspace_command.queued": "Queued a workspace command",
  "workspace_command.running": "Ran a workspace command",
  "workspace_command.completed": "Workspace command completed",
  "workspace_command.failed": "Workspace command failed",
  "workspace_command.timed_out": "Workspace command timed out",
  "workspace_command.cancelled": "Workspace command cancelled",
  "workspace_command.recovered_stale": "Recovered a stale workspace command",
  "governance.audit_events_viewed": "Viewed the audit log",
  "governance.users_viewed": "Viewed users",
  "governance.usage_viewed": "Viewed usage",
  "governance.user_create_authorized": "Authorized creating a user",
  "governance.user_update_authorized": "Authorized updating a user",
  "governance.user_identity_upsert_authorized": "Authorized a user identity change",
  "governance.user_identity_delete_authorized": "Authorized removing a user identity",
  "governance.user_password_reset_authorized": "Authorized a password reset",
  "user.created": "Created a user",
  "user.updated": "Updated a user",
  "user.profile_updated": "Updated a profile",
  "user.identity_linked": "Linked a user identity",
  "user.identity_upserted": "Updated a user identity",
  "user.identity_deleted": "Removed a user identity",
  "user.password_changed": "Changed a password",
  "user.password_reset": "Reset a password",
  "user.password_sign_in_created": "Created sign-in credentials",
  "agent_run.recovered": "Recovered an agent run",
  "agent_runtime.run_failed": "Agent run failed",
  "model_context_projection.file_unavailable": "Referenced file unavailable",
  "model_context_projection.artifact_unavailable": "Referenced artifact unavailable",
  "model_context_projection.bounded_tool_output": "Bounded a large tool output"
};

/** Domain labels for workspace/document tool actions reported via `auditSummary`. */
const TOOL_ACTION_LABELS: Record<string, string> = {
  "workspace.exec": "Ran a command",
  "workspace.list_files": "Listed workspace files",
  "workspace.read_file": "Read a workspace file",
  "workspace.import_files": "Imported files",
  "workspace.promote_artifact": "Saved an artifact",
  "workspace.preview_images": "Loaded artifact preview images",
  "workspace.file": "Wrote a workspace file"
};

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
    type === "conversation.deleted" ||
    type.startsWith("conversation.retention")
  ) {
    return "governance";
  }
  if (type.startsWith("message.") || type.startsWith("conversation.")) {
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
  if (type.startsWith("conversation.")) return 85;
  if (type === "message.completed" || type === "message.failed" || type === "message.cancelled") {
    return 80;
  }
  if (type === "message.created") return 75;
  if (type.startsWith("workspace.")) return 40;
  if (type.startsWith("tool.")) return 38;
  if (type.startsWith("workspace_command.")) return 35;
  return 10;
}

function metadataString(event: AuditEvent, key: string): string | undefined {
  const value = event.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function labelForEvent(event: AuditEvent): string {
  if (event.type.startsWith("tool.")) {
    const action = metadataString(event, "auditAction");
    const actionLabel = action ? TOOL_ACTION_LABELS[action] : undefined;
    if (actionLabel) {
      return actionLabel;
    }
  }
  return ACTIVITY_LABELS[event.type] ?? event.type;
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
  if (type.startsWith("user.") || type.startsWith("governance.user_")) {
    return subject ? { kind: "user", id: subject } : undefined;
  }
  if (type.startsWith("tool.")) {
    const auditSubject = metadataString(event, "auditSubject");
    const id = auditSubject ?? subject;
    return id ? { kind: "tool", id, label: subject } : undefined;
  }
  if (type.startsWith("workspace_command.")) {
    return subject ? { kind: "command", id: subject } : undefined;
  }
  return undefined;
}

function aggregateOutcome(headline: AuditEvent, events: AuditEvent[]): AuditActivityOutcome {
  if (headline.status === "denied") return "denied";
  if (headline.status === "failed") return "failed";
  if (events.some((event) => event.status === "denied")) return "denied";
  if (events.some((event) => event.status === "failed")) return "warning";
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

interface BuiltActivity {
  activity: AuditActivity;
  headlineType: string;
  actorKey: string;
}

function buildActivity(events: AuditEvent[]): BuiltActivity {
  const ascending = [...events].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const headline = pickHeadline(ascending);
  const actorSource = headline.actor ? headline : ascending.find((event) => event.actor);
  const actor = resolveActor(actorSource?.actor);
  const target = resolveTarget(headline) ?? ascending.map(resolveTarget).find(Boolean);
  const reason = reasonForEvent(headline) ?? ascending.map(reasonForEvent).find(Boolean);
  const at = ascending[ascending.length - 1]!.createdAt;

  return {
    activity: {
      correlationId: headline.correlationId,
      at,
      label: labelForEvent(headline),
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

    if (isRepeat) {
      const last = result[result.length - 1]!;
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
    activity.tier === "governance" ||
    activity.tier === "workflow" ||
    activity.outcome !== "success"
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
