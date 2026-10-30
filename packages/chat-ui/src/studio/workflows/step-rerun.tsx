import { RotateCw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button, Dialog, InlineError } from "@work-shape/catalyst-ui";
import { instanceSentence } from "../build-area/build-refusals";
import { useTranslation } from "../../shared/i18n";
import { useRerunSteps, useRerunWrite, workflowWriteRefusal } from "./workflow-data";
import { editOffered } from "./workflow-model";
import type { WorkflowRunView, WorkflowStepView, WorkflowView } from "./workflow-views";
import { useWorkflowsHost } from "./workflows-host";

// Re-running an ended run from a chosen step (EW-11): the steps before the chosen one keep the
// outputs they had, and the chosen step and those after it run again. The instance decides
// from which steps a run can be re-run; the screens show its answer and start the new run.

/** "Run again from here" on one step of an ended run, as a step's panel offers it. */
export interface StepRerunControl {
  /** The run can be re-run from this step. */
  offered: boolean;
  /** The step changed since the run: a re-run from here runs it as it is now. */
  changed: boolean;
  /** Why the run cannot be re-run from this step, in a sentence. Missing where it can. */
  refusal?: string;
  /** Asks once, then starts the new run and opens its page. */
  start(): void;
}

/**
 * "Run again from here" per step on the page of an ended run, with the question it asks. A
 * live run is re-run by a reader who may start its Workflow, a test run by one who may write it.
 * Nothing where neither, where the run is going, or where the source re-runs nothing.
 */
export function useStepRerun(
  workflow: string,
  view: WorkflowView | undefined,
  run: WorkflowRunView | undefined
): {
  control?: (step: WorkflowStepView, inBlock: boolean) => StepRerunControl | undefined;
  dialog: ReactNode;
} {
  const { t } = useTranslation();
  const host = useWorkflowsHost();
  const rerun = useRerunWrite();
  const [asking, setAsking] = useState<WorkflowStepView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ended = run !== undefined && (run.status === "done" || run.status === "failed");
  const may =
    host !== undefined &&
    view !== undefined &&
    (run?.test === true
      ? editOffered(host.rights, view)
      : view.mayStart && view.published && view.refusedFor.length === 0);
  const offered = ended && may && rerun !== undefined && run.parent === undefined;
  // A test run is re-run on the draft, a live one on what is published: either changes the answer.
  const steps = useRerunSteps(
    run?.id ?? "",
    offered,
    run?.test === true ? view?.draft?.revision : view?.revisionId
  );
  const workspaceId = host?.workspace?.id;
  if (!offered || steps === undefined || workspaceId === undefined || run === undefined) {
    return { dialog: null };
  }
  const nameOf = (id: string | undefined) =>
    view?.steps.find((step) => step.id === id)?.name ?? id ?? "";
  const confirm = async (step: WorkflowStepView) => {
    setBusy(true);
    setError(undefined);
    try {
      const started = await rerun(run.id, step.id);
      setAsking(undefined);
      host.showRoute({
        kind: "workflow-run",
        collaborationWorkspaceId: workspaceId,
        workflow,
        run: started.id
      });
    } catch (failure) {
      setError(
        workflowWriteRefusal(failure) === "refused"
          ? t("workflows.test.refused")
          : (instanceSentence(failure, t) ?? t("workflows.rerun.failed"))
      );
    } finally {
      setBusy(false);
    }
  };
  return {
    control: (step, inBlock) => {
      const answer = inBlock ? undefined : steps.find((entry) => entry.step === step.id);
      // The trigger, a step inside a block, and a run the instance re-runs from no step at all.
      if (
        answer === undefined ||
        answer.refusal?.code === "rerun_step_not_offered" ||
        answer.refusal?.code === "rerun_not_supported"
      ) {
        return undefined;
      }
      const why = answer.refusal?.step === undefined ? undefined : nameOf(answer.refusal.step);
      const refusal =
        answer.refusal === undefined
          ? undefined
          : answer.refusal.code === "rerun_step_changed"
            ? t("workflows.rerun.changed", { step: why ?? "" })
            : answer.refusal.code === "rerun_output_not_portable"
              ? t("workflows.rerun.notPortable", { step: why ?? "" })
              : why === undefined
                ? t("workflows.rerun.dataGone")
                : t("workflows.rerun.outputGone", { step: why });
      return {
        offered: refusal === undefined,
        changed: answer.changed,
        ...(refusal === undefined ? {} : { refusal }),
        start: () => {
          setError(undefined);
          setAsking(step);
        }
      };
    },
    dialog:
      asking === undefined ? null : (
        <Dialog
          open
          size="sm"
          title={t("workflows.rerun.confirmTitle", { step: asking.name })}
          onClose={() => setAsking(undefined)}
          footer={
            <>
              <Button variant="outline" disabled={busy} onClick={() => setAsking(undefined)}>
                {t("workflows.rerun.keep")}
              </Button>
              <Button
                loading={busy}
                onClick={() => {
                  confirm(asking).catch(() => undefined);
                }}
              >
                {t("workflows.rerun.confirm")}
              </Button>
            </>
          }
        >
          <p className="text-body text-muted-foreground">
            {t(run.test ? "workflows.rerun.confirmBodyTest" : "workflows.rerun.confirmBody", {
              step: asking.name
            })}
          </p>
          {error ? <InlineError className="mt-3">{error}</InlineError> : null}
        </Dialog>
      )
  };
}

/** "Run again from here" in a step's panel, or why the run is not re-run from the step. */
export function StepRerun({ control }: { control: StepRerunControl }) {
  const { t } = useTranslation();
  return (
    <section
      data-step-rerun={control.offered ? "offered" : "refused"}
      className="grid justify-items-start gap-2"
    >
      {control.offered ? (
        <>
          <Button variant="outline" size="sm" onClick={control.start}>
            <RotateCw aria-hidden="true" />
            {t("workflows.rerun.button")}
          </Button>
          <p className="text-caption text-muted-foreground">
            {t(control.changed ? "workflows.rerun.hintChanged" : "workflows.rerun.hint")}
          </p>
        </>
      ) : (
        <p className="text-caption text-muted-foreground">{control.refusal}</p>
      )}
    </section>
  );
}
