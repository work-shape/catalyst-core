import type { LocaleCode, OperationRunResource } from "@vivd-catalyst/api-client";
import type { BadgeTone } from "@vivd-catalyst/ui";
import type { TranslationKey } from "../i18n";

export type OperationRunStatus = OperationRunResource["status"];
export type OperationRunOrigin = OperationRunResource["origin"];
export type OperationRunOriginKind = OperationRunOrigin["kind"];
export type OperationRunEffect = OperationRunResource["effect"];

/** The effects in the order the filter offers them: what somebody did before what was read. */
export const operationRunEffects = [
  "changing",
  "reading"
] as const satisfies readonly OperationRunEffect[];

export const operationEffectFilterLabelKeys: Record<OperationRunEffect, TranslationKey> = {
  changing: "operations.effectChangingCalls",
  reading: "operations.effectReadingCalls"
};

/** The statuses in the order a run passes through them, for the filter. */
export const operationRunStatuses = [
  "running",
  "pending_confirmation",
  "pending_approval",
  "done",
  "failed",
  "denied",
  "expired"
] as const satisfies readonly OperationRunStatus[];

/** The seven places a call can come from, for the filter. */
export const operationRunOriginKinds = [
  "agent",
  "user",
  "cli",
  "mcp",
  "app",
  "workflow",
  "schedule"
] as const satisfies readonly OperationRunOriginKind[];

export const operationStatusLabelKeys: Record<OperationRunStatus, TranslationKey> = {
  running: "operations.statusRunning",
  pending_confirmation: "operations.statusPendingConfirmation",
  pending_approval: "operations.statusPendingApproval",
  done: "operations.statusDone",
  failed: "operations.statusFailed",
  denied: "operations.statusDenied",
  expired: "operations.statusExpired"
};

/** Warning is for what waits on a person. A refused or expired call is over and needs nobody. */
export const operationStatusTones: Record<OperationRunStatus, BadgeTone> = {
  running: "info",
  pending_confirmation: "warning",
  pending_approval: "warning",
  done: "success",
  failed: "danger",
  denied: "neutral",
  expired: "neutral"
};

export const operationOriginLabelKeys: Record<OperationRunOriginKind, TranslationKey> = {
  agent: "operations.originAgent",
  user: "operations.originUser",
  cli: "operations.originCli",
  mcp: "operations.originMcp",
  app: "operations.originApp",
  workflow: "operations.originWorkflow",
  schedule: "operations.originSchedule"
};

export const operationDecisionLabelKeys: Record<
  NonNullable<OperationRunResource["decision"]>["mode"],
  TranslationKey
> = {
  direct: "operations.decisionDirect",
  confirmed: "operations.decisionConfirmed",
  approved: "operations.decisionApproved",
  declined: "operations.decisionDeclined"
};

/** The filters of the list. Each is one field of the query of `operations.list_runs`. */
export interface OperationRunFilter {
  /** The exact name of an operation, as typed. */
  operation: string;
  /** Nothing means calls of both effects. */
  effect: OperationRunEffect | undefined;
  status: OperationRunStatus | undefined;
  origin: OperationRunOriginKind | undefined;
  workspaceId: string | undefined;
}

/**
 * The filter the page opens with: the changing calls. A read is recorded only when it was
 * refused, when it failed, or when its operation records every call, so the list of what
 * somebody did is the changing one.
 */
export const defaultOperationRunFilter: OperationRunFilter = {
  operation: "",
  effect: "changing",
  status: undefined,
  origin: undefined,
  workspaceId: undefined
};

export function isOperationRunFilterDefault(filter: OperationRunFilter): boolean {
  return operationRunQuery(filter).operation === undefined && !hasChoice(filter);
}

/** Whether the list holds reads, so the page says which reads are recorded at all. */
export function operationRunFilterShowsReads(filter: OperationRunFilter): boolean {
  return filter.effect !== "changing";
}

/** Whether the filter is the reads and nothing else: an empty list then needs no other words. */
export function isOperationRunFilterReadsOnly(filter: OperationRunFilter): boolean {
  return (
    filter.effect === "reading" &&
    isOperationRunFilterDefault({ ...filter, effect: defaultOperationRunFilter.effect })
  );
}

function hasChoice(filter: OperationRunFilter): boolean {
  return (
    filter.effect !== defaultOperationRunFilter.effect ||
    filter.status !== undefined ||
    filter.origin !== undefined ||
    filter.workspaceId !== undefined
  );
}

/** What the list asks the server: a filter that is not set is left out. */
export function operationRunQuery(filter: OperationRunFilter): {
  operation?: string;
  effect?: OperationRunEffect;
  status?: OperationRunStatus;
  origin?: OperationRunOriginKind;
  workspaceId?: string;
} {
  const operation = filter.operation.trim();
  return {
    ...(operation ? { operation } : {}),
    ...(filter.effect ? { effect: filter.effect } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.origin ? { origin: filter.origin } : {}),
    ...(filter.workspaceId ? { workspaceId: filter.workspaceId } : {})
  };
}

/** The value of a select as an effect, or nothing for the entry that means both. */
export function operationRunEffectOf(value: string): OperationRunEffect | undefined {
  return operationRunEffects.find((effect) => effect === value);
}

/** The value of a select as a status, or nothing for the entry that means every status. */
export function operationRunStatusOf(value: string): OperationRunStatus | undefined {
  return operationRunStatuses.find((status) => status === value);
}

export function operationRunOriginKindOf(value: string): OperationRunOriginKind | undefined {
  return operationRunOriginKinds.find((kind) => kind === value);
}

/** The agent a call came through, where it came through one. */
export function operationRunAgentName(origin: OperationRunOrigin): string | undefined {
  return origin.kind === "agent" ? origin.agentName : undefined;
}

/**
 * The name of a workspace the viewer knows, else its id. A run outside a workspace has neither.
 */
export function operationRunWorkspaceLabel(
  workspaceId: string | undefined,
  workspaces: readonly { id: string; name: string }[]
): string | undefined {
  if (workspaceId === undefined) {
    return undefined;
  }
  return workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? workspaceId;
}

const originFieldLabelKeys = {
  agentName: "operations.fieldAgentName",
  toolName: "operations.fieldToolName",
  conversationId: "operations.fieldConversationId",
  agentRunId: "operations.fieldAgentRunId",
  toolCallId: "operations.fieldToolCallId",
  clientName: "operations.fieldClientName",
  appRevisionId: "operations.fieldAppRevisionId",
  actionName: "operations.fieldActionName",
  pageSessionId: "operations.fieldPageSessionId",
  workflowRunId: "operations.fieldWorkflowRunId",
  stepRunId: "operations.fieldStepRunId",
  scheduleId: "operations.fieldScheduleId"
} as const satisfies Record<string, TranslationKey>;

type OriginField = keyof typeof originFieldLabelKeys;

/** The order the fields of an origin are read in: names before ids. */
const originFieldOrder: readonly OriginField[] = [
  "agentName",
  "toolName",
  "clientName",
  "actionName",
  "conversationId",
  "agentRunId",
  "toolCallId",
  "appRevisionId",
  "pageSessionId",
  "workflowRunId",
  "stepRunId",
  "scheduleId"
];

export interface OperationRunOriginField {
  field: OriginField;
  labelKey: TranslationKey;
  value: string;
}

/** What an origin says beyond its kind: the names and ids that lead to where the call was made. */
export function operationRunOriginFields(origin: OperationRunOrigin): OperationRunOriginField[] {
  const values: Partial<Record<OriginField, string>> & { kind: string } = origin;
  return originFieldOrder.flatMap((field) => {
    const value = values[field];
    return value ? [{ field, labelKey: originFieldLabelKeys[field], value }] : [];
  });
}

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * How long a run took, from its start to its end: "320 ms", "4.2 sec", "3 min 12 sec". A run
 * that has not ended, or never started, has no duration.
 */
export function formatOperationRunDuration(
  run: Pick<OperationRunResource, "startedAt" | "finishedAt">,
  locale: LocaleCode
): string | undefined {
  if (!run.startedAt || !run.finishedAt) {
    return undefined;
  }
  const elapsedMs = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  if (Number.isNaN(elapsedMs)) {
    return undefined;
  }
  const ms = Math.max(0, elapsedMs);
  const unit = (value: number, name: "millisecond" | "second" | "minute" | "hour", digits = 0) =>
    new Intl.NumberFormat(locale, {
      style: "unit",
      unit: name,
      unitDisplay: "short",
      maximumFractionDigits: digits
    }).format(value);
  if (ms < SECOND_MS) {
    return unit(ms, "millisecond");
  }
  if (ms < MINUTE_MS) {
    return unit(ms / SECOND_MS, "second", 1);
  }
  if (ms < HOUR_MS) {
    return `${unit(Math.floor(ms / MINUTE_MS), "minute")} ${unit(Math.floor((ms % MINUTE_MS) / SECOND_MS), "second")}`;
  }
  return `${unit(Math.floor(ms / HOUR_MS), "hour")} ${unit(Math.floor((ms % HOUR_MS) / MINUTE_MS), "minute")}`;
}
