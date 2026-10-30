import { useState } from "react";
import { WORKFLOW_PINNABLE_STEP_TYPES } from "@work-shape/catalyst-core";
import { Button, InlineError } from "@work-shape/catalyst-ui";
import { instanceSentence, readRefusalDetails } from "../build-area/build-refusals";
import { formatMoment } from "../../shared/locale-format";
import { useTranslation } from "../../shared/i18n";
import { useStepPinList, useStepPinWrites, workflowWriteRefusal } from "./workflow-data";
import { editOffered } from "./workflow-model";
import type { WorkflowStepRunView, WorkflowStepView, WorkflowView } from "./workflow-views";
import { useWorkflowsHost } from "./workflows-host";

// Pinned step outputs (EW-10): a person who may write a Workflow pins the output a step had in
// a run, and their test runs of the draft end that step with it instead of running it. The
// instance keeps the pin and clears it once the step changes; the screens only show and set it.

/** The kinds of step whose output can be pinned: those that call, think or compute something. */
const PINNABLE_KINDS: ReadonlySet<string> = new Set(WORKFLOW_PINNABLE_STEP_TYPES);

/** The reader's pin on one step, as a step's panel offers it. */
export interface StepPinControl {
  /** The reader's pin on the step: the run its output is from, and when it was pinned. */
  pinned?: { runId: string; pinnedAt: string };
  /** The run the panel shows is the one the pin's output is from. */
  fromThisRun: boolean;
  /** The step's output in the run the panel shows can be pinned. */
  pinnable: boolean;
  busy: boolean;
  error?: string;
  pin(): void;
  unpin(): void;
  /** Opens the run the pin's output is from. */
  openRun(runId: string): void;
}

/**
 * The pins of the reader's on the draft of a Workflow, per step. With `runId`, on a run's page:
 * a step outside every block that ended `done` in that run can be pinned. Without, on the
 * Workflow's page: only a step that is pinned has a control. Nothing for a reader who may not
 * write the Workflow, or where the reader is not shown its draft.
 */
export function useStepPins(
  workflow: string,
  view: Pick<WorkflowView, "draft" | "allowed" | "ownerWorkspaceId"> | undefined,
  runId?: string
):
  | ((
      step: WorkflowStepView,
      stepRun: WorkflowStepRunView | undefined,
      inBlock: boolean
    ) => StepPinControl | undefined)
  | undefined {
  const { t } = useTranslation();
  const host = useWorkflowsHost();
  const writes = useStepPinWrites();
  const draft = view?.draft;
  const offered =
    host !== undefined &&
    writes !== undefined &&
    draft !== undefined &&
    editOffered(host.rights, view);
  const pins = useStepPinList(workflow, offered, draft?.revision);
  const [pending, setPending] = useState<ReadonlyMap<string, { busy: boolean; error?: string }>>(
    new Map()
  );
  const workspaceId = host?.workspace?.id;
  if (!offered || host === undefined || writes === undefined || workspaceId === undefined) {
    return undefined;
  }
  const set = (step: string, next: { busy: boolean; error?: string }) =>
    setPending((current) => new Map(current).set(step, next));
  const change = async (step: string, write: () => Promise<void>, failed: string) => {
    set(step, { busy: true });
    try {
      await write();
      set(step, { busy: false });
    } catch (failure) {
      set(step, { busy: false, error: pinRefusal(failure, failed, t) });
    }
  };
  return (step, stepRun, inBlock) => {
    if (!PINNABLE_KINDS.has(step.kind) || inBlock) {
      return undefined;
    }
    const pinned = pins?.find((pin) => pin.step === step.id);
    const pinnable =
      runId !== undefined &&
      stepRun?.status === "done" &&
      stepRun.containerStepRunId === undefined &&
      stepRun.iteration === undefined;
    if (pinned === undefined && !pinnable) {
      return undefined;
    }
    const held = pending.get(step.id);
    return {
      ...(pinned === undefined
        ? {}
        : { pinned: { runId: pinned.runId, pinnedAt: pinned.pinnedAt } }),
      fromThisRun: pinned !== undefined && pinned.runId === runId,
      pinnable,
      busy: held?.busy === true,
      ...(held?.error === undefined ? {} : { error: held.error }),
      pin: () => {
        if (runId === undefined) return;
        change(
          step.id,
          () => writes.pin(workflow, step.id, runId),
          t("workflows.pin.failed")
        ).catch(() => undefined);
      },
      unpin: () => {
        change(
          step.id,
          () => writes.unpin(workflow, step.id),
          t("workflows.pin.unpinFailed")
        ).catch(() => undefined);
      },
      openRun: (run) =>
        host.showRoute({
          kind: "workflow-run",
          collaborationWorkspaceId: workspaceId,
          workflow,
          run
        })
    };
  };
}

/** The sentence for a refused pin or unpin. */
function pinRefusal(
  failure: unknown,
  fallback: string,
  t: ReturnType<typeof useTranslation>["t"]
): string {
  switch (readRefusalDetails(failure).reason) {
    case "pin_step_changed":
      return t("workflows.pin.changed");
    case "pin_output_gone":
      return t("workflows.pin.gone");
    case "pin_output_not_portable":
      return t("workflows.pin.notPortable");
  }
  return workflowWriteRefusal(failure) === "refused"
    ? t("workflows.test.refused")
    : (instanceSentence(failure, t) ?? fallback);
}

/** A step's pin in its panel: where its output comes from in test runs, and the way to change it. */
export function StepPin({
  control,
  sameAsRun = false
}: {
  control: StepPinControl;
  /**
   * The run shown took the step's output from the very run the pin names: its mark already
   * leads there, and its output is the pinned one.
   */
  sameAsRun?: boolean;
}) {
  const { locale, t } = useTranslation();
  const { pinned } = control;
  return (
    <section
      data-step-pin={pinned === undefined ? "off" : control.fromThisRun ? "this-run" : "other-run"}
      className="grid justify-items-start gap-2"
    >
      {pinned === undefined ? null : (
        <p className="text-body">
          {control.fromThisRun
            ? t("workflows.pin.fromThisRun")
            : t("workflows.pin.fromRun", { time: formatMoment(pinned.pinnedAt, locale) })}
        </p>
      )}
      {pinned === undefined && control.pinnable ? (
        <p className="text-caption text-muted-foreground">{t("workflows.pin.hint")}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {control.pinnable && !control.fromThisRun && !sameAsRun ? (
          <Button variant="outline" size="sm" loading={control.busy} onClick={control.pin}>
            {t(pinned === undefined ? "workflows.pin.button" : "workflows.pin.instead")}
          </Button>
        ) : null}
        {pinned === undefined ? null : (
          <Button variant="outline" size="sm" loading={control.busy} onClick={control.unpin}>
            {t("workflows.pin.unpin")}
          </Button>
        )}
        {pinned === undefined || control.fromThisRun || sameAsRun ? null : (
          <Button variant="ghost" size="sm" onClick={() => control.openRun(pinned.runId)}>
            {t("workflows.pin.openRun")}
          </Button>
        )}
      </div>
      {control.error === undefined ? null : <InlineError>{control.error}</InlineError>}
    </section>
  );
}
