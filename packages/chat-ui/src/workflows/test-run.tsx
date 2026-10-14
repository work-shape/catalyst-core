import { useState, type ReactNode } from "react";
import { ApiError } from "@vivd-catalyst/api-client";
import { instanceSentence, readRefusalDetails } from "../build-area/build-refusals";
import { useTranslation } from "../i18n";
import type { StartRefusalIssue } from "./start-form";
import { StartDialog } from "./start-run";
import { useLiveOnceSwitches, useWorkflowDraftWrites, workflowWriteRefusal } from "./workflow-data";
import { editOffered } from "./workflow-model";
import type { WorkflowStepRunView, WorkflowStepView, WorkflowView } from "./workflow-views";
import { useWorkflowsHost } from "./workflows-host";

// The test run of a Workflow's draft (ADR-0031): it acts as the reader, bounded by the
// Workflow's account, reads live and simulates every step that changes something, unless
// "Run live once" lets that step run for real in the next test run.

/** A sentence for the whole form, or the values the instance did not take. */
type TestRefusal = { message: string } | { issues: readonly StartRefusalIssue[] };

/**
 * The test run of the draft as the draft bar offers it: the question with the form of the
 * draft's inputs, the start, and the way to the new run. Nothing for a reader who may not
 * write the Workflow, and nothing where the reader is not shown its draft.
 */
export function useTestRun(
  workflow: string,
  view: Pick<WorkflowView, "name" | "draft"> | undefined
): { open(): void; dialog: ReactNode } | undefined {
  const { t } = useTranslation();
  const host = useWorkflowsHost();
  const writes = useWorkflowDraftWrites();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<TestRefusal>();
  const draft = view?.draft;
  if (host === undefined || writes === undefined || !editOffered(host.rights, view)) {
    return undefined;
  }
  const workspaceId = host.workspace?.id;
  const start = async (input: Record<string, unknown>) => {
    setBusy(true);
    setRefusal(undefined);
    try {
      const run = await writes.test(workflow, input);
      setAsking(false);
      if (workspaceId !== undefined) {
        host.showRoute({
          kind: "workflow-run",
          collaborationWorkspaceId: workspaceId,
          workflow,
          run: run.id
        });
      }
    } catch (failure) {
      const refused = workflowWriteRefusal(failure);
      const details = readRefusalDetails(failure);
      setRefusal(
        refused !== undefined
          ? {
              message: t(
                refused === "pending" ? "workflows.test.pending" : "workflows.test.refused"
              )
            }
          : details.reason === "input_invalid"
            ? { issues: details.issues }
            : { message: instanceSentence(failure) ?? t("workflows.test.failed") }
      );
    } finally {
      setBusy(false);
    }
  };
  return {
    open() {
      setRefusal(undefined);
      setAsking(true);
    },
    dialog:
      asking && view !== undefined && draft !== undefined ? (
        <StartDialog
          name={view.name}
          form={draft.testForm}
          test
          loading={busy}
          error={refusal !== undefined && "message" in refusal ? refusal.message : undefined}
          refusedValues={refusal !== undefined && "issues" in refusal ? refusal.issues : undefined}
          onConfirm={(input) => {
            start(input).catch(() => undefined);
          }}
          onClose={() => setAsking(false)}
        />
      ) : null
  };
}

/** "Run live once" for one step, as the panel of a step in a test run offers it. */
export interface LiveOnceControl {
  /**
   * `off`: not set. `set`: the reader's next test run makes the step live. `used`: a test run
   * of the reader's used it, and it covers no further run until it is set again.
   */
  state: "off" | "busy" | "set" | "used";
  /** The test run that used the switch, and when. */
  used?: { runId: string; at: string };
  error?: string;
  switchOn(): void;
}

/**
 * "Run live once" for the steps of a test run: one switch of the reader's own per step that
 * changes something, for the draft the reader is shown. What is set and what a test run used
 * is read from the instance, so it stands after a reload. Nothing for a reader who may not
 * write the Workflow.
 */
export function useRunLiveOnce(
  workflow: string,
  view: Pick<WorkflowView, "draft"> | undefined,
  /** The run the page shows has ended: the switches are read again, as it may have used one. */
  runEnded: boolean
):
  | ((
      step: WorkflowStepView,
      stepRun: WorkflowStepRunView | undefined
    ) => LiveOnceControl | undefined)
  | undefined {
  const { t } = useTranslation();
  const host = useWorkflowsHost();
  const writes = useWorkflowDraftWrites();
  const draft = view?.draft;
  const offered =
    host !== undefined &&
    writes !== undefined &&
    draft !== undefined &&
    editOffered(host.rights, view);
  const switches = useLiveOnceSwitches(workflow, offered, runEnded);
  const [pending, setPending] = useState<ReadonlyMap<string, { busy: boolean; error?: string }>>(
    new Map()
  );
  if (!offered || writes === undefined || draft === undefined) {
    return undefined;
  }
  const set = (step: string, next: { busy: boolean; error?: string }) =>
    setPending((current) => new Map(current).set(step, next));
  const switchOn = async (step: string) => {
    set(step, { busy: true });
    try {
      await writes.runLiveOnce(workflow, step, draft.revision);
      set(step, { busy: false });
    } catch (failure) {
      set(step, {
        busy: false,
        error:
          failure instanceof ApiError && failure.status === 412
            ? t("workflows.liveOnce.stale")
            : workflowWriteRefusal(failure) === "refused"
              ? t("workflows.test.refused")
              : (instanceSentence(failure) ?? t("workflows.liveOnce.failed"))
      });
    }
  };
  return (step, stepRun) => {
    if (step.kind !== "operation" || (stepRun?.effect ?? step.effect) === "reading") {
      return undefined;
    }
    const held = pending.get(step.id);
    // A step may have a switch set for the next run beside the run that used the last one.
    const set = switches?.find((entry) => entry.step === step.id && entry.used === undefined);
    const used = switches?.find(
      (entry) => entry.step === step.id && entry.used !== undefined
    )?.used;
    return {
      state: held?.busy ? "busy" : set !== undefined ? "set" : used !== undefined ? "used" : "off",
      ...(used === undefined ? {} : { used }),
      ...(held?.error === undefined ? {} : { error: held.error }),
      switchOn: () => {
        switchOn(step.id).catch(() => undefined);
      }
    };
  };
}
