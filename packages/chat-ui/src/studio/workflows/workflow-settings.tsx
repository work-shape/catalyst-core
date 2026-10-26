import { useState, type ReactNode } from "react";
import {
  Banner,
  Button,
  Field,
  FieldListEditor,
  Input,
  KeyValue,
  KeyValueList,
  LoadError,
  SaveBar,
  ScheduleField,
  Switch,
  Textarea,
  TextLink,
  type FieldListItem,
  type FieldListKind,
  type ScheduleValue
} from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";
import { cronSchedule, scheduleCron } from "./schedule-cron";
import { scheduleInWords, withZone } from "./schedule-words";
import { fieldsSchema, schemaFields, withKeys } from "./schema-fields";
import { useStartRun } from "./start-run";
import { WorkflowAppCallers } from "./workflow-app-callers";
import { sameValue, WORKFLOW_FIELDS, type WorkflowManifest } from "./step-edits";
import { fieldListState, leftField } from "./step-settings-parts";
import { useRunsAvailable, useWorkflow, type WorkflowReadProblem } from "./workflow-data";
import {
  useEditWithAgent,
  useWorkflowDraft,
  WorkflowDraftBar,
  type WorkflowDraftBarState,
  type WorkflowEdit
} from "./workflow-draft";
import { useWorkflowEditing, type WorkflowEditing } from "./workflow-editing";
import { WorkflowHead } from "./workflow-head";
import { editOffered, runsReadable, startOffered } from "./workflow-model";
import type { WorkflowCallerView, WorkflowView } from "./workflow-views";
import { WorkflowsFrame, routeLink, type OpenRoute } from "./workflows-frame";
import { useWorkflowsHost } from "./workflows-host";

// The Settings tab of a Workflow (workflow-canvas 9.7, WF-EDIT-5): its name and what it does,
// when it starts, and what it asks for when started, which a holder of `workflow.write` changes
// on the draft with one Save; the result, the failure notice, the limits, the account, the owner
// and who may start it as read-only lines. Everyone else reads the same, read-only. A schedule
// the field cannot read is left as it is.

type Translate = TranslationContextValue["t"];
type Trigger = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The kinds a start form asks for, by the names `schemaFields` gives them. */
const INPUT_KINDS = ["text", "number", "integer", "boolean", "choice"] as const;

function inputKinds(t: Translate): FieldListKind[] {
  return [
    { value: "text", label: t("workflows.settings.answerKindText") },
    { value: "number", label: t("workflows.settings.answerKindNumber") },
    { value: "integer", label: t("workflows.settings.answerKindInteger") },
    { value: "boolean", label: t("workflows.settings.answerKindBoolean") },
    { value: "choice", label: t("workflows.settings.answerKindChoice"), choices: true }
  ];
}

/** The fields of `inputs` as the start form asks for them, or nothing where the form cannot. */
function inputFields(schema: unknown): FieldListItem[] | undefined {
  const items = schemaFields(schema);
  return items?.every((item) => INPUT_KINDS.some((kind) => kind === item.kind)) ? items : undefined;
}

/** The trigger step of a manifest: the first step, which starts every run. */
function triggerStep(manifest: WorkflowManifest): Readonly<Record<string, unknown>> | undefined {
  const steps = Array.isArray(manifest.steps) ? manifest.steps : [];
  const step: unknown = steps.find((entry) => isRecord(entry) && entry.type === "trigger");
  return isRecord(step) && typeof step.id === "string" ? step : undefined;
}

function triggersOf(step: Readonly<Record<string, unknown>> | undefined): Trigger[] {
  return Array.isArray(step?.triggers) ? step.triggers.filter(isRecord) : [];
}

/** The triggers with one kind on or off: one turned on is added at the end. */
function switched(triggers: readonly Trigger[], kind: string, on: boolean): Trigger[] {
  const has = triggers.some((trigger) => trigger.kind === kind);
  if (on === has) return [...triggers];
  return on ? [...triggers, { kind }] : triggers.filter((trigger) => trigger.kind !== kind);
}

/** A limit a Workflow raises, in words. */
function limitWords(limits: unknown, t: Translate): string[] {
  if (!isRecord(limits)) return [];
  const words: string[] = [];
  const duration = /^(\d+)([mhd])$/u.exec(text(limits.duration));
  if (duration !== null) {
    const count = Number(duration[1]);
    words.push(
      t(
        duration[2] === "m"
          ? "workflows.workflowSettings.limitMinutes"
          : duration[2] === "h"
            ? "workflows.workflowSettings.limitHours"
            : "workflows.workflowSettings.limitDays",
        { count }
      )
    );
  }
  const counted = [
    ["stepRuns", "workflows.workflowSettings.limitStepRuns"],
    ["loopItems", "workflows.workflowSettings.limitLoopItems"],
    ["concurrency", "workflows.workflowSettings.limitConcurrency"],
    ["pagedStepMinutes", "workflows.workflowSettings.limitPagedMinutes"]
  ] as const;
  for (const [field, key] of counted) {
    const count = limits[field];
    if (typeof count === "number") words.push(t(key, { count }));
  }
  if (typeof limits.datasetBytes === "number") {
    const megabytes = Math.round((limits.datasetBytes / 1_000_000) * 10) / 10;
    words.push(t("workflows.workflowSettings.limitDataset", { size: megabytes }));
  }
  return words;
}

/** What a run gives back, by the titles or names of the fields of `outputs`. */
function resultWords(outputs: unknown, t: Translate): string {
  const properties = isRecord(outputs) && isRecord(outputs.properties) ? outputs.properties : {};
  const names = Object.entries(properties).map(([name, field]) =>
    isRecord(field) && text(field.title) !== "" ? text(field.title) : name
  );
  return names.length === 0 ? t("workflows.workflowSettings.resultNone") : names.join(", ");
}

/** The Settings of one Workflow: the third tab of its page. */
export function WorkflowSettingsPage({ workflow }: { workflow: string }) {
  const host = useWorkflowsHost();
  const workspaceId = host?.workspace?.id;
  const read = useWorkflow(workspaceId, workflow);
  const runsAvailable = useRunsAvailable();
  const start = useStartRun({
    workflow,
    name: read.workflow?.name,
    form: read.workflow?.startForm
  });
  const edit = useEditWithAgent(workflow, read.workflow);
  const draft = useWorkflowDraft(workflow, read.workflow);
  const editing = useWorkflowEditing({
    workspaceId: workspaceId ?? "",
    workflowId: workflow,
    workflow: read.workflow,
    mayWrite: host !== undefined && editOffered(host.rights, read.workflow)
  });
  if (!host || workspaceId === undefined) return null;
  return (
    <>
      <WorkflowSettingsPageView
        workspaceId={workspaceId}
        workflowId={workflow}
        workflow={read.workflow}
        problem={
          read.problem === undefined ? undefined : { problem: read.problem, retry: read.retry }
        }
        runsAvailable={runsAvailable}
        readsRuns={runsReadable(host.rights, read.workflow)}
        edit={edit}
        editing={editing}
        draft={draft.bar}
        onStart={start.open}
        onOpenRoute={host.showRoute}
      />
      {start.dialog}
      {draft.dialog}
    </>
  );
}

/** The Settings page of a Workflow for a given record and reader. */
export function WorkflowSettingsPageView({
  workspaceId,
  workflowId,
  workflow,
  problem,
  runsAvailable,
  readsRuns,
  edit,
  editing,
  draft,
  onStart,
  onOpenRoute
}: {
  workspaceId: string;
  workflowId: string;
  workflow: WorkflowView | undefined;
  problem?: { problem: WorkflowReadProblem; retry(): void };
  runsAvailable: boolean;
  readsRuns: boolean;
  edit?: WorkflowEdit;
  /** Editing by hand, for a reader who may write the Workflow. Read-only without it. */
  editing?: WorkflowEditing;
  draft?: WorkflowDraftBarState;
  onStart(): void;
  onOpenRoute: OpenRoute;
}) {
  const { t } = useTranslation();
  const canStart = runsAvailable && workflow !== undefined && startOffered(workflow);
  return (
    <WorkflowsFrame
      label={workflow?.name ?? t("workflows.title")}
      testId="workflow-settings-page"
      fill
    >
      <WorkflowHead
        workspaceId={workspaceId}
        workflowId={workflowId}
        workflow={workflow}
        tab="settings"
        runsShown={runsAvailable && readsRuns}
        canStart={canStart}
        edit={edit}
        onStart={onStart}
        onOpenRoute={onOpenRoute}
      />
      {draft === undefined ? null : <WorkflowDraftBar {...draft} />}
      <div className="min-h-0 flex-1 overflow-y-auto px-(--layout-gutter) pt-5 pb-(--layout-page-end)">
        {problem?.problem === "failed" ? (
          <LoadError onRetry={problem.retry}>{t("workflows.failed")}</LoadError>
        ) : problem !== undefined ? (
          <p className="text-body text-muted-foreground">
            {t(problem.problem === "missing" ? "workflows.missing" : "workflows.unavailable")}
          </p>
        ) : workflow === undefined ? null : (
          <WorkflowSettingsForm
            workspaceId={workspaceId}
            workflow={workflow}
            editing={editing}
            edit={edit}
            onOpenRoute={onOpenRoute}
          />
        )}
      </div>
    </WorkflowsFrame>
  );
}

/** The schedule the field shows, kept while it holds no whole schedule yet. */
interface ShownSchedule {
  /** The cron and zone it was read from, so a value saved elsewhere replaces it. */
  cron: string;
  zone: string;
  value: ScheduleValue;
}

/** The form of a Workflow's Settings, editable where `editing` is given. */
export function WorkflowSettingsForm({
  workspaceId,
  workflow,
  editing,
  edit,
  onOpenRoute
}: {
  workspaceId: string;
  workflow: WorkflowView;
  editing?: WorkflowEditing;
  edit?: WorkflowEdit;
  onOpenRoute: OpenRoute;
}) {
  const translation = useTranslation();
  const { t } = translation;
  const host = useWorkflowsHost();
  const manifest: WorkflowManifest = editing?.manifest ??
    workflow.definition?.manifest ?? { name: workflow.name, description: workflow.description };
  const readOnly = editing === undefined;
  const trigger = triggerStep(manifest);
  const triggerId = text(trigger?.id);
  const triggers = triggersOf(trigger);
  const has = (kind: string) => triggers.some((entry) => entry.kind === kind);
  const schedule = triggers.find((entry) => entry.kind === "schedule");
  const instanceZone = host?.instanceTimeZone?.timeZone ?? "UTC";
  const cron = text(schedule?.cron);
  const zone = text(schedule?.timeZone) || instanceZone;
  const read = schedule === undefined ? undefined : cronSchedule(cron, zone);
  const [shown, setShown] = useState<ShownSchedule | undefined>(
    read === undefined ? undefined : { cron, zone, value: read }
  );
  // A schedule written elsewhere replaces what the field shows; one not whole yet stays shown,
  // since the draft still holds the schedule it was read from.
  if (read !== undefined && (shown === undefined || shown.cron !== cron || shown.zone !== zone)) {
    setShown({ cron, zone, value: read });
  }
  const name = text(manifest.name);
  const set = (fields: Record<string, unknown>) => editing?.set(WORKFLOW_FIELDS, fields);
  const setTriggers = (next: Trigger[]) => {
    if (triggerId !== "") editing?.set(triggerId, { triggers: next });
  };
  const writeSchedule = (value: ScheduleValue) => {
    const written = scheduleCron(value);
    setShown({ cron: written ?? cron, zone: value.zone, value });
    // A schedule that is not whole yet holds the save back and writes nothing.
    editing?.hold(triggerId, "schedule", written === undefined);
    if (written === undefined) return;
    setTriggers(
      triggers.map((entry) =>
        entry.kind === "schedule" ? { ...entry, cron: written, timeZone: value.zone } : entry
      )
    );
  };
  const turnSchedule = (on: boolean) => {
    if (!on) {
      editing?.hold(triggerId, "schedule", false);
      setTriggers(switched(triggers, "schedule", false));
      return;
    }
    const value: ScheduleValue = shown?.value ?? {
      kind: "weekday",
      time: "09:00",
      zone: instanceZone
    };
    setShown({ cron: scheduleCron(value) ?? "", zone: value.zone, value });
    setTriggers([
      ...triggers,
      { kind: "schedule", cron: scheduleCron(value) ?? "", timeZone: value.zone }
    ]);
  };
  const onCount = ["schedule", "manual", "parent", "outside"].filter(has).length;
  // At least one way to start stays on: the last one cannot be turned off here.
  const lastOn = (kind: string) => onCount === 1 && has(kind);
  const changeWithAgent =
    edit === undefined ? null : (
      <Button
        variant="outline"
        size="sm"
        className="w-fit"
        disabled={edit.busy}
        onClick={() =>
          edit.startWith(t("workflows.workflowSettings.agentPrompt", { name: workflow.name }))
        }
      >
        {t("workflows.settings.changeWithAgent")}
      </Button>
    );
  const switchRow = (kind: string, label: string, hint?: string) => (
    <Field layout="inline" label={label} {...(hint === undefined ? {} : { hint })}>
      <Switch
        checked={has(kind)}
        disabled={readOnly || triggerId === "" || (has(kind) && lastOn(kind))}
        onCheckedChange={(on) =>
          kind === "schedule" ? turnSchedule(on) : setTriggers(switched(triggers, kind, on))
        }
      />
    </Field>
  );
  const issues = editing === undefined ? [] : [...editing.issues.other];
  if (editing?.error !== undefined) issues.push(editing.error);

  return (
    <div className="grid max-w-2xl min-w-0 gap-8" data-workflow-settings="">
      {readOnly ? (
        <p className="text-body text-muted-foreground">
          {t("workflows.workflowSettings.readOnly")}
        </p>
      ) : null}
      {issues.length === 0 ? null : (
        <Banner tone="danger" layout="inline" data-edit-refused="">
          {issues.join(" ")}
        </Banner>
      )}
      <section className="grid gap-4">
        <Field
          label={t("workflows.workflowSettings.name")}
          required
          error={
            !readOnly && name.trim() === ""
              ? t("workflows.workflowSettings.nameMissing")
              : undefined
          }
        >
          <Input
            value={name}
            readOnly={readOnly}
            onChange={(event) => set({ name: event.target.value })}
            onBlur={editing?.validate}
          />
        </Field>
        <Field label={t("workflows.workflowSettings.description")} optional>
          <Textarea
            value={text(manifest.description)}
            readOnly={readOnly}
            onChange={(event) =>
              set({ description: event.target.value === "" ? undefined : event.target.value })
            }
          />
        </Field>
      </section>

      <section className="grid gap-4" data-workflow-starts="">
        <div className="grid gap-1">
          <h2 className="text-heading-sm">{t("workflows.workflowSettings.starts")}</h2>
          <p className="text-caption text-muted-foreground">
            {t("workflows.workflowSettings.startsHint")}
          </p>
        </div>
        {switchRow("schedule", t("workflows.workflowSettings.onSchedule"))}
        {schedule === undefined ? null : shown !== undefined && read !== undefined ? (
          <ScheduleField
            label={t("workflows.workflowSettings.schedule")}
            value={shown.value}
            readOnly={readOnly}
            error={
              !readOnly && scheduleCron(shown.value) === undefined
                ? t("workflows.workflowSettings.scheduleIncomplete")
                : undefined
            }
            onChange={writeSchedule}
          />
        ) : (
          <div className="grid gap-2" data-schedule-unread="">
            <p className="text-body">{scheduleWords(cron, text(schedule.timeZone), translation)}</p>
            {readOnly ? null : (
              <p className="text-caption text-muted-foreground">
                {t("workflows.workflowSettings.scheduleAgent")}
              </p>
            )}
            {changeWithAgent}
          </div>
        )}
        {switchRow("manual", t("workflows.workflowSettings.byHand"))}
        {switchRow(
          "parent",
          t("workflows.workflowSettings.byParent"),
          t("workflows.workflowSettings.byParentHint")
        )}
        {switchRow(
          "outside",
          t("workflows.workflowSettings.byOutside"),
          t("workflows.workflowSettings.byOutsideHint")
        )}
        <WorkflowCallers
          workspaceId={workspaceId}
          callers={workflow.callers}
          onOpenRoute={onOpenRoute}
        />
        <WorkflowAppCallers
          all
          callers={workflow.appCallers}
          workspaceId={workspaceId}
          onOpenRoute={onOpenRoute}
        />
      </section>

      <StartFields
        manifest={manifest}
        editing={editing}
        changeWithAgent={changeWithAgent}
        set={set}
      />

      <section className="grid gap-3" data-workflow-facts="">
        <KeyValueList layout="stacked">
          <KeyValue label={t("workflows.workflowSettings.result")}>
            {resultWords(manifest.outputs, t)}
          </KeyValue>
          <KeyValue label={t("workflows.workflowSettings.onFailure")}>
            {onFailureWords(manifest.onFailure, t)}
          </KeyValue>
          <KeyValue label={t("workflows.workflowSettings.limits")}>
            {limitLine(manifest.limits, t)}
          </KeyValue>
          <KeyValue label={t("workflows.workflowSettings.runsAs")}>
            {workflow.runsAs ?? t("workflows.workflowSettings.runsAsOwn")}
          </KeyValue>
          <KeyValue label={t("workflows.workflowSettings.owner")}>
            {workflow.ownerWorkspaceId === undefined
              ? t("workflows.workflowSettings.ownerInstance")
              : workflow.ownerWorkspaceId === workspaceId && host?.workspace !== undefined
                ? host.workspace.name
                : t("workflows.workflowSettings.ownerOther")}
          </KeyValue>
          <KeyValue label={t("workflows.workflowSettings.mayStart")}>
            {has("manual") ? (
              <span>
                {t("workflows.workflowSettings.mayStartUse")}{" "}
                <a
                  className="underline underline-offset-2"
                  {...routeLink(
                    { kind: "settings", group: "instance", page: "access" },
                    onOpenRoute
                  )}
                >
                  {`${t("nav.settings")} › ${t("settings.access")}`}
                </a>
              </span>
            ) : (
              t("workflows.workflowSettings.mayStartNobody")
            )}
          </KeyValue>
        </KeyValueList>
      </section>

      {editing === undefined ? null : (
        <WorkflowSettingsBar editing={editing} triggerId={triggerId} incomplete={onCount === 0} />
      )}
    </div>
  );
}

/** The Workflows whose steps call this one, each a link to it in the workspace that owns it. */
function WorkflowCallers({
  workspaceId,
  callers,
  onOpenRoute
}: {
  workspaceId: string;
  callers: readonly WorkflowCallerView[] | undefined;
  onOpenRoute: OpenRoute;
}) {
  const { t } = useTranslation();
  if (callers === undefined || callers.length === 0) return null;
  return (
    <p className="text-caption text-muted-foreground" data-workflow-callers="">
      {t("workflows.workflowSettings.calledBy")}{" "}
      {callers.map((caller, index) => (
        <span key={`${caller.workspaceId ?? ""}/${caller.id}`}>
          {index === 0 ? null : ", "}
          <TextLink
            {...routeLink(
              {
                kind: "workflow",
                // The instance's own opens in the workspace open now, as every link to it does.
                collaborationWorkspaceId: caller.workspaceId ?? workspaceId,
                workflow: caller.id
              },
              onOpenRoute
            )}
          >
            {caller.title}
          </TextLink>
        </span>
      ))}
    </p>
  );
}

function scheduleWords(
  cron: string,
  timeZone: string,
  translation: Pick<TranslationContextValue, "locale" | "t">
): string {
  const words = scheduleInWords(cron, translation) ?? translation.t("workflows.schedule.custom");
  return timeZone === "" ? words : withZone(words, timeZone, translation);
}

function onFailureWords(onFailure: unknown, t: Translate): string {
  const target = /^workflow\.(.+)$/u.exec(text(onFailure))?.[1];
  return target === undefined
    ? t("workflows.workflowSettings.onFailureNotify")
    : t("workflows.workflowSettings.onFailureWorkflow", { name: target });
}

function limitLine(limits: unknown, t: Translate): ReactNode {
  const words = limitWords(limits, t);
  return (
    <span className="grid gap-1">
      <span>
        {words.length === 0 ? t("workflows.workflowSettings.limitsStandard") : words.join(" · ")}
      </span>
      <span className="text-caption text-muted-foreground">
        {t("workflows.workflowSettings.limitsAgent")}
      </span>
    </span>
  );
}

/**
 * What the Workflow asks for when started: the fields of its `inputs`, which are the start
 * form and the test run's form. A field list the form cannot hold stays with the agent.
 */
function StartFields({
  manifest,
  editing,
  changeWithAgent,
  set
}: {
  manifest: WorkflowManifest;
  editing: WorkflowEditing | undefined;
  changeWithAgent: ReactNode;
  set(fields: Record<string, unknown>): void;
}) {
  const { t } = useTranslation();
  const schema = manifest.inputs;
  const [shown, setShown] = useState(() => ({ schema, items: inputFields(schema) }));
  if (!sameValue(shown.schema, schema)) {
    setShown({ schema, items: inputFields(schema) });
  }
  const label = t("workflows.workflowSettings.asks");
  if (shown.items === undefined) {
    return (
      <section className="grid gap-2" data-workflow-inputs="">
        <h2 className="text-heading-sm">{label}</h2>
        <p className="text-body text-muted-foreground">
          {t("workflows.workflowSettings.asksAgentOnly")}
        </p>
        {changeWithAgent}
      </section>
    );
  }
  const field = (id: string) => `inputs.${id}`;
  const state = fieldListState(
    shown.items,
    (id) => editing?.saysMissing(WORKFLOW_FIELDS, field(id)) ?? false,
    t
  );
  return (
    <section
      className="grid gap-2"
      data-workflow-inputs=""
      onBlur={(event) => {
        const left = leftField(event.target);
        if (left !== undefined) editing?.leave(WORKFLOW_FIELDS, field(left));
      }}
    >
      <FieldListEditor
        label={label}
        value={shown.items}
        kinds={inputKinds(t)}
        errors={state.errors}
        readOnly={editing === undefined}
        titled
        keyHint={t("workflows.workflowSettings.asksKeyHint")}
        onChange={(changed: readonly FieldListItem[]) => {
          const next = withKeys(changed, editing?.saved.inputs);
          const written = fieldsSchema(next, schema);
          setShown({ schema: written, items: next });
          const now = fieldListState(next, () => false, t);
          editing?.hold(WORKFLOW_FIELDS, "inputs", now.held);
          editing?.lack(WORKFLOW_FIELDS, "inputs", now.lacking);
          if (!sameValue(written, schema)) set({ inputs: written });
        }}
      />
      <p className="text-caption text-muted-foreground">
        {t("workflows.workflowSettings.asksHint")}
      </p>
    </section>
  );
}

/** Save and Cancel for the Workflow's Settings, once a value is not saved. */
function WorkflowSettingsBar({
  editing,
  triggerId,
  incomplete
}: {
  editing: WorkflowEditing;
  triggerId: string;
  /** No way to start is on: the save waits for one. */
  incomplete: boolean;
}) {
  const { t } = useTranslation();
  const steps = [WORKFLOW_FIELDS, ...(triggerId === "" ? [] : [triggerId])];
  const name = text(editing.manifest.name);
  // A start field without a title is said at the first Save, or once it was left.
  const lacking = editing.lacking.has(WORKFLOW_FIELDS);
  return (
    <SaveBar
      label={t("workflows.settings.save")}
      dirty={steps.some((step) => editing.unsaved.has(step))}
      whenClean="hidden"
      saving={editing.saving}
      disabled={
        incomplete ||
        name.trim() === "" ||
        steps.some((step) => editing.held.has(step)) ||
        (lacking && editing.saysMissing(WORKFLOW_FIELDS, ""))
      }
      discardLabel={t("workflows.settings.cancel")}
      onDiscard={() => {
        for (const step of steps) editing.cancel(step);
      }}
      onSave={() => {
        if (lacking) {
          editing.trySave(WORKFLOW_FIELDS);
          return;
        }
        // A save says what went wrong on the form itself.
        editing.save().catch(() => undefined);
      }}
    />
  );
}
