import type { ReactNode } from "react";
import {
  Button,
  CodeBlock,
  IconTile,
  KeyValue,
  KeyValueList,
  RegistryIcon,
  SidePanel,
  type FlowGraphGroup,
  type FlowGraphNode
} from "@vivd-catalyst/ui";
import { formatMoment } from "../control-plane/locale-format";
import { useTranslation } from "../i18n";
import { FailureBanner } from "./failure-banner";
import { countsLine } from "./workflow-canvas-model";
import type {
  WorkflowLoopCounts,
  WorkflowOutputPreview,
  WorkflowStepRunView,
  WorkflowStepSource,
  WorkflowStepView
} from "./workflow-views";
import { RunStateBadge, durationText } from "./workflows-frame";

/** How many lines of what a step returned are shown. */
const OUTPUT_PREVIEW_LINES = 40;

/** The views of a step's panel. */
export type StepPanelTab = "what" | "run" | "entries";

/** What a run says about the step the panel is about. */
export interface StepPanelRun {
  /** The step's own step run. A step of a loop has one per entry and none of its own. */
  stepRun: WorkflowStepRunView | undefined;
  /** On a step of a loop: how the step runs of the entries stand. */
  counts: WorkflowLoopCounts | undefined;
  /** The loop those counts are of has ended: what they leave open will not run. */
  countsEnded?: boolean;
  now: Date;
}

/** The tabs a step's panel has: what it does, what the run made of it, and a loop's entries. */
export function stepPanelTabs(run: StepPanelRun | undefined): StepPanelTab[] {
  return [
    "what",
    ...(run !== undefined && (run.stepRun !== undefined || run.counts !== undefined)
      ? (["run"] as const)
      : []),
    ...(run?.stepRun?.loop === undefined ? [] : (["entries"] as const))
  ];
}

/** The start of a value as JSON, set out in lines where it is whole enough to be read. */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function OutputPreview({ output }: { output: WorkflowOutputPreview }) {
  const { t } = useTranslation();
  return (
    <CodeBlock
      label={t("workflows.run.output")}
      code={prettyJson(output.text)}
      lineNumbers={false}
      maxLines={OUTPUT_PREVIEW_LINES}
      footer={output.truncated ? t("workflows.run.shortened") : undefined}
    />
  );
}

/**
 * The panel about one step of the canvas. It says what the step does, and in a run what came
 * of it: its state and times, why it failed and what to do, and what it returned. The entries
 * of a loop are the caller's, who reads them.
 */
export function StepPanel({
  step,
  part,
  run,
  tab,
  onTabChange,
  entries,
  onOpenChild,
  onClose
}: {
  step: WorkflowStepView;
  /** The step as the canvas draws it: its icon, the words above its title and its title. */
  part: FlowGraphNode | FlowGraphGroup;
  run: StepPanelRun | undefined;
  tab: StepPanelTab;
  onTabChange(tab: StepPanelTab): void;
  /** The list of a loop's entries, shown on the tab "Entries". */
  entries: ReactNode;
  /** On a `workflow` step: opens the Workflow it starts, or the child run. */
  onOpenChild?(): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const tabs = stepPanelTabs(run);
  const shown = tabs.includes(tab) ? tab : "what";
  const labels: Record<StepPanelTab, string> = {
    what: t("workflows.panel.what"),
    run: t("workflows.panel.run"),
    entries: t("workflows.run.entries")
  };
  return (
    <SidePanel
      open
      data-step-panel={step.id}
      leading={
        <IconTile accent={part.accent}>
          <RegistryIcon name={part.icon} fallback={part.iconFallback} />
        </IconTile>
      }
      eyebrow={part.eyebrow}
      title={part.title}
      tabsLabel={t("workflows.panel.tabs")}
      // One view needs no tabs.
      tabs={
        tabs.length > 1
          ? // The entries' number stands on their filter, in full; a tab's count is capped.
            tabs.map((value) => ({ value, label: labels[value] }))
          : undefined
      }
      tab={shown}
      onTabChange={(value) => onTabChange(value === "run" || value === "entries" ? value : "what")}
      onClose={onClose}
    >
      {shown === "what" ? (
        <StepDescription step={step} summary={part.summary} onOpenChild={onOpenChild} />
      ) : shown === "run" && run !== undefined ? (
        <StepRunDetails step={step} run={run} onOpenChild={onOpenChild} />
      ) : (
        entries
      )}
    </SidePanel>
  );
}

function sourceWords(
  source: WorkflowStepSource,
  t: ReturnType<typeof useTranslation>["t"]
): string {
  switch (source.from) {
    case "run_input":
      return t("workflows.step.sourceInput");
    case "loop_entry":
      return source.itemName ?? t("workflows.step.sourceEntry");
    case "step":
      return t("workflows.step.sourceResult", { step: source.name });
  }
}

/** What a step does, as its definition says it. */
function StepDescription({
  step,
  summary,
  onOpenChild
}: {
  step: WorkflowStepView;
  summary: string | undefined;
  onOpenChild: (() => void) | undefined;
}) {
  const { locale, t } = useTranslation();
  const sentence = step.description ?? summary;
  const worksOn =
    step.source === undefined
      ? undefined
      : step.effect === "changing"
        ? t("workflows.panel.writesTo")
        : step.effect === "reading"
          ? t("workflows.panel.readsFrom")
          : t("workflows.panel.worksOn");
  const rows: { label: string; value: ReactNode }[] = [
    ...(step.starts === undefined
      ? []
      : [
          {
            label: t("workflows.panel.startedBy"),
            value: [
              step.starts.onSchedule ? t("workflows.panel.bySchedule") : undefined,
              step.starts.byHand ? t("workflows.panel.byHand") : undefined
            ]
              .filter((part) => part !== undefined)
              .join(", ")
          }
        ]),
    ...(worksOn === undefined ? [] : [{ label: worksOn, value: step.source }]),
    ...(step.kind === "loop" && step.itemName !== undefined
      ? [{ label: t("workflows.panel.forEach"), value: step.itemName }]
      : []),
    ...(step.concurrency === undefined
      ? []
      : [{ label: t("workflows.panel.atOnce"), value: step.concurrency.toLocaleString(locale) }]),
    ...(step.kind === "notify"
      ? [
          {
            label: t("workflows.panel.goesTo"),
            value: t(step.channel === "mail" ? "workflows.panel.mail" : "workflows.panel.inbox")
          }
        ]
      : []),
    ...(step.branches === undefined
      ? []
      : [
          {
            label: t("workflows.panel.paths"),
            value: step.branches
              .map(
                (branch) =>
                  branch.name ??
                  t(
                    branch.id === "then" ? "workflows.canvas.exitThen" : "workflows.canvas.exitElse"
                  )
              )
              .join(", ")
          }
        ]),
    ...(step.sources.length === 0
      ? []
      : [
          {
            label: t("workflows.panel.receives"),
            value: step.sources.map((source) => sourceWords(source, t)).join(", ")
          }
        ])
  ];
  return (
    <>
      {sentence === undefined ? null : <p data-step-sentence="">{sentence}</p>}
      {rows.length === 0 ? null : (
        <KeyValueList>
          {rows.map((row) => (
            <KeyValue key={row.label} label={row.label}>
              {row.value}
            </KeyValue>
          ))}
        </KeyValueList>
      )}
      {step.kind === "condition" || step.kind === "parallel" ? (
        <p className="text-caption text-muted-foreground">{t("workflows.panel.reserved")}</p>
      ) : null}
      {sentence === undefined && rows.length === 0 ? (
        <p className="text-muted-foreground">{t("workflows.panel.nothingMore")}</p>
      ) : null}
      {onOpenChild === undefined ? null : (
        <Button variant="outline" size="sm" className="justify-self-start" onClick={onOpenChild}>
          {t("workflows.panel.openWorkflow")}
        </Button>
      )}
    </>
  );
}

/** What a run made of a step. */
function StepRunDetails({
  step,
  run,
  onOpenChild
}: {
  step: WorkflowStepView;
  run: StepPanelRun;
  onOpenChild: (() => void) | undefined;
}) {
  const translation = useTranslation();
  const { locale, t } = translation;
  const { stepRun, counts } = run;
  if (stepRun === undefined) {
    // A step of a loop: one step run per entry, so the panel says how they stand together.
    return counts === undefined ? null : (
      <>
        <p>{countsLine(counts, translation, run.countsEnded) || t("workflows.panel.notReached")}</p>
        <p className="text-caption text-muted-foreground">{t("workflows.panel.perEntry")}</p>
      </>
    );
  }
  const took = durationText(stepRun, run.now, translation);
  const source = stepRun.source ?? step.source;
  return (
    <>
      <KeyValueList>
        <KeyValue label={t("workflows.panel.state")}>
          <RunStateBadge status={stepRun.status} />
        </KeyValue>
        {stepRun.startedAt === undefined ? null : (
          <KeyValue label={t("workflows.panel.started")}>
            {formatMoment(stepRun.startedAt, locale)}
          </KeyValue>
        )}
        {took === undefined ? null : <KeyValue label={t("workflows.panel.took")}>{took}</KeyValue>}
        {source === undefined ? null : (
          <KeyValue
            label={t(
              (stepRun.effect ?? step.effect) === "changing"
                ? "workflows.panel.writesTo"
                : "workflows.panel.readsFrom"
            )}
          >
            {source}
          </KeyValue>
        )}
        {stepRun.attempt > 1 ? (
          <KeyValue label={t("workflows.panel.attempts")}>
            {stepRun.attempt.toLocaleString(locale)}
          </KeyValue>
        ) : null}
      </KeyValueList>
      {stepRun.loop === undefined ? null : (
        <p>{countsLine(stepRun.loop, translation, stepRun.finishedAt !== undefined)}</p>
      )}
      {stepRun.failure ? <FailureBanner failure={stepRun.failure} /> : null}
      {stepRun.output ? <OutputPreview output={stepRun.output} /> : null}
      {onOpenChild !== undefined && stepRun.childRunId !== undefined ? (
        <Button variant="outline" size="sm" className="justify-self-start" onClick={onOpenChild}>
          {t("workflows.panel.openRun")}
        </Button>
      ) : null}
    </>
  );
}
