import { GUARDRAIL_OUTCOMES } from "@work-shape/catalyst-asset-schemas";
import { joinEvents, type PlatformEventPhase } from "./events/definition";
import { agentEvents } from "./events/agent";
import { agentRunEvents } from "./events/agent-run";
import { apiAccessEvents } from "./events/api-access";
import { appEvents } from "./events/app";
import { approvalRequestEvents } from "./events/approval-request";
import { assetEvents } from "./events/asset";
import { auditEvents } from "./events/audit";
import { authEvents } from "./events/auth";
import { collaborationWorkspaceEvents } from "./events/collaboration-workspace";
import { configAssetEvents } from "./events/config-asset";
import { connectionEvents } from "./events/connection";
import { conversationEvents } from "./events/conversation";
import { dataStoreEvents } from "./events/data-store";
import { executionWorkspaceEvents } from "./events/execution-workspace";
import { feedbackEvents } from "./events/feedback";
import { governanceEvents } from "./events/governance";
import { guardrailEvents } from "./events/guardrail";
import { jobEvents } from "./events/job";
import { knowledgeBaseEvents } from "./events/knowledge-base";
import { liveOnceEvents } from "./events/live-once";
import { mailEvents } from "./events/mail";
import { messageEvents } from "./events/message";
import { noticeEvents } from "./events/notice";
import { operationEvents } from "./events/operation";
import { permissionEvents } from "./events/permission";
import { roleEvents } from "./events/role";
import { scheduledStartEvents } from "./events/scheduled-start";
import { scopeAssignmentEvents } from "./events/scope-assignment";
import { storageEvents } from "./events/storage";
import { userEvents } from "./events/user";
import { workflowEvents } from "./events/workflow";
import { workflowRunEvents } from "./events/workflow-run";
import { workspaceCommandEvents } from "./events/workspace-command";
import type { GuardrailAnswer, GuardrailFields } from "./guardrails";
import type { JsonObject } from "./json";
import type { OperationCall } from "./operations";

export { joinEvents } from "./events/definition";
export type { PlatformEventDefinition, PlatformEventPhase } from "./events/definition";

// Run observations remain a separate stream from platform events and audit. Each domain
// declares its events in `events/<domain>.ts`; a new domain is one more line here.
export const EVENTS = joinEvents(
  agentEvents,
  agentRunEvents,
  apiAccessEvents,
  appEvents,
  approvalRequestEvents,
  assetEvents,
  auditEvents,
  authEvents,
  collaborationWorkspaceEvents,
  configAssetEvents,
  connectionEvents,
  conversationEvents,
  dataStoreEvents,
  executionWorkspaceEvents,
  feedbackEvents,
  governanceEvents,
  guardrailEvents,
  jobEvents,
  knowledgeBaseEvents,
  liveOnceEvents,
  mailEvents,
  messageEvents,
  noticeEvents,
  operationEvents,
  permissionEvents,
  roleEvents,
  scheduledStartEvents,
  scopeAssignmentEvents,
  storageEvents,
  userEvents,
  workflowEvents,
  workflowRunEvents,
  workspaceCommandEvents
);

export type PlatformEventName = keyof typeof EVENTS;
export type AuditEventName = PlatformEventName;

export interface PlatformEventContext extends Pick<
  OperationCall,
  "actor" | "origin" | "workspaceId" | "correlationId"
> {
  /** What the event is about. A before-event of an asset not written yet has its name only. */
  subject: { kind: string; id?: string; name?: string };
  phase: PlatformEventPhase;
  /**
   * The fields a guardrail at a before-event reads, by the names the event declares checkable:
   * an asset's text, a call's input. Asked only where a guardrail applies, and never stored:
   * the payload holds references only.
   */
  checkable?(): GuardrailFields | Promise<GuardrailFields>;
  /** What a filter narrows by beside the origin: the asset kind or the operation's name. */
  filterBy?: { kind?: string; operation?: string };
  /**
   * Set where the action writes, publishes, deletes or tests guardrails: only the release floor
   * answers its before-events, so no published guardrail stops the change of guardrails.
   */
  aboutGuardrails?: true;
  /** For the deadline and the stop of a guardrail's model call, where the caller has them. */
  runtime?: { deadline?: Date; signal?: AbortSignal };
  /**
   * Set where the event is asked again for the same action, as before a call that waited for
   * an approval is executed. The guardrails answer again; their hits were kept the first time.
   */
  repeated?: true;
  /**
   * Set where the action cannot wait for an approval and no request is filed for it, as the
   * App draft a save of a Page writes once the Page is stored: a guardrail's
   * `require_approval` answers and is kept as a `block`, so no hit waits for an approval
   * nobody can give.
   */
  cannotWait?: true;
}

export type PlatformEventOutcome = (typeof GUARDRAIL_OUTCOMES)[number];

/**
 * What a before-event answered: the strictest outcome of every guardrail that applies, and
 * those that warned, held or blocked, with their reasons. An after-event answers `allow`.
 */
export interface PlatformEventAnswer {
  outcome: PlatformEventOutcome;
  guardrails: readonly GuardrailAnswer[];
}

export const PLATFORM_EVENT_ALLOW: PlatformEventAnswer = { outcome: "allow", guardrails: [] };

const OUTCOME_ORDER: readonly PlatformEventOutcome[] = [...GUARDRAIL_OUTCOMES];

/** The strictest of several outcomes: an `allow` never overrides a `warn` or a `block`. */
export function strictestOutcome(outcomes: readonly PlatformEventOutcome[]): PlatformEventOutcome {
  return outcomes.reduce(
    (left, right) => (OUTCOME_ORDER.indexOf(left) >= OUTCOME_ORDER.indexOf(right) ? left : right),
    "allow"
  );
}

/**
 * The one way an event is raised. At `before` the guardrails bound to the name run, and the
 * caller acts on the answer; at `after` an audited event becomes an audit row.
 */
export interface PlatformEventEmitter {
  emit(
    name: PlatformEventName,
    payload: JsonObject,
    context: PlatformEventContext
  ): Promise<PlatformEventAnswer>;
}
