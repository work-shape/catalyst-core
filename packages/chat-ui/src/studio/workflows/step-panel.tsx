import type { ReactNode } from "react";
import {
  Banner,
  Button,
  CodeBlock,
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  IconTile,
  InlineError,
  KeyValue,
  KeyValueList,
  RegistryIcon,
  SidePanel,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TargetBadge,
  type FlowGraphGroup,
  type FlowGraphNode
} from "@work-shape/catalyst-ui";
import { formatMoment } from "../../shared/locale-format";
import { useTranslation } from "../../shared/i18n";
import { FailureBanner } from "./failure-banner";
import { recipientsLine } from "./recipient-names";
import type { LiveOnceControl } from "./test-run";
import { StepDatasets } from "./step-datasets";
import { simulatedCall, stepDatasets, stepOutputRows } from "./step-output";
import { countsLine } from "./workflow-canvas-model";
import { stepConnection, stepFallbackSentence } from "./workflow-model";
import type {
  WorkflowDatasetView,
  WorkflowLoopCounts,
  WorkflowOutputPreview,
  WorkflowStepRunView,
  WorkflowStepSource,
  WorkflowStepView
} from "./workflow-views";
import { RunStateBadge, durationText } from "./workflows-frame";
import { useRecipientNames } from "./workflows-host";

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
  /** The loop that runs once for each entry of what the step returned, and how many those are. */
  passesOn?: { count: number; step: string };
  /** In a test run, on a step that changes something: "Run live once" for the next test run. */
  liveOnce?: LiveOnceControl;
  /** The run's datasets: what an output names that an earlier step wrote. */
  runDatasets?: readonly WorkflowDatasetView[];
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

/** What a step returned, as text: the start of it, set out in lines. */
function OutputText({ output, label }: { output: WorkflowOutputPreview; label: string }) {
  const { t } = useTranslation();
  return (
    <CodeBlock
      label={label}
      code={prettyJson(output.text)}
      lineNumbers={false}
      maxLines={OUTPUT_PREVIEW_LINES}
      footer={output.truncated ? t("workflows.run.shortened") : undefined}
    />
  );
}

/** The output as text behind a fold, below what the panel made of it. */
function OutputDetails({ output }: { output: WorkflowOutputPreview }) {
  const { t } = useTranslation();
  return (
    <Disclosure>
      <DisclosureTrigger>{t("workflows.technicalDetails")}</DisclosureTrigger>
      <DisclosureContent>
        <OutputText output={output} label={t("workflows.run.outputText")} />
      </DisclosureContent>
    </Disclosure>
  );
}

/**
 * What a step returned. Datasets it names say their counts, size and columns; a list of records
 * is a table of its first rows. Either has the text behind a fold; anything else is the text. A
 * step run carries the start of its output and no count, so the number of rows of a list is
 * said only where the whole list arrived.
 */
function OutputPreview({
  output,
  datasets
}: {
  output: WorkflowOutputPreview;
  /** The records of the datasets the step and the run wrote. */
  datasets: readonly WorkflowDatasetView[];
}) {
  const { locale, t } = useTranslation();
  const named = stepDatasets(output, datasets);
  if (named.length > 0) {
    return (
      <>
        <StepDatasets datasets={named} />
        <OutputDetails output={output} />
      </>
    );
  }
  const table = stepOutputRows(output);
  if (table === undefined) {
    return <OutputText output={output} label={t("workflows.run.output")} />;
  }
  const shown = table.rows.length.toLocaleString(locale);
  return (
    <section data-step-output="" className="grid min-w-0 gap-2">
      <h3 className="text-caption font-medium text-muted-foreground">
        {t("workflows.run.output")}
      </h3>
      <Table density="compact" stickyHeader>
        <TableHeader>
          <TableRow>
            {table.columns.map((column) => (
              <TableHead key={column}>{column}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {table.rows.map((row, index) => (
            // The rows of an output have no id of their own; their order does not change.
            <TableRow key={index}>
              {row.map((value, column) => (
                <TableCell key={table.columns[column]} truncate={24}>
                  {value}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-caption text-muted-foreground">
        {table.total === undefined
          ? t("workflows.run.rowsFirst", { shown })
          : table.total > table.rows.length
            ? t("workflows.run.rowsOf", { shown, total: table.total.toLocaleString(locale) })
            : t("workflows.run.rowsAll", { shown })}
      </p>
      <OutputDetails output={output} />
    </section>
  );
}

/**
 * The panel about one step of the canvas. It says what the step does, and in a run what came
 * of it: its state and times, why it failed and what to do, and what it returned. The entries
 * of a loop are the caller's, who reads them.
 */
export function StepPanel({
  step,
  account,
  part,
  run,
  tab,
  onTabChange,
  entries,
  onOpenChild,
  onClose
}: {
  step: WorkflowStepView;
  /** The label of the account the Workflow runs as, for a refusal that names it. */
  account?: string | undefined;
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
        <StepRunDetails step={step} account={account} run={run} onOpenChild={onOpenChild} />
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
  const recipientNames = useRecipientNames();
  const recipients =
    step.kind === "notify" ? recipientsLine(step.to, recipientNames, { t, locale }) : undefined;
  // A Notify node's line names its recipients, which the panel lists in a row of their own.
  const fallback = stepFallbackSentence(step);
  const sentence =
    step.description ??
    (recipients === undefined ? summary : fallback === undefined ? undefined : t(fallback));
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
    ...(recipients === undefined
      ? []
      : [{ label: t("workflows.panel.recipients"), value: recipients }]),
    ...(step.kind === "notify"
      ? [
          {
            label: t("workflows.panel.delivered"),
            value: t(
              step.channel === "mail" ? "workflows.panel.viaMail" : "workflows.panel.viaInbox"
            )
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
  account,
  run,
  onOpenChild
}: {
  step: WorkflowStepView;
  account: string | undefined;
  run: StepPanelRun;
  onOpenChild: (() => void) | undefined;
}) {
  const translation = useTranslation();
  const { locale, t } = translation;
  const { stepRun, counts } = run;
  if (stepRun === undefined) {
    // A step of a loop: one step run per entry, so the panel says how they stand together. Its
    // entries say where each call went and what a published run would ask.
    return counts === undefined ? null : (
      <>
        <p>{countsLine(counts, translation, run.countsEnded) || t("workflows.panel.notReached")}</p>
        <p className="text-caption text-muted-foreground">{t("workflows.panel.perEntry")}</p>
        {run.liveOnce === undefined ? null : <LiveOnce control={run.liveOnce} />}
      </>
    );
  }
  const took = durationText(stepRun, run.now, translation);
  const source = stepRun.source ?? step.source;
  return (
    <>
      <KeyValueList>
        <KeyValue label={t("workflows.panel.state")}>
          <RunStateBadge
            status={stepRun.status}
            withFailedEntries={(stepRun.loop?.failed ?? 0) > 0}
          />
        </KeyValue>
        {stepRun.startedAt === undefined ? null : (
          <KeyValue label={t("workflows.panel.started")}>
            {formatMoment(stepRun.startedAt, locale)}
          </KeyValue>
        )}
        {took === undefined ? null : <KeyValue label={t("workflows.panel.took")}>{took}</KeyValue>}
        {stepRun.target === undefined ? null : (
          <KeyValue label={t("workflows.target.label")}>
            <TargetBadge target={stepRun.target} />
          </KeyValue>
        )}
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
        {run.passesOn === undefined ? null : (
          <KeyValue label={t("workflows.panel.passesOn")}>
            {t("workflows.panel.passesOnTo", {
              count: run.passesOn.count.toLocaleString(locale),
              step: run.passesOn.step
            })}
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
      {stepRun.failure ? (
        <FailureBanner
          failure={stepRun.failure}
          account={account}
          connection={stepConnection(step, stepRun)}
        />
      ) : null}
      {stepRun.publishedWouldAsk === "approval" ? <PublishedAsksApproval /> : null}
      {run.liveOnce === undefined ? null : <LiveOnce control={run.liveOnce} />}
      {stepRun.target === "dry_run" ? (
        <SimulatedOutput output={stepRun.output} />
      ) : stepRun.output ? (
        <OutputPreview
          output={stepRun.output}
          datasets={[...(stepRun.datasets ?? []), ...(run.runDatasets ?? [])]}
        />
      ) : null}
      {onOpenChild !== undefined && stepRun.childRunId !== undefined ? (
        <Button variant="outline" size="sm" className="justify-self-start" onClick={onOpenChild}>
          {t("workflows.panel.openRun")}
        </Button>
      ) : null}
    </>
  );
}

/**
 * Says that the test passed where a run of the published revision would stop and ask for an
 * approval: the tester's own start was the confirmation, and a published run has nobody there.
 */
function PublishedAsksApproval() {
  const { t } = useTranslation();
  return (
    <Banner tone="warning" layout="inline" data-published-asks="approval">
      {t("workflows.run.publishedAsksApproval")}
    </Banner>
  );
}

/** What a simulated step would have done, in sentences: nothing of it was changed. */
function SimulatedOutput({ output }: { output: WorkflowOutputPreview | undefined }) {
  const { t } = useTranslation();
  const call = simulatedCall(output);
  return (
    <section data-simulated="" className="grid min-w-0 gap-2">
      <p>
        {call === undefined
          ? t("workflows.simulated.nothing")
          : t("workflows.simulated.would", { operation: call.operation })}
      </p>
      {call?.wouldAsk === undefined ? null : (
        <p className="text-caption text-muted-foreground">
          {t(
            call.wouldAsk === "approval"
              ? "workflows.simulated.wouldAskApproval"
              : "workflows.simulated.wouldAskConfirmation"
          )}
        </p>
      )}
      {call === undefined || call.values.length === 0 ? null : (
        <KeyValueList>
          {call.values.map(([name, value]) => (
            <KeyValue key={name} label={name}>
              {value}
            </KeyValue>
          ))}
        </KeyValueList>
      )}
    </section>
  );
}

/** "Run live once" for a step of a test run: the step runs for real in the reader's next one. */
function LiveOnce({ control }: { control: LiveOnceControl }) {
  const { locale, t } = useTranslation();
  const offered = control.state === "off" || control.state === "busy" || control.state === "used";
  return (
    <section data-live-once={control.state} className="grid justify-items-start gap-2">
      {control.state === "set" ? <p className="text-body">{t("workflows.liveOnce.done")}</p> : null}
      {control.used === undefined ? null : (
        <p className="text-body">
          {t("workflows.liveOnce.used", { time: formatMoment(control.used.at, locale) })}
        </p>
      )}
      {offered ? (
        <>
          <p className="text-caption text-muted-foreground">{t("workflows.liveOnce.hint")}</p>
          <Button
            variant="outline"
            size="sm"
            loading={control.state === "busy"}
            onClick={control.switchOn}
          >
            {t(
              control.used === undefined ? "workflows.liveOnce.button" : "workflows.liveOnce.again"
            )}
          </Button>
        </>
      ) : null}
      {control.error === undefined ? null : <InlineError>{control.error}</InlineError>}
    </section>
  );
}
