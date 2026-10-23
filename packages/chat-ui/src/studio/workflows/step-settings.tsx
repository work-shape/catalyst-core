import type { ReactNode } from "react";
import {
  Banner,
  Button,
  Field,
  Input,
  KeyValue,
  KeyValueList,
  Picker,
  PickerButton,
  ProposedValue,
  SaveBar,
  SegmentedControl,
  SegmentedControlItem,
  Select,
  SourcedValueField,
  Textarea,
  type SourcedValue
} from "@work-shape/catalyst-ui";
import { WORKFLOW_LOOP_MAX_CONCURRENCY } from "@work-shape/catalyst-core";
import { useTranslation } from "../../shared/i18n";
import {
  earlierFields,
  fieldKey,
  draftValueOf,
  inputValueOf,
  kindOf,
  mappingOf,
  MappingRows,
  rowSchema,
  rowsOf,
  sourcedOf
} from "./mapping-rows";
import { findStep, sameValue, WORKFLOW_FIELDS } from "./step-edits";
import type { WorkflowEdit } from "./workflow-draft";
import type { WorkflowEditing } from "./workflow-editing";
import { fieldWords, isRecord, type KindProps } from "./step-settings-parts";
import { AgentSettings } from "./step-settings-agent";
import { CodeSettings } from "./step-settings-code";
import { ChildWorkflowSettings, missingInputs, OperationSettings } from "./step-settings-operation";
import { MailSettings } from "./step-settings-mail";
import { MAIL_OPERATION } from "./mail-step";
import { useCallableOperations, useChildWorkflows } from "./workflow-data";
import { routeLink } from "./workflows-frame";
import { useRecipientNames, useWorkflowsHost } from "./workflows-host";

// The Settings tab of a step (workflow-canvas 9.4): the step's form for a holder of
// `workflow.write`. Every step has its name and what it does; a loop, a notice and the result
// have their fields here. What the form does not edit stays read-only with "Change with the
// agent". The form writes ids and paths itself and never shows them.

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** A value of the manifest in words, for the published value and the agent's under a field. */
function valueWords(value: unknown, names: (step: string, path: string) => string): string {
  if (value === undefined || value === null) return "–";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return value.map((item) => valueWords(item, names)).join(", ");
  if (isRecord(value)) {
    if ("value" in value) return valueWords(value.value, names);
    if (isRecord(value.ref)) return names(text(value.ref.step), text(value.ref.path));
    if (Array.isArray(value.text)) {
      return value.text
        .map((part) => (typeof part === "string" ? part : valueWords(part, names)))
        .join("");
    }
    if (isRecord(value.ref) || "step" in value) return names(text(value.step), text(value.path));
  }
  return JSON.stringify(value);
}

/** The Settings tab of one step, and the bar that saves it. */
export function StepSettings({
  stepId,
  editing,
  edit
}: {
  stepId: string;
  editing: WorkflowEditing;
  /** "Change with the agent", where a conversation can be started. */
  edit: WorkflowEdit | undefined;
}) {
  const { t } = useTranslation();
  const step = findStep(editing.manifest, stepId);
  if (step === undefined) {
    return editing.dropped.includes(stepId) ? (
      <Banner tone="warning" layout="inline" data-edit-dropped="">
        {t("workflows.settings.dropped")}
      </Banner>
    ) : (
      <p className="text-body text-muted-foreground" data-step-settings-removed="">
        {t("workflows.settings.removed")}
      </p>
    );
  }
  const name = text(step.name);
  const fieldName = (stepOf: string, path: string) => {
    const from = findStep(editing.manifest, stepOf);
    const stepName = text(from?.name) || stepOf;
    const field = path.split(".").at(-1) ?? "";
    return field === "" ? stepName : `${stepName} › ${field}`;
  };
  const words = (value: unknown) => valueWords(value, fieldName);
  const published =
    editing.published === undefined ? undefined : findStep(editing.published, stepId);
  const changedFields = editing.changes.fields.get(stepId) ?? [];
  const issue = (field: string) => editing.issues.fields.get(`${stepId}:${field}`);
  const set = (fields: Record<string, unknown>) => editing.set(stepId, fields);
  const missing = (field: string, empty: boolean, sentence: string) =>
    empty && editing.saysMissing(stepId, field) ? sentence : undefined;
  const left = (field: string) => () => {
    editing.leave(stepId, field);
    editing.validate();
  };

  /** Under a field: the agent's value where it changed it meanwhile, and the published one. */
  const under = (field: string): ReactNode => {
    const conflict = editing.conflicts.find((c) => c.step === stepId && c.field === field);
    return (
      <>
        {conflict === undefined ? null : (
          <ProposedValue label={t("workflows.settings.theirs")} data-conflict={field}>
            <div className="grid gap-2">
              <span>{words(conflict.theirs)}</span>
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() => editing.takeTheirs(stepId, field)}
              >
                {t("workflows.settings.takeIt")}
              </Button>
            </div>
          </ProposedValue>
        )}
        {published === undefined || !changedFields.includes(field) ? null : (
          <ProposedValue label={t("workflows.settings.published")} data-published={field}>
            {words(published[field])}
          </ProposedValue>
        )}
      </>
    );
  };

  const changeWithAgent =
    edit === undefined ? null : (
      <Button
        variant="outline"
        size="sm"
        className="w-fit"
        disabled={edit.busy}
        onClick={() => edit.startWith(t("workflows.settings.agentPrompt", { name }))}
      >
        {t("workflows.settings.changeWithAgent")}
      </Button>
    );
  const nameMissing = name.trim() === "";

  return (
    <div className="grid min-w-0 gap-5" data-step-settings={stepId}>
      {editing.dropped.length === 0 ? null : (
        <Banner tone="warning" layout="inline" data-edit-dropped="">
          {t("workflows.settings.dropped")}
        </Banner>
      )}
      {editing.issues.other.length === 0 && editing.error === undefined ? null : (
        <Banner tone="danger" layout="inline" data-edit-refused="">
          {[...editing.issues.other, ...(editing.error === undefined ? [] : [editing.error])].join(
            " "
          )}
        </Banner>
      )}
      <div className="grid gap-2">
        <Field
          label={t("workflows.settings.name")}
          required
          error={missing("name", nameMissing, t("workflows.settings.nameMissing")) ?? issue("name")}
        >
          <Input
            value={name}
            onChange={(event) => set({ name: event.target.value })}
            onBlur={left("name")}
          />
        </Field>
        {under("name")}
      </div>
      <div className="grid gap-2">
        <Field label={t("workflows.settings.description")} optional error={issue("description")}>
          <Textarea
            rows={2}
            value={text(step.description)}
            onChange={(event) =>
              set({ description: event.target.value === "" ? undefined : event.target.value })
            }
            onBlur={editing.validate}
          />
        </Field>
        {under("description")}
      </div>
      {step.type === "loop" ? (
        <LoopSettings
          step={step}
          stepId={stepId}
          editing={editing}
          issue={issue}
          under={under}
          set={set}
          missing={missing}
          left={left}
        />
      ) : step.type === "notify" ? (
        <NotifySettings
          step={step}
          stepId={stepId}
          editing={editing}
          issue={issue}
          under={under}
          set={set}
          missing={missing}
          left={left}
          changeWithAgent={changeWithAgent}
        />
      ) : step.type === "agent" ? (
        <AgentSettings
          step={step}
          stepId={stepId}
          editing={editing}
          issue={issue}
          under={under}
          set={set}
          missing={missing}
          left={left}
          changeWithAgent={changeWithAgent}
        />
      ) : step.type === "code" ? (
        <CodeSettings
          step={step}
          stepId={stepId}
          editing={editing}
          issue={issue}
          under={under}
          set={set}
          missing={missing}
          left={left}
          changeWithAgent={changeWithAgent}
        />
      ) : step.type === "operation" && step.operation === MAIL_OPERATION ? (
        <MailSettings
          step={step}
          stepId={stepId}
          editing={editing}
          issue={issue}
          under={under}
          set={set}
          missing={missing}
          left={left}
          changeWithAgent={changeWithAgent}
        />
      ) : step.type === "operation" ? (
        <OperationSettings
          step={step}
          stepId={stepId}
          editing={editing}
          issue={issue}
          under={under}
          set={set}
          missing={missing}
          left={left}
          changeWithAgent={changeWithAgent}
        />
      ) : step.type === "workflow" ? (
        <ChildWorkflowSettings
          step={step}
          stepId={stepId}
          editing={editing}
          issue={issue}
          under={under}
          set={set}
          missing={missing}
          left={left}
          changeWithAgent={changeWithAgent}
        />
      ) : step.type === "output" ? (
        <ResultSettings step={step} stepId={stepId} editing={editing} under={under} />
      ) : step.type === "trigger" ? (
        <TriggerSettings editing={editing} />
      ) : (
        <div className="grid gap-2" data-step-settings-agent="">
          <p className="text-body text-muted-foreground">{t("workflows.settings.restWithAgent")}</p>
          {changeWithAgent}
        </div>
      )}
    </div>
  );
}

/** The trigger has no Settings of its own: when it starts is the Workflow's Settings (9.7). */
function TriggerSettings({ editing }: { editing: WorkflowEditing }) {
  const { t } = useTranslation();
  const host = useWorkflowsHost();
  return (
    <div className="grid gap-2" data-step-settings-trigger="">
      <p className="text-body text-muted-foreground">{t("workflows.settings.triggerElsewhere")}</p>
      {host === undefined ? null : (
        <Button variant="outline" size="sm" className="w-fit" asChild>
          <a
            {...routeLink(
              {
                kind: "workflow-settings",
                collaborationWorkspaceId: editing.workspaceId,
                workflow: editing.workflowId
              },
              host.showRoute
            )}
          >
            {t("workflows.settings.triggerOpenSettings")}
          </a>
        </Button>
      )}
    </div>
  );
}

/** The bar under a step's Settings: Save and Cancel, once a value is not saved. */
export function StepSettingsBar({ stepId, editing }: { stepId: string; editing: WorkflowEditing }) {
  const { t } = useTranslation();
  const step = findStep(editing.manifest, stepId);
  const operations = useCallableOperations(step?.type === "operation");
  const children = useChildWorkflows(editing.workspaceId, step?.type === "workflow");
  // A value the form has not finished says so where it is: it holds the save at once.
  const held = editing.held.has(stepId);
  // A value missing is said at the first Save, or once its field was left.
  const incomplete =
    editing.lacking.has(stepId) ||
    (step?.type === "operation" && step.operation === MAIL_OPERATION && mailLacks(step.input)) ||
    (step?.type === "operation" &&
      (text(step.operation) === "" ||
        missingInputs(
          operations.rows?.find((operation) => operation.name === step.operation)?.inputSchema ??
            editing.stepFacts?.[stepId]?.inputSchema,
          step.input
        ).length > 0 ||
        pendingPick(step.input))) ||
    (step?.type === "workflow" &&
      (text(step.workflow) === "" ||
        missingInputs(
          children.rows?.find((child) => child.id === step.workflow)?.inputs,
          step.input
        ).length > 0 ||
        pendingPick(step.input))) ||
    text(step?.name).trim() === "" ||
    (step?.type === "agent" && text(step.instructions).trim() === "") ||
    (step?.type === "notify" &&
      [step.title, step.text].some((value) => {
        const shown = sourcedOf(value);
        return shown?.kind === "picked" && shown.option === "";
      })) ||
    (step?.type === "loop" && !isRecord(step.items)) ||
    (step?.type === "output" && mappingOf(rowsOf(step.input) ?? []) === undefined);
  return (
    <SaveBar
      className="px-4 py-3"
      label={t("workflows.settings.save")}
      dirty={editing.unsaved.size > 0}
      whenClean="hidden"
      saving={editing.saving}
      // An unfinished step's first Save says what it lacks; after that Save waits for it.
      disabled={held || (incomplete && editing.saysMissing(stepId, ""))}
      discardLabel={t("workflows.settings.cancel")}
      onDiscard={() => editing.cancel(stepId)}
      onSave={() => {
        if (incomplete) {
          editing.trySave(stepId);
          return;
        }
        // A save says what went wrong on the form itself.
        editing.save().catch(() => undefined);
      }}
    />
  );
}

/** A Send email step without a recipient, a subject or a text: its Save waits for them. */
function mailLacks(input: unknown): boolean {
  const given = isRecord(input) ? input : {};
  return ["to", "subject", "body"].some((field) => given[field] === undefined);
}

/** A value of the input to be picked from a step whose field is not chosen yet. */
function pendingPick(input: unknown): boolean {
  return Object.values(isRecord(input) ? input : {}).some((value) => {
    const shown = sourcedOf(value);
    return shown?.kind === "picked" && shown.option === "";
  });
}

function LoopSettings({ step, stepId, editing, issue, under, set }: KindProps) {
  const { t } = useTranslation();
  const words = fieldWords(t);
  const lists = earlierFields(editing.manifest, stepId, editing.stepFacts, words, { lists: true });
  const items = isRecord(step.items) ? step.items : undefined;
  const picked: SourcedValue = {
    kind: "picked",
    option: items === undefined ? "" : fieldKey({ step: text(items.step), path: text(items.path) })
  };
  const concurrency = typeof step.concurrency === "number" ? step.concurrency : 1;
  const readOnly = (["collect", "batch", "continueAsNew"] as const).filter(
    (field) => step[field] !== undefined
  );
  return (
    <>
      <div className="grid gap-2">
        <SourcedValueField
          label={t("workflows.settings.loopList")}
          value={picked}
          pickedOnly
          options={lists}
          error={issue("items")}
          onBlur={editing.validate}
          onChange={(value) => {
            const ref = inputValueOf(value)?.ref;
            if (isRecord(ref)) set({ items: ref });
          }}
        />
        {under("items")}
      </div>
      <div className="grid gap-2">
        <Field label={t("workflows.settings.loopItemName")} optional error={issue("itemName")}>
          <Input
            value={text(step.itemName)}
            onChange={(event) =>
              set({ itemName: event.target.value === "" ? undefined : event.target.value })
            }
            onBlur={editing.validate}
          />
        </Field>
        {under("itemName")}
      </div>
      <div className="grid gap-2">
        <Field
          label={t("workflows.settings.loopItemLabel")}
          hint={t("workflows.settings.loopItemLabelHint")}
          optional
          error={issue("itemLabel")}
        >
          <Input
            value={text(step.itemLabel)}
            onChange={(event) =>
              set({ itemLabel: event.target.value === "" ? undefined : event.target.value })
            }
            onBlur={editing.validate}
          />
        </Field>
        {under("itemLabel")}
      </div>
      <div className="grid gap-2">
        <Field
          label={t("workflows.panel.atOnce")}
          hint={t("workflows.settings.loopAtOnceHint", {
            most: String(WORKFLOW_LOOP_MAX_CONCURRENCY)
          })}
          error={issue("concurrency")}
        >
          <Input
            type="number"
            min={1}
            max={WORKFLOW_LOOP_MAX_CONCURRENCY}
            step={1}
            value={concurrency}
            onChange={(event) => {
              const next = event.target.valueAsNumber;
              if (Number.isInteger(next)) set({ concurrency: next });
            }}
            onBlur={editing.validate}
          />
        </Field>
        {under("concurrency")}
      </div>
      <div className="grid gap-2">
        <Field label={t("workflows.settings.loopOnFailure")} error={issue("onItemFailure")}>
          <Select
            value={step.onItemFailure === "continue" ? "continue" : "stop"}
            onChange={(event) => set({ onItemFailure: event.target.value })}
            onBlur={editing.validate}
          >
            <option value="continue">{t("workflows.settings.loopOthersGoOn")}</option>
            <option value="stop">{t("workflows.settings.loopStops")}</option>
          </Select>
        </Field>
        {under("onItemFailure")}
      </div>
      {readOnly.length === 0 ? null : (
        <p className="text-caption text-muted-foreground">{t("workflows.settings.loopMore")}</p>
      )}
    </>
  );
}

function NotifySettings({
  step,
  stepId,
  editing,
  issue,
  under,
  set,
  changeWithAgent
}: KindProps & { changeWithAgent: ReactNode }) {
  const { t } = useTranslation();
  const names = useRecipientNames();
  const words = fieldWords(t);
  const options = earlierFields(editing.manifest, stepId, editing.stepFacts, words);
  const to = isRecord(step.to) ? step.to : {};
  const users = Array.isArray(to.users) ? to.users.filter((id) => typeof id === "string") : [];
  const workspaces = Array.isArray(to.workspaces)
    ? to.workspaces.filter((id) => typeof id === "string")
    : [];
  const chosen = [...users.map((id) => `user:${id}`), ...workspaces.map((id) => `workspace:${id}`)];
  // Whom the reader may not read stays chosen, counted and never shown by id.
  const unnamed = (prefix: string, ids: readonly string[], known: ReadonlyMap<string, string>) =>
    ids
      .filter((id) => !known.has(id))
      .map((id) => ({ value: `${prefix}:${id}`, label: t("workflows.settings.unnamed") }));
  const recipientGroups = [
    {
      heading: t("workflows.settings.people"),
      options: [
        ...[...names.people].map(([id, label]) => ({ value: `user:${id}`, label })),
        ...unnamed("user", users, names.people)
      ]
    },
    {
      heading: t("workflows.settings.workspaces"),
      options: [
        ...[...names.workspaces].map(([id, label]) => ({ value: `workspace:${id}`, label })),
        ...unnamed("workspace", workspaces, names.workspaces)
      ]
    }
  ].filter((group) => group.options.length > 0);
  const chosenLabel = recipientGroups
    .flatMap((group) => group.options)
    .filter((option) => chosen.includes(option.value))
    .map((option) => option.label)
    .join(", ");
  const channels = Array.isArray(step.channels) ? step.channels : ["inbox"];
  const link = isRecord(step.link) ? step.link : undefined;

  const textField = (field: "title" | "text") => {
    const value = sourcedOf(step[field]);
    const label = t(
      field === "title" ? "workflows.settings.noticeTitle" : "workflows.settings.noticeText"
    );
    if (value === undefined) {
      // A text joined from parts is the agent's to change in this build.
      return (
        <div className="grid gap-2">
          <KeyValueList>
            <KeyValue label={label}>{valueWords(step[field], (s, p) => `${s} › ${p}`)}</KeyValue>
          </KeyValueList>
          {changeWithAgent}
        </div>
      );
    }
    return (
      <div className="grid gap-2">
        <SourcedValueField
          label={label}
          value={value}
          kind={kindOf(value, field === "text")}
          options={options}
          error={issue(field)}
          onBlur={editing.validate}
          onChange={(next) => set({ [field]: draftValueOf(next) })}
        />
        {under(field)}
      </div>
    );
  };

  return (
    <>
      <div className="grid gap-2">
        <Field label={t("workflows.panel.recipients")} error={issue("to")}>
          <Picker
            multiple
            label={t("workflows.panel.recipients")}
            options={recipientGroups}
            value={chosen}
            search
            onValueChange={(values) =>
              set({
                to: {
                  ...(values.some((value) => value.startsWith("user:"))
                    ? {
                        users: values
                          .filter((value) => value.startsWith("user:"))
                          .map((value) => value.slice("user:".length))
                      }
                    : {}),
                  ...(values.some((value) => value.startsWith("workspace:"))
                    ? {
                        workspaces: values
                          .filter((value) => value.startsWith("workspace:"))
                          .map((value) => value.slice("workspace:".length))
                      }
                    : {})
                }
              })
            }
          >
            <PickerButton
              label={t("workflows.panel.recipients")}
              value={chosenLabel === "" ? undefined : chosenLabel}
              placeholder={t("workflows.settings.chooseRecipients")}
              onBlur={editing.validate}
            />
          </Picker>
        </Field>
        {under("to")}
      </div>
      <div className="grid gap-2">
        <Field label={t("workflows.settings.noticeBy")} error={issue("channels")}>
          <SegmentedControl
            label={t("workflows.settings.noticeBy")}
            value={channels.includes("mail") ? "mail" : "inbox"}
            onValueChange={(value) =>
              set({ channels: value === "mail" ? ["inbox", "mail"] : ["inbox"] })
            }
          >
            <SegmentedControlItem value="inbox">
              {t("workflows.panel.viaInbox")}
            </SegmentedControlItem>
            <SegmentedControlItem value="mail">{t("workflows.panel.viaMail")}</SegmentedControlItem>
          </SegmentedControl>
        </Field>
        {under("channels")}
      </div>
      {textField("title")}
      {textField("text")}
      <div className="grid gap-2">
        {link?.kind === "app" ? (
          <>
            <KeyValueList>
              <KeyValue label={t("workflows.settings.noticeLink")}>
                {t("workflows.settings.noticeLinkApp")}
              </KeyValue>
            </KeyValueList>
            {changeWithAgent}
          </>
        ) : (
          <Field label={t("workflows.settings.noticeLink")} error={issue("link")}>
            <Select
              value={link?.kind === "run" ? "run" : "none"}
              onChange={(event) =>
                set({ link: event.target.value === "run" ? { kind: "run" } : undefined })
              }
              onBlur={editing.validate}
            >
              <option value="run">{t("workflows.settings.noticeLinkRun")}</option>
              <option value="none">{t("workflows.settings.noticeLinkNone")}</option>
            </Select>
          </Field>
        )}
        {under("link")}
      </div>
    </>
  );
}

function ResultSettings({
  step,
  stepId,
  editing,
  under
}: Pick<KindProps, "step" | "stepId" | "editing" | "under">) {
  const { t } = useTranslation();
  const words = fieldWords(t);
  const options = earlierFields(editing.manifest, stepId, editing.stepFacts, words);
  const rows = rowsOf(step.input);
  if (rows === undefined) {
    return (
      <p className="text-body text-muted-foreground">{t("workflows.settings.restWithAgent")}</p>
    );
  }
  const errors = new Map(
    rows.flatMap((row) => {
      const found = editing.issues.fields.get(`${stepId}:input.${row.name}`);
      return found === undefined ? [] : [[row.name, found] as const];
    })
  );
  const outputs = isRecord(editing.manifest.outputs) ? editing.manifest.outputs : {};
  const properties = isRecord(outputs.properties) ? outputs.properties : {};
  return (
    <div className="grid gap-2">
      <MappingRows
        label={t("workflows.settings.resultValues")}
        rows={rows}
        options={options}
        errors={errors}
        onBlur={editing.validate}
        onChange={(next) => {
          // Rows still being named are kept in the form; the mapping is written once complete.
          const input = Object.fromEntries(next.map((row) => [row.name, draftValueOf(row.value)]));
          editing.set(stepId, { input });
          const named = next.filter((row) => row.name.trim() !== "");
          const nextProperties = Object.fromEntries(
            named.map((row) => [
              row.name,
              rowSchema(row, properties[row.name], editing.manifest, editing.stepFacts)
            ])
          );
          const nextOutputs = {
            ...outputs,
            type: "object",
            properties: nextProperties,
            required: named.map((row) => row.name)
          };
          if (!sameValue(nextOutputs, outputs)) {
            editing.set(WORKFLOW_FIELDS, { outputs: nextOutputs });
          }
        }}
      />
      {under("input")}
    </div>
  );
}
