import { useState, type ReactNode } from "react";
import { ApiError } from "@vivd-catalyst/api-client";
import { instanceSentence, readRefusalDetails } from "../build-area/build-refusals";
import { useTranslation } from "../i18n";
import type { StartRefusalIssue } from "./start-form";
import { StartDialog } from "./start-run";
import { useWorkflowDraftWrites, workflowWriteRefusal } from "./workflow-data";
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
  state: "idle" | "busy" | "done";
  error?: string;
  switchOn(): void;
}

/**
 * "Run live once" for the steps of a test run: one switch per step that changes something,
 * for the draft the reader is shown. Nothing for a reader who may not write the Workflow.
 */
export function useRunLiveOnce(
  workflow: string,
  view: Pick<WorkflowView, "draft"> | undefined
):
  | ((
      step: WorkflowStepView,
      stepRun: WorkflowStepRunView | undefined
    ) => LiveOnceControl | undefined)
  | undefined {
  const { t } = useTranslation();
  const host = useWorkflowsHost();
  const writes = useWorkflowDraftWrites();
  const [states, setStates] = useState<
    ReadonlyMap<string, { state: LiveOnceControl["state"]; error?: string }>
  >(new Map());
  const draft = view?.draft;
  if (
    host === undefined ||
    writes === undefined ||
    draft === undefined ||
    !editOffered(host.rights, view)
  ) {
    return undefined;
  }
  const set = (step: string, next: { state: LiveOnceControl["state"]; error?: string }) =>
    setStates((current) => new Map(current).set(step, next));
  const switchOn = async (step: string) => {
    set(step, { state: "busy" });
    try {
      await writes.runLiveOnce(workflow, step, draft.revision);
      set(step, { state: "done" });
    } catch (failure) {
      set(step, {
        state: "idle",
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
    const held = states.get(step.id);
    return {
      state: held?.state ?? "idle",
      ...(held?.error === undefined ? {} : { error: held.error }),
      switchOn: () => {
        switchOn(step.id).catch(() => undefined);
      }
    };
  };
}
