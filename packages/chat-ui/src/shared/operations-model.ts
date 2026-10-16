import type { LocaleCode, OperationRunResource } from "@work-shape/catalyst-api-client";
import { OPERATION_ORIGIN_KINDS, OPERATION_RUN_STATUSES } from "@work-shape/catalyst-core";
import type { BadgeTone } from "@work-shape/catalyst-ui";
import type { TranslationKey } from "./i18n";
import { workspaceRoutePath } from "./routes";

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
export const operationRunStatuses = OPERATION_RUN_STATUSES satisfies readonly OperationRunStatus[];

/** The seven places a call can come from, for the filter. */
export const operationRunOriginKinds =
  OPERATION_ORIGIN_KINDS satisfies readonly OperationRunOriginKind[];

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
const operationStatusTones: Record<OperationRunStatus, BadgeTone> = {
  running: "info",
  pending_confirmation: "warning",
  pending_approval: "warning",
  done: "success",
  failed: "danger",
  denied: "neutral",
  expired: "neutral"
};

/**
 * The badge of a run's status. A call that was confirmed or approved keeps its waiting status
 * until the worker of its Agent Run takes it for execution, which is what exactly-once rests
 * on. Meanwhile it waits for no person, so its badge does not say it does.
 */
export function operationRunStatusBadge(run: Pick<OperationRunResource, "status" | "decision">): {
  labelKey: TranslationKey;
  tone: BadgeTone;
} {
  const decided = run.decision?.mode;
  if (run.status === "pending_confirmation" && decided === "confirmed") {
    return { labelKey: "operations.statusConfirmedWaitingToRun", tone: "info" };
  }
  if (run.status === "pending_approval" && decided === "approved") {
    return { labelKey: "operations.statusApprovedWaitingToRun", tone: "info" };
  }
  return { labelKey: operationStatusLabelKeys[run.status], tone: operationStatusTones[run.status] };
}

export const operationOriginLabelKeys: Record<OperationRunOriginKind, TranslationKey> = {
  agent: "operations.originAgent",
  user: "operations.originUser",
  cli: "operations.originCli",
  mcp: "operations.originMcp",
  app: "operations.originApp",
  workflow: "operations.originWorkflow",
  schedule: "operations.originSchedule"
};

const operationDecisionLabelKeys: Record<
  NonNullable<OperationRunResource["decision"]>["mode"],
  TranslationKey
> = {
  direct: "operations.decisionDirect",
  confirmed: "operations.decisionConfirmed",
  approved: "operations.decisionApproved",
  declined: "operations.decisionDeclined"
};

/** The words of a run's decision: its reason where it names one the mode does not say. */
export function operationDecisionLabelKey(
  decision: Pick<NonNullable<OperationRunResource["decision"]>, "mode" | "reason">
): TranslationKey {
  switch (decision.reason) {
    case "workflow_publish":
      return "operations.decisionWorkflowPublish";
    case "approved_by_caller":
      return "operations.decisionApprovedByCaller";
    default:
      return operationDecisionLabelKeys[decision.mode];
  }
}

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

/** The App a call came from, as a row and the detail of its run name it. */
export interface OperationRunAppFacts {
  /** What people read as the App's name. A deleted App has none left and goes by its id. */
  name: string;
  deleted: boolean;
  /** The number of the revision the call was made in, where the instance still knows it. */
  revision?: number;
  action: string;
  /**
   * What the call reached, by name: a Connection and its operation, or a Data Store, whose
   * operation is the statement the App keeps.
   */
  target?: { name: string; operation: string };
}

/**
 * What a run with the origin `app` says of its App. A call of a Page of a conversation names
 * no App and has none of this.
 */
export function operationRunApp(
  run: Pick<OperationRunResource, "origin" | "app">
): OperationRunAppFacts | undefined {
  const { origin, app } = run;
  if (origin.kind !== "app" || origin.appName === undefined) {
    return undefined;
  }
  return {
    name: app?.title ?? origin.appName,
    deleted: app?.deleted ?? false,
    ...(app?.revision === undefined ? {} : { revision: app.revision }),
    action: origin.actionName,
    ...(origin.target
      ? {
          target:
            "dataStore" in origin.target
              ? { name: origin.target.dataStore, operation: "sql" }
              : "workflow" in origin.target
                ? { name: origin.target.workflow, operation: "start" }
                : { name: origin.target.connection, operation: origin.target.operation }
        }
      : {})
  };
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

/** The parameter in the address of Instance > Operations that names the run it opens with. */
const OPERATION_RUN_PARAM = "run";

/** Where the runs are read in the interface: Instance > Operations. */
export function operationRunsHref(): string {
  return workspaceRoutePath({ kind: "settings", group: "instance", page: "operations" });
}

/** Where one run is read in the interface: Instance > Operations, open on that run. */
export function operationRunHref(runId: string): string {
  return `${operationRunsHref()}?${new URLSearchParams({ [OPERATION_RUN_PARAM]: runId }).toString()}`;
}

/** The run the address of the page names, read from its query. */
export function operationRunOfSearch(search: string): string | undefined {
  return new URLSearchParams(search).get(OPERATION_RUN_PARAM) || undefined;
}
