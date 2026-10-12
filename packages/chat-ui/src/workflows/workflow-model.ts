import type { PlatformContext } from "@vivd-catalyst/api-client";
import { WORKFLOW_ACTIONS } from "@vivd-catalyst/core";
import type { BadgeTone } from "@vivd-catalyst/ui";
import type { TranslationKey } from "../i18n";
import type {
  WorkflowFailureReason,
  WorkflowRunStatus,
  WorkflowRunView,
  WorkflowStepView,
  WorkflowView
} from "./workflow-views";

/** The module whose switch turns the Workflows area on and off. */
const WORKFLOWS_MODULE = "workflows";

/** What the instance says the reader holds, as far as Workflows read it. */
type HeldActions = Pick<PlatformContext, "actions" | "assetActions">;

/** What the reader may do with Workflows, as far as the browser can know it. */
export interface WorkflowRights {
  /** Reads some Workflow: the area has something to show. */
  read: boolean;
  /** The start is offered. The instance decides the call itself. */
  start: boolean;
  /** Writes every Workflow, which also cancels a run someone else started. */
  write: boolean;
}

/**
 * The reader's rights on Workflows. The instance names every action a person holds on all
 * Workflows, and of a grant on single ones only that it reads. So a person with such a grant
 * is offered the start, and the instance answers whether the Workflow at hand is theirs to
 * start; a person who reads every Workflow and may use none is not offered it.
 */
export function resolveWorkflowRights(context: HeldActions | undefined): WorkflowRights {
  const onAll = context?.actions ?? [];
  const onSingle = context?.assetActions ?? [];
  const readsAll = onAll.includes(WORKFLOW_ACTIONS.read);
  const readsSingle = onSingle.includes(WORKFLOW_ACTIONS.read);
  return {
    read: readsAll || readsSingle,
    start: onAll.includes(WORKFLOW_ACTIONS.use) || (!readsAll && readsSingle),
    write: onAll.includes(WORKFLOW_ACTIONS.write)
  };
}

/** Whether the area is there for the reader. `unknown` until the instance has said both. */
export type WorkflowsAccess = "open" | "closed" | "unknown";

/**
 * Decides the row in the rail and every address of the area at once: the module is on, the
 * session has a workspace to hold Workflows, and the reader may read one. With the module off
 * or without the right the area is closed, and its addresses answer as unknown ones do.
 */
export function workflowsAccess(input: {
  /** The modules of the instance, once its configuration arrived. */
  modules: Readonly<Record<string, { enabled: boolean }>> | undefined;
  /** The session has workspaces. */
  workspaces: boolean;
  context: HeldActions | undefined;
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
  return resolveWorkflowRights(input.context).read ? "open" : "closed";
}

/**
 * Whether "Start now" stands on the page of a Workflow: a revision is published, a person may
 * start it, and it takes no input, for which there is no form yet.
 */
export function startOffered(
  workflow: Pick<WorkflowView, "published" | "startsByHand" | "needsInput">,
  rights: Pick<WorkflowRights, "start">
): boolean {
  return rights.start && workflow.published && workflow.startsByHand && !workflow.needsInput;
}

/** Whether "Cancel run" stands on the page of a run: it is going, and the reader may end it. */
export function cancelOffered(
  run: Pick<WorkflowRunView, "ended" | "startedBy">,
  viewerId: string,
  rights: Pick<WorkflowRights, "write">
): boolean {
  return !run.ended && (rights.write || run.startedBy?.id === viewerId);
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
  limit_reached: { label: "workflows.run.limitReached", tone: "danger", spins: false }
};

/** How the state of a run reads. A run being cancelled says so until the instance has. */
export function runStatePresentation(
  status: WorkflowRunStatus,
  stopping = false
): RunStatePresentation {
  return stopping && status !== "cancelled"
    ? { label: "workflows.run.stopping", tone: "neutral", spins: true }
    : RUN_STATES[status];
}

/** What happened, and what the reader can do about it, for why something did not end as done. */
export function failureSentences(reason: WorkflowFailureReason): {
  happened: TranslationKey;
  advice: TranslationKey;
} {
  return { happened: `workflows.reason.${reason}`, advice: `workflows.advice.${reason}` };
}
