import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import {
  Banner,
  Button,
  CommandLine,
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  Field,
  FieldListEditor,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SettingsList,
  SettingsRow,
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
import { instanceUrl } from "../../admin/control-plane/personal-api-keys-model";
import { useWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";
import { cronSchedule, scheduleCron } from "./schedule-cron";
import { scheduleInWords, scheduleValueWords, withZone } from "./schedule-words";
import { fieldsSchema, schemaFields, withKeys } from "./schema-fields";
import { useStartRun } from "./start-run";
import { WorkflowAppCallers } from "./workflow-app-callers";
import { sameValue, WORKFLOW_FIELDS, type WorkflowManifest } from "./step-edits";
import { fieldListState, leftField } from "./step-settings-parts";
import {
  useRunsAvailable,
  useLiveSteps,
  useWorkflow,
  useWorkflowWebhook,
  type WorkflowReadProblem
} from "./workflow-data";
import {
  useEditWithAgent,
  useWorkflowDraft,
  WorkflowDraftBar,
  type WorkflowDraftBarState,
  type WorkflowEdit
} from "./workflow-draft";
import { useWorkflowEditing, type WorkflowEditing } from "./workflow-editing";
import { WorkflowHead } from "./workflow-head";
import { editOffered, runsReadable, startOffered, workflowRightsOn } from "./workflow-model";
import type { WorkflowCallerView, WorkflowStepView, WorkflowView } from "./workflow-views";
import { WorkflowsFrame, routeLink, type OpenRoute } from "./workflows-frame";
import { useWorkflowsHost } from "./workflows-host";

// The Settings tab of a Workflow (workflow-canvas 9.7, WF-EDIT-5): its name and what it does,
// when it starts, and what it asks for when started, which a holder of `workflow.write` changes
// on the draft with one Save. What the engine and other systems need is folded under "Advanced":
// the start by another Workflow, by outside clients and by a webhook with its secret, and the
// result, the failure notice, the limits, the account, the owner and who may start it as
// read-only lines. Everyone else reads the same, read-only. A schedule the field cannot read is
// left as it is.

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

/** The platform event a Workflow can start on from its Settings (EW-4). */
const SYNC_FINISHED = "knowledge_base.sync_finished";

/** A trigger of the kind as it is turned on: an event trigger names the one event offered. */
function newTrigger(kind: string): Trigger {
  return kind === "platform_event" ? { kind, event: SYNC_FINISHED } : { kind };
}

/** The triggers with one kind on or off: one turned on is added at the end. */
function switched(triggers: readonly Trigger[], kind: string, on: boolean): Trigger[] {
  const has = triggers.some((trigger) => trigger.kind === kind);
  if (on === has) return [...triggers];
  return on ? [...triggers, newTrigger(kind)] : triggers.filter((trigger) => trigger.kind !== kind);
}

/** The ways to start that stand under "Advanced": what another system or Workflow does. */
const FOLDED_STARTS = ["parent", "outside", "webhook"] as const;

/** The fields of the Workflow itself whose lines stand under "Advanced". */
const FOLDED_FIELDS = ["outputs", "onFailure", "limits", "runAs"] as const;

/** What of a manifest stands under "Advanced", to tell whether a draft changes any of it. */
function foldedPart(manifest: WorkflowManifest): unknown {
  const triggers = triggersOf(triggerStep(manifest));
  return [
    FOLDED_STARTS.map((kind) => triggers.find((trigger) => trigger.kind === kind) ?? null),
    FOLDED_FIELDS.map((field) => manifest[field] ?? null)
  ];
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
  const liveSteps = useLiveSteps(workflow, read.workflow);
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
        liveSteps={liveSteps}
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
  liveSteps,
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
  /** The published revision's steps, where the draft shown differs from it. */
  liveSteps?: readonly WorkflowStepView[] | undefined;
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
        liveSteps={liveSteps}
        workflowId={workflowId}
        workflow={workflow}
        tab="settings"
        runsShown={runsAvailable && readsRuns}
        canStart={canStart}
        edit={edit}
        {...(draft === undefined ? {} : { draft })}
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
  const onCount = ["schedule", "manual", "parent", "outside", "webhook", "platform_event"].filter(
    has
  ).length;
  const event = triggers.find((entry) => entry.kind === "platform_event");
  const eventKnowledgeBase = isRecord(event?.filter) ? text(event.filter.knowledgeBase) : "";
  const writeEventFilter = (name: string) =>
    setTriggers(
      triggers.map((entry) => {
        if (entry.kind !== "platform_event") return entry;
        const rest = Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "filter"));
        return name === "" ? rest : { ...rest, filter: { knowledgeBase: name } };
      })
    );
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
  const startSwitch = (kind: string) => (
    <Switch
      checked={has(kind)}
      disabled={readOnly || triggerId === "" || (has(kind) && lastOn(kind))}
      onCheckedChange={(on) =>
        kind === "schedule" ? turnSchedule(on) : setTriggers(switched(triggers, kind, on))
      }
    />
  );
  // One way to start in one row: its switch, then what it is and one line about it.
  const switchRow = (kind: string, label: string, hint: ReactNode) => (
    <SettingsRow label={label} description={hint} leading={startSwitch(kind)} />
  );
  const startsId = useId();
  const startsMoreId = useId();
  // The schedule the fields hold, where they hold it: its button reads as the schedule does.
  const scheduleForm = schedule !== undefined && read !== undefined ? shown?.value : undefined;
  const scheduleIncomplete =
    !readOnly && scheduleForm !== undefined && scheduleCron(scheduleForm) === undefined;
  const issues = editing === undefined ? [] : [...editing.issues.other];
  if (editing?.error !== undefined) issues.push(editing.error);
  const webhook = useWorkflowWebhook(workflow.id, has("webhook"));
  // "Advanced" opens by itself where something in it needs a person: a webhook whose address
  // refuses every request, a draft that changes what stands there, or a Workflow that starts
  // in no way the page shows above it.
  const webhookWaits =
    has("webhook") && webhook?.view !== undefined && webhook.view.secret !== "set";
  const draftChangesFolded =
    editing?.published !== undefined &&
    !sameValue(foldedPart(editing.published), foldedPart(manifest));
  const startsFoldedOnly =
    onCount > 0 && !has("schedule") && !has("manual") && !has("platform_event");
  const needsAdvanced = webhookWaits || draftChangesFolded || startsFoldedOnly;
  const [advanced, setAdvanced] = useState({ open: needsAdvanced, needed: needsAdvanced });
  if (advanced.needed !== needsAdvanced) {
    setAdvanced({ open: advanced.open || needsAdvanced, needed: needsAdvanced });
  }

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

      <section className="grid gap-3" data-workflow-starts="">
        <div className="grid gap-1">
          <h2 id={startsId} className="text-title-sm">
            {t("workflows.workflowSettings.starts")}
          </h2>
          <p className="text-caption text-muted-foreground">
            {t("workflows.workflowSettings.startsHint")}
          </p>
        </div>
        <SettingsList aria-labelledby={startsId} className="border-y">
          <SettingsRow
            label={t("workflows.workflowSettings.onSchedule")}
            description={
              schedule !== undefined && scheduleForm === undefined ? (
                // A schedule the fields cannot hold is said in words and stays with the agent.
                <span data-schedule-unread="">
                  {scheduleWords(cron, text(schedule.timeZone), translation)}
                  {readOnly ? null : ` · ${t("workflows.workflowSettings.scheduleAgent")}`}
                </span>
              ) : (
                t("workflows.workflowSettings.onScheduleHint")
              )
            }
            error={
              scheduleIncomplete ? t("workflows.workflowSettings.scheduleIncomplete") : undefined
            }
            leading={startSwitch("schedule")}
          >
            {schedule === undefined ? null : scheduleForm === undefined ? (
              changeWithAgent
            ) : (
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={t("workflows.workflowSettings.scheduleWhenIs", {
                      when: scheduleValueWords(scheduleForm, translation)
                    })}
                    data-workflow-schedule-when=""
                  >
                    {scheduleValueWords(scheduleForm, translation)}
                    <ChevronDown aria-hidden="true" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  size="md"
                  aria-label={t("workflows.workflowSettings.schedule")}
                >
                  <ScheduleField
                    label={t("workflows.workflowSettings.schedule")}
                    labelHidden
                    value={scheduleForm}
                    readOnly={readOnly}
                    // What is missing is said once, in the row under its label.
                    onChange={writeSchedule}
                  />
                </PopoverContent>
              </Popover>
            )}
          </SettingsRow>
          {switchRow(
            "manual",
            t("workflows.workflowSettings.byHand"),
            t("workflows.workflowSettings.byHandHint")
          )}
          {switchRow(
            "platform_event",
            t("workflows.workflowSettings.onSync"),
            t("workflows.workflowSettings.onSyncHint")
          )}
          {event === undefined ? null : (
            // Part of the row above: its text starts where that row's text starts.
            <SettingsRow
              label={t("workflows.workflowSettings.onSyncKnowledgeBase")}
              description={t("workflows.workflowSettings.onSyncKnowledgeBaseHint")}
              className="ps-14"
            >
              <Input
                className="w-60 max-w-full"
                value={eventKnowledgeBase}
                readOnly={readOnly}
                data-event-knowledge-base=""
                onChange={(change) => writeEventFilter(change.target.value.trim())}
              />
            </SettingsRow>
          )}
        </SettingsList>
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

      <Disclosure
        variant="row"
        className="border-t"
        open={advanced.open}
        onOpenChange={(open) => setAdvanced({ open, needed: needsAdvanced })}
        data-workflow-advanced=""
      >
        {/* A heading of its own level: what it folds stands under it, not under the part above. */}
        <h2>
          <DisclosureTrigger data-workflow-advanced-trigger="">
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <span className="text-title-sm text-foreground">
                {t("workflows.workflowSettings.advanced")}
              </span>
              <span className="text-caption">{t("workflows.workflowSettings.advancedHint")}</span>
            </span>
          </DisclosureTrigger>
        </h2>
        {/* Kept in the page while folded: its switches are part of the one Save. */}
        <DisclosureContent keepMounted>
          <div className="grid gap-8 pt-3 pb-2">
            <section className="grid gap-3" data-workflow-starts-more="">
              <h3 id={startsMoreId} className="text-body font-medium">
                {t("workflows.workflowSettings.startsMore")}
              </h3>
              <SettingsList aria-labelledby={startsMoreId} className="border-y">
                {switchRow(
                  "parent",
                  t("workflows.workflowSettings.byParent"),
                  <>
                    {t("workflows.workflowSettings.byParentHint")}
                    <WorkflowCallers
                      workspaceId={workspaceId}
                      callers={workflow.callers}
                      onOpenRoute={onOpenRoute}
                    />
                  </>
                )}
                {switchRow(
                  "outside",
                  t("workflows.workflowSettings.byOutside"),
                  t("workflows.workflowSettings.byOutsideHint")
                )}
                {switchRow(
                  "webhook",
                  t("workflows.workflowSettings.byWebhook"),
                  t("workflows.workflowSettings.byWebhookHint")
                )}
              </SettingsList>
              {has("webhook") && webhook !== undefined ? (
                <WorkflowWebhook
                  workflow={workflow}
                  webhook={webhook}
                  mayRotate={host !== undefined && workflowRightsOn(host.rights, workflow).publish}
                />
              ) : null}
            </section>

            <section className="grid gap-3" data-workflow-facts="">
              <h3 className="text-body font-medium">
                {t("workflows.workflowSettings.runAndAccess")}
              </h3>
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
          </div>
        </DisclosureContent>
      </Disclosure>

      {editing === undefined ? null : (
        <WorkflowSettingsBar editing={editing} triggerId={triggerId} incomplete={onCount === 0} />
      )}
    </div>
  );
}

/**
 * Where an outside system posts to start the Workflow, how it signs a request, and its secret,
 * which a publisher makes and sees once (EW-4). The address takes requests once a revision with
 * the webhook is published.
 */
function WorkflowWebhook({
  workflow,
  webhook,
  mayRotate
}: {
  workflow: WorkflowView;
  /** The webhook as the form read it, which also tells it whether a person is needed here. */
  webhook: NonNullable<ReturnType<typeof useWorkflowWebhook>>;
  mayRotate: boolean;
}) {
  const { t } = useTranslation();
  const { apiBaseUrl } = useWorkspaceApiClient();
  const [secret, setSecret] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const view = webhook.view;
  const address = `${instanceUrl(apiBaseUrl, window.location.origin)}/api/v1/workflows/${encodeURIComponent(workflow.id)}/webhook`;
  const makeSecret = () => {
    setBusy(true);
    setFailed(false);
    webhook
      .rotate()
      .then((made) => setSecret(made.secret))
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  };
  return (
    <div className="grid gap-3 rounded-md border p-4" data-workflow-webhook="">
      {view?.enabled === false ? (
        <p className="text-caption text-muted-foreground">
          {t("workflows.workflowSettings.webhookUnpublished")}
        </p>
      ) : null}
      <Field label={t("workflows.workflowSettings.webhookAddress")}>
        <CommandLine label={t("workflows.workflowSettings.webhookAddress")} command={address} />
      </Field>
      <p className="text-caption text-muted-foreground">
        {t("workflows.workflowSettings.webhookSigning")}
      </p>
      <KeyValueList layout="stacked">
        <KeyValue label={t("workflows.workflowSettings.webhookSecret")}>
          {view === undefined
            ? "…"
            : view.secret === "set"
              ? t("workflows.workflowSettings.webhookSecretSet", { version: view.version ?? 1 })
              : view.secret === "unreadable"
                ? t("workflows.workflowSettings.webhookSecretUnreadable")
                : t("workflows.workflowSettings.webhookSecretNone")}
        </KeyValue>
        {view === undefined ? null : (
          <KeyValue label={t("workflows.workflowSettings.webhookRate")}>
            {t("workflows.workflowSettings.webhookPerMinute", { count: view.perMinute })}
          </KeyValue>
        )}
      </KeyValueList>
      {secret === undefined ? null : (
        <Banner tone="warning" layout="inline" data-webhook-secret="">
          <span className="grid gap-2">
            <span>{t("workflows.workflowSettings.webhookSecretOnce")}</span>
            <CommandLine label={t("workflows.workflowSettings.webhookSecret")} command={secret} />
          </span>
        </Banner>
      )}
      {failed ? (
        <Banner tone="danger" layout="inline">
          {t("workflows.workflowSettings.webhookSecretFailed")}
        </Banner>
      ) : null}
      {mayRotate ? (
        <Button variant="outline" size="sm" className="w-fit" disabled={busy} onClick={makeSecret}>
          {view?.secret === "set"
            ? t("workflows.workflowSettings.webhookSecretRotate")
            : t("workflows.workflowSettings.webhookSecretMake")}
        </Button>
      ) : null}
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
    <span className="block" data-workflow-callers="">
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
    </span>
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
        <h2 className="text-title-sm">{label}</h2>
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
