import type { PlatformContext } from "@work-shape/catalyst-api-client";
import {
  CONNECTION_ACTIONS,
  WORKFLOW_ACTIONS,
  WORKFLOW_ASSET_KIND
} from "@work-shape/catalyst-core";
import type { BadgeTone } from "@work-shape/catalyst-ui";
import {
  assetRightsBy,
  assetRightsOn,
  NO_ASSET_RIGHTS,
  resolveBuildRights,
  type AssetRights
} from "../../shared/build-rights";
import { actionLabel } from "../../admin/access/right-words";
import { canManageServicePrincipals } from "../../shared/governance";
import type { TranslationKey } from "../../shared/i18n";
import { startFormUsable } from "./start-form";
import type {
  WorkflowFailure,
  WorkflowFailureReason,
  WorkflowListItem,
  WorkflowRunStatus,
  WorkflowRunView,
  WorkflowStepRunView,
  WorkflowStepView,
  WorkflowView
} from "./workflow-views";

/** The module whose switch turns the Workflows area on and off. */
const WORKFLOWS_MODULE = "workflows";

/** What the instance says the reader holds, as far as Workflows read it. */
type HeldActions = Pick<PlatformContext, "actions" | "assetActions">;

/**
 * What the reader may do with Workflows, as far as the browser can know it, by the owner of a
 * Workflow. One Workflow's own record or row decides for it where it says (`workflowRightsOn`);
 * these stand where it does not.
 */
export interface WorkflowRights {
  /**
   * On the instance's own Workflows, as the instance names its rights on them. Every Workflow
   * belongs to the instance today, and a new one is made there. `write` also cancels a run
   * someone else started.
   */
  instance: AssetRights;
  /**
   * The open workspace and the rights the instance names on that workspace's own Workflows: a
   * grant there, a membership's role or a right on the whole instance. A kind the instance keeps
   * on itself alone, as it keeps Workflows today, names none there.
   */
  workspace?: { id: string; rights: AssetRights };
  /** The reader administers technical accounts and may give a Workflow's account a right. */
  administersAccounts?: boolean;
}

/**
 * The reader's rights on Workflows, by owner. Whether one Workflow is theirs to start is not
 * among them: the list says it of each Workflow.
 */
export function resolveWorkflowRights(
  context: PlatformContext | undefined,
  workspaceId: string | undefined
): WorkflowRights {
  const onAll = context?.actions ?? [];
  // No session: its legacy keys name agents and skills, never Workflows.
  const build = resolveBuildRights(undefined, context);
  return {
    instance: assetRightsBy((verb) => onAll.includes(WORKFLOW_ACTIONS[verb])),
    ...(canManageServicePrincipals(context) ? { administersAccounts: true } : {}),
    ...(workspaceId === undefined
      ? {}
      : {
          workspace: {
            id: workspaceId,
            rights: assetRightsBy((verb) =>
              build.holdsInWorkspace(WORKFLOW_ASSET_KIND, verb, workspaceId)
            )
          }
        })
  };
}

/**
 * The reader's rights on one Workflow: what its record or its row says the reader may do to
 * it, with every grant and deny there is. Where it says nothing, and until it arrives, the
 * rights on its owner stand: the instance's, or the open workspace's for a Workflow that
 * workspace owns. A right in the open workspace is never lent to what another owner holds.
 */
export function workflowRightsOn(
  rights: WorkflowRights,
  workflow: Pick<WorkflowView, "allowed" | "ownerWorkspaceId"> | undefined
): AssetRights {
  const owner = workflow?.ownerWorkspaceId;
  const onOwner =
    owner === undefined
      ? rights.instance
      : owner === rights.workspace?.id
        ? rights.workspace.rights
        : NO_ASSET_RIGHTS;
  return assetRightsOn(onOwner, workflow);
}

/** The reader reads some Workflow: the area has something to show. */
function readsSomeWorkflow(context: HeldActions): boolean {
  return [...context.actions, ...context.assetActions].includes(WORKFLOW_ACTIONS.read);
}

/** Whether the area is there for the reader. `unknown` until the instance has said both. */
export type WorkflowsAccess = "open" | "closed" | "unknown";

/**
 * Decides every address of the area: the module is on, the session has a workspace to hold
 * Workflows, and the reader may read one or the instance names them the row, which it does
 * where `workflows.list` names them a Workflow or they may write one. With the module off or
 * without either the area is closed, and its addresses answer as unknown ones do.
 */
export function workflowsAccess(input: {
  /** The modules of the instance, once its configuration arrived. */
  modules: Readonly<Record<string, { enabled: boolean }>> | undefined;
  /** The session has workspaces. */
  workspaces: boolean;
  context: (HeldActions & Partial<Pick<PlatformContext, "visibleSections">>) | undefined;
}): WorkflowsAccess {
  if (input.modules === undefined) {
    return "unknown";
  }
  if (!input.workspaces || input.modules[WORKFLOWS_MODULE]?.enabled !== true) {
    return "closed";
  }
  if (input.context === undefined) {
    return "unknown";
  }
  return readsSomeWorkflow(input.context) ||
    input.context.visibleSections?.includes("workflows") === true
    ? "open"
    : "closed";
}

/**
 * Whether the Workflows row of the sidebar shows: the instance names the row for the person,
 * in a session with workspaces where the module is on. The flag alone decides it; a reader the
 * instance names no Workflow keeps the area's addresses but sees no row.
 */
export function workflowsRowShown(
  access: WorkflowsAccess,
  context: Pick<PlatformContext, "visibleSections"> | undefined
): boolean {
  return access !== "closed" && context?.visibleSections.includes("workflows") === true;
}

/**
 * Whether the list shows a Workflow to the reader: a published one to whoever the instance
 * lists it to, a draft never published only to who builds it, by writing or publishing it
 * (Platform Access check 44).
 */
export function listedToReader(
  workflow: Pick<WorkflowListItem, "published" | "allowed" | "ownerWorkspaceId">,
  rights: WorkflowRights
): boolean {
  if (workflow.published) return true;
  const onIt = workflowRightsOn(rights, workflow);
  return onIt.write || onIt.publish;
}

/**
 * Whether the runs of a Workflow are the reader's to read: the instance lists them to who may
 * read the Workflow. Writing, publishing or starting it reads none of them.
 */
export function runsReadable(
  rights: WorkflowRights,
  workflow: Pick<WorkflowView, "allowed" | "ownerWorkspaceId"> | undefined
): boolean {
  return workflowRightsOn(rights, workflow).read;
}

/**
 * Whether a start stands on the page or the card of a Workflow: a revision is published, the
 * reader holds the right to start this Workflow, and its start form can ask for every input a
 * start needs.
 */
export function startOffered(
  workflow: Pick<
    WorkflowView,
    "published" | "startsByHand" | "startForm" | "refusedFor" | "mayStart"
  >
): boolean {
  return (
    workflow.mayStart &&
    workflow.published &&
    workflow.startsByHand &&
    startFormUsable(workflow.startForm) &&
    // What the instance would refuse is not offered: the page says why in its place.
    workflow.refusedFor.length === 0
  );
}

/** How the draft of a Workflow stands beside what is published, where the two differ. */
export type WorkflowDraftState =
  /** No revision was published yet: the draft is all there is. */
  | "unpublished"
  /** The draft is another revision than the published one. */
  | "ahead";

/**
 * What the bar over a Workflow says of its draft. Nothing where the reader is not shown the
 * draft, and nothing where the draft is the published revision.
 */
export function draftState(
  workflow: Pick<WorkflowView, "draft"> | undefined
): WorkflowDraftState | undefined {
  const draft = workflow?.draft;
  if (draft === undefined) {
    return undefined;
  }
  if (draft.publishedRevision === undefined) {
    return "unpublished";
  }
  return draft.revision === draft.publishedRevision ? undefined : "ahead";
}

/**
 * Whether "Edit with the agent" stands on the page of a Workflow: the reader may write this
 * Workflow, and the instance showed them its draft, which is what the agent of such a
 * conversation reads and saves.
 */
export function editOffered(
  rights: WorkflowRights,
  workflow: Pick<WorkflowView, "draft" | "allowed" | "ownerWorkspaceId"> | undefined
): boolean {
  return workflowRightsOn(rights, workflow).write && workflow?.draft !== undefined;
}

/**
 * Whether "Cancel run" stands on the page of a run: it is going, and the reader started it or
 * may write its Workflow, as the instance decides a cancel. `workflow` counts only where it is
 * the run's own; until it is, the rights on the instance's Workflows stand.
 */
export function cancelOffered(
  run: Pick<WorkflowRunView, "ended" | "startedBy" | "workflowId">,
  viewerId: string,
  rights: WorkflowRights,
  workflow: Pick<WorkflowView, "id" | "allowed" | "ownerWorkspaceId"> | undefined
): boolean {
  const own = workflow?.id === run.workflowId ? workflow : undefined;
  return !run.ended && (run.startedBy?.id === viewerId || workflowRightsOn(rights, own).write);
}

/** The sentence of a step whose definition gives none. A loop has its steps to say it. */
export function stepFallbackSentence(
  step: Pick<WorkflowStepView, "kind" | "channel">
): TranslationKey | undefined {
  switch (step.kind) {
    case "code":
      return "workflows.step.fallbackCode";
    case "agent":
      return "workflows.step.fallbackAgent";
    case "notify":
      return step.channel === "mail"
        ? "workflows.step.fallbackMail"
        : "workflows.step.fallbackInbox";
    case "output":
      return "workflows.step.fallbackOutput";
    case "workflow":
      return "workflows.step.fallbackWorkflow";
    case "trigger":
    case "operation":
    case "loop":
    case "condition":
    case "parallel":
      return undefined;
  }
}

interface RunStatePresentation {
  label: TranslationKey;
  tone: BadgeTone;
  /** The badge carries a spinner in place of its dot. */
  spins: boolean;
}

const RUN_STATES: Readonly<Record<WorkflowRunStatus, RunStatePresentation>> = {
  queued: { label: "workflows.run.queued", tone: "neutral", spins: false },
  running: { label: "workflows.run.running", tone: "info", spins: true },
  waiting: { label: "workflows.run.waiting", tone: "neutral", spins: false },
  done: { label: "workflows.run.done", tone: "success", spins: false },
  failed: { label: "workflows.run.failed", tone: "danger", spins: false },
  cancelled: { label: "workflows.run.cancelled", tone: "neutral", spins: false },
  limit_reached: { label: "workflows.run.limitReached", tone: "danger", spins: false },
  // A part that handed on to the next one: it ended well, and the Lauf goes on.
  continued: { label: "workflows.run.continued", tone: "success", spins: false }
};

/**
 * How the state of a run reads. A run being cancelled says so until the instance has. A run
 * that ended `done` with failed loop entries is no plain success: it reads as a warning.
 */
export function runStatePresentation(
  status: WorkflowRunStatus,
  stopping = false,
  withFailedEntries = false
): RunStatePresentation {
  if (stopping && status !== "cancelled") {
    return { label: "workflows.run.stopping", tone: "neutral", spins: true };
  }
  return status === "done" && withFailedEntries
    ? { label: "workflows.run.doneWithFailures", tone: "warning", spins: false }
    : RUN_STATES[status];
}

/** How many entries of some loops failed, of how many they have together. */
export interface EntryTally {
  failed: number;
  total: number;
}

/** What a run that ended `done` left failed below it: in its loops, or in runs further down. */
export interface FailedEntries {
  /** The loops that start a child run per entry: their entries are child runs. */
  childRuns?: EntryTally;
  /** Every other loop. */
  entries?: EntryTally;
  /**
   * Only where the page holds no loop of the run's own with a failed entry, as before its step
   * runs load: the items of its own loops that failed, as the instance counted them when the
   * run ended. Whether they are child runs the page cannot tell yet. It has no total and no
   * loop to take the reader to.
   */
  items?: number;
  /**
   * Only where neither a loop of the run's own nor its own count names a failed entry: the runs
   * below it, at any depth, that failed or left failures, as the instance counts them. It has
   * no total and no loop to take the reader to.
   */
  descendantRuns?: number;
  /**
   * The first loop of the run's frame with a failed entry, a child-run loop first: where the
   * reader is taken. None where only loops inside entries or runs further down failed.
   */
  opens?: { loopStepId: string; childRuns: boolean };
}

/** A step of a definition by its id, at any depth of its loops and paths. */
function stepById(
  steps: readonly WorkflowStepView[] | undefined,
  stepId: string
): WorkflowStepView | undefined {
  for (const step of steps ?? []) {
    if (step.id === stepId) return step;
    const inside =
      stepById(step.steps, stepId) ??
      (step.branches ?? []).reduce<WorkflowStepView | undefined>(
        (found, branch) => found ?? stepById(branch.steps, stepId),
        undefined
      );
    if (inside !== undefined) return inside;
  }
  return undefined;
}

/**
 * Whether a run that ended `done` left failed items in this or preceding parts, or runs with failures
 * below it, at any depth. A list reads this: it holds no step runs.
 */
export function doneWithFailedRuns(
  run: Pick<WorkflowRunView, "status" | "failedDescendantCount" | "failedItemCount">
): boolean {
  return run.status === "done" && (run.failedItemCount > 0 || run.failedDescendantCount > 0);
}

/**
 * What a run that ended `done` left failed, read first from the counts on the step runs of its
 * loops (a loop under `onItemFailure: continue` ends `done` with failed entries): those of its
 * frame, at any depth of its blocks, and those of loops inside an entry of another loop. A loop
 * is a child-run loop where its body is one `workflow` step: its entries are child runs. Any
 * other body's counts are entries, whatever it calls. Each tally counts every loop of its kind,
 * so "1 of 600" names all of them. Only a loop of the frame is one the page can open.
 * Until the step runs load, the run's own count of failed items speaks, as `items`. A child run
 * that ended `done` over failures of its own leaves no failed count in this run: for it the
 * run's count of runs with failures below it speaks, as `descendantRuns`, where neither speaks.
 * Nothing for a run that did not end `done`, or that left nothing failed.
 */
export function failedEntriesOf(
  run: Pick<WorkflowRunView, "status" | "failedDescendantCount" | "failedItemCount">,
  stepRuns: readonly Pick<WorkflowStepRunView, "stepId" | "iteration" | "loop">[] | undefined,
  steps: readonly WorkflowStepView[] | undefined
): FailedEntries | undefined {
  if (run.status !== "done") return undefined;
  // The counts count entries: they are child runs only where an entry is one child run.
  const startsChildRuns = (stepId: string) => {
    const body = stepById(steps, stepId)?.steps ?? [];
    return body.length === 1 && body[0]?.kind === "workflow";
  };
  const loops = (stepRuns ?? []).flatMap((stepRun) =>
    stepRun.loop === undefined
      ? []
      : [
          {
            stepId: stepRun.stepId,
            counts: stepRun.loop,
            child: startsChildRuns(stepRun.stepId),
            // A loop in an item of another loop is one of many: the page cannot open it alone.
            opens: stepRun.iteration === undefined
          }
        ]
  );
  const tally = (child: boolean): EntryTally | undefined => {
    const own = loops.filter((loop) => loop.child === child);
    const failed = own.reduce((sum, loop) => sum + loop.counts.failed, 0);
    return failed === 0
      ? undefined
      : { failed, total: own.reduce((sum, loop) => sum + loop.counts.total, 0) };
  };
  const childRuns = tally(true);
  const entries = tally(false);
  if (childRuns === undefined && entries === undefined) {
    if (run.failedItemCount > 0) return { items: run.failedItemCount };
    return doneWithFailedRuns(run) ? { descendantRuns: run.failedDescendantCount } : undefined;
  }
  const openable = loops.filter((loop) => loop.opens && loop.counts.failed > 0);
  const first = openable.find((loop) => loop.child) ?? openable[0];
  return {
    ...(childRuns === undefined ? {} : { childRuns }),
    ...(entries === undefined ? {} : { entries }),
    ...(first === undefined ? {} : { opens: { loopStepId: first.stepId, childRuns: first.child } })
  };
}

/** The instance's time zone; `defaulted`: the instance sets none, so it is UTC. */
export interface InstanceTimeZone {
  timeZone: string;
  defaulted: boolean;
}

/**
 * The instance's zone as its context names it, for a schedule saved without one. An older
 * server names no zone: then nothing, never a guessed one.
 */
export function instanceTimeZoneOf(
  context: Pick<PlatformContext, "instance"> | undefined
): InstanceTimeZone | undefined {
  const timeZone = context?.instance.timeZone;
  return timeZone === undefined
    ? undefined
    : { timeZone, defaulted: context?.instance.timeZoneDefaulted ?? false };
}

/** What the screen knows of a failed step beside its failure: its account and its Connection. */
export interface FailureNames {
  /** The label of the account the Workflow runs as. */
  account?: string | undefined;
  /** The Connection the step uses. */
  connection?: string | undefined;
}

/** The Connection an operation step uses, where the instance names it: its step run first. */
export function stepConnection(
  step: Pick<WorkflowStepView, "source" | "sourceKind"> | undefined,
  stepRun?: { source?: string | undefined }
): string | undefined {
  return step?.sourceKind === "connection" ? (stepRun?.source ?? step.source) : undefined;
}

/**
 * The Connection a failure names: its title where the instance sends one, otherwise what the
 * screen knows of the step, otherwise the name the failure recorded.
 */
function failedConnection(
  failure: Pick<WorkflowFailure, "connection" | "connectionTitle">,
  known: string | undefined
): string | undefined {
  return failure.connectionTitle ?? known ?? failure.connection;
}

/**
 * What happened, as one sentence. A missing right is named where the instance names it: the
 * action the account of the Workflow does not hold, with the account and the Connection where
 * the screen or the failure knows them (C7).
 */
export function failureHappened(
  failure: Pick<
    WorkflowFailure,
    "reason" | "action" | "connection" | "connectionTitle" | "workflow" | "operation" | "exposure"
  > & {
    detail?: string;
  },
  t: (key: TranslationKey, values?: Record<string, string>) => string,
  { account, connection: known }: FailureNames = {}
): string {
  const connection = failedConnection(failure, known);
  if (failure.workflow !== undefined && failure.reason === "runKeyCycle") {
    return t("workflows.reason.runKeyCycleNamed", { workflow: failure.workflow });
  }
  if (failure.operation !== undefined && failure.reason === "confirmationUnattended") {
    return t("workflows.reason.confirmationUnattendedNamed", { operation: failure.operation });
  }
  if (failure.reason === "notExposed") return notExposedHappened(failure.exposure, connection, t);
  if (failure.action !== undefined && failure.reason === "missingRight") {
    if (failure.action === CONNECTION_ACTIONS.use) {
      if (connection === undefined) {
        // Where the instance names no Connection, the right is still said in words.
        return account === undefined
          ? t("workflows.reason.connectionUseOfStep")
          : t("workflows.reason.connectionUseOfStepNamed", { account });
      }
      return account === undefined
        ? t("workflows.reason.connectionUse", { connection })
        : t("workflows.reason.connectionUseNamed", { account, connection });
    }
    return account === undefined
      ? t("workflows.reason.missingRightNamed", { right: failure.action })
      : t("workflows.reason.missingRightAccount", { account, right: failure.action });
  }
  if (failure.action !== undefined && failure.reason === "testerMissingRight") {
    return t("workflows.reason.testerMissingRightNamed", { right: actionLabel(failure.action, t) });
  }
  // The work goes on, and its owner's sentence says so, such as "Abgleich läuft weiter".
  if (failure.reason === "stillRunning" && failure.detail) {
    return t("workflows.reason.stillRunningNamed", { sentence: failure.detail });
  }
  return t(failureSentences(failure.reason).happened);
}

/** Whether a run ended by failing, or because it reached a limit. */
export function runFailed(run: Pick<WorkflowRunView, "status">): boolean {
  return run.status === "failed" || run.status === "limit_reached";
}

/**
 * Why a run failed, as the one sentence of its page; nothing for a run that did not fail. A
 * failed run whose reason did not arrive says the general sentence, never the instance's own.
 * A missing right names the account the run itself acted as.
 */
export function runFailedBecause(
  run: Pick<WorkflowRunView, "status" | "failure" | "runsAs">,
  t: (key: TranslationKey, values?: Record<string, string>) => string
): string | undefined {
  return runFailed(run)
    ? failureHappened(run.failure ?? { reason: "other" }, t, { account: run.runsAs })
    : undefined;
}

/**
 * What the reader can do about a failure. An administrator of technical accounts is told where
 * to give the missing right, never to ask an administrator (C7).
 */
export function failureAdvice(
  failure: Pick<
    WorkflowFailure,
    "reason" | "action" | "connection" | "connectionTitle" | "exposure"
  >,
  t: (key: TranslationKey, values?: Record<string, string>) => string,
  {
    account,
    connection: known,
    administers,
    place
  }: FailureNames & { administers: boolean; place: string }
): string {
  const connection = failedConnection(failure, known);
  if (failure.reason === "notExposed") return notExposedAdvice(failure.exposure, connection, t);
  if (failure.reason !== "missingRight" || !administers) {
    return t(failureSentences(failure.reason).advice, { place });
  }
  if (account === undefined) {
    return t("workflows.advice.missingRightAdmin", { place });
  }
  return failure.action === CONNECTION_ACTIONS.use && connection !== undefined
    ? t("workflows.advice.connectionUseAdmin", { account, connection, place })
    : t("workflows.advice.missingRightAdminAccount", { account, place });
}

/**
 * What happened to a step whose operation is not open to the run. Its Connection is named
 * where the screen or the failure knows it; without one the step reads data of no Connection,
 * which no exposure opens.
 */
function notExposedHappened(
  exposure: WorkflowFailure["exposure"],
  connection: string | undefined,
  t: (key: TranslationKey, values?: Record<string, string>) => string
): string {
  if (exposure === "outside") {
    return connection === undefined
      ? t("workflows.reason.notExposedOutsideOfStep")
      : t("workflows.reason.notExposedOutside", { connection });
  }
  if (exposure === "workflow") {
    return connection === undefined
      ? t("workflows.reason.notExposedWorkflowOfStep")
      : t("workflows.reason.notExposedWorkflow", { connection });
  }
  return t("workflows.reason.notExposed");
}

/**
 * What opens a step whose operation is not open to the run: the Connection's exposure, in the
 * words of its page, never a right. An outside client's run is also run without one, from here.
 */
function notExposedAdvice(
  exposure: WorkflowFailure["exposure"],
  connection: string | undefined,
  t: (key: TranslationKey, values?: Record<string, string>) => string
): string {
  if (exposure === "outside") {
    return connection === undefined
      ? t("workflows.advice.notExposedOutsideOfStep")
      : t("workflows.advice.notExposedOutside", {
          connection,
          field: t("connections.operationExposure"),
          surface: t("connections.exposureOutside")
        });
  }
  if (exposure === "workflow" && connection !== undefined) {
    return t("workflows.advice.notExposedWorkflow", {
      connection,
      field: t("connections.operationExposure"),
      surface: t("connections.exposureWorkflow")
    });
  }
  return t("workflows.advice.notExposed");
}

/** What happened, and what the reader can do about it, for why something did not end as done. */
function failureSentences(reason: WorkflowFailureReason): {
  happened: TranslationKey;
  advice: TranslationKey;
} {
  return { happened: `workflows.reason.${reason}`, advice: `workflows.advice.${reason}` };
}
