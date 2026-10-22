import { useState, type ReactNode } from "react";
import {
  Field,
  FieldListEditor,
  Textarea,
  type FieldListItem,
  type FieldListKind
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import {
  earlierFields,
  draftValueOf,
  mappingOf,
  MappingRows,
  rowSchema,
  rowsOf,
  type MappingRow
} from "./mapping-rows";
import {
  fieldListProblems,
  fieldsSchema,
  schemaFields,
  withKeys,
  type AnswerFieldKind
} from "./schema-fields";
import { findStep, sameValue, WORKFLOW_FIELDS } from "./step-edits";
import { ToolsPicker } from "./operation-picker";
import { useCallableOperations } from "./workflow-data";
import {
  fieldListErrors,
  fieldWords,
  isRecord,
  type KindProps,
  type Translate
} from "./step-settings-parts";

// The Settings of an AI step (workflow-canvas 9.4, WF-EDIT-2): its instructions, what it gets
// and what it answers with. What it gets writes the step's `inputSchema` from the kinds of the
// values; what it answers with its `outputSchema`, in the subset every model binding takes.
// The model is not chosen here. A script's Settings take the same two lists.

const text = (value: unknown): string => (typeof value === "string" ? value : "");

function answerKinds(t: Translate): FieldListKind[] {
  const label: Record<AnswerFieldKind, string> = {
    text: t("workflows.settings.answerKindText"),
    number: t("workflows.settings.answerKindNumber"),
    integer: t("workflows.settings.answerKindInteger"),
    boolean: t("workflows.settings.answerKindBoolean"),
    choice: t("workflows.settings.answerKindChoice"),
    list: t("workflows.settings.answerKindList"),
    record: t("workflows.settings.answerKindRecord"),
    records: t("workflows.settings.answerKindRecords")
  };
  return [
    { value: "text", label: label.text },
    { value: "number", label: label.number },
    { value: "integer", label: label.integer },
    { value: "boolean", label: label.boolean },
    { value: "choice", label: label.choice, choices: true },
    { value: "list", label: label.list },
    { value: "record", label: label.record, children: "record" },
    { value: "records", label: label.records, children: "records" }
  ];
}

/**
 * What a step answers with, as a list of fields. The list is the form's while a field has no
 * name yet; the schema it writes is the step's, and a schema someone else wrote replaces it.
 */
function AnswerFields({
  step,
  stepId,
  editing,
  issue,
  under,
  set,
  changeWithAgent
}: KindProps & { changeWithAgent: ReactNode }) {
  const { t } = useTranslation();
  const schema = step.outputSchema;
  const [shown, setShown] = useState(() => ({ schema, items: schemaFields(schema) }));
  if (!sameValue(shown.schema, schema)) {
    setShown({ schema, items: schemaFields(schema) });
  }
  const items = shown.items;
  if (items === undefined) {
    return (
      <div className="grid gap-2" data-step-answers="">
        <p className="text-label">{t("workflows.settings.answers")}</p>
        <p className="text-body text-muted-foreground">{t("workflows.settings.answerAgentOnly")}</p>
        {changeWithAgent}
      </div>
    );
  }
  const problems = fieldListProblems(items);
  const errors = fieldListErrors(problems, t);
  return (
    <div className="grid gap-2" data-step-answers="">
      <FieldListEditor
        label={t("workflows.settings.answers")}
        value={items}
        kinds={answerKinds(t)}
        errors={errors}
        error={issue("outputSchema")}
        titled
        keyHint={t("workflows.settings.answerKeyHint")}
        onChange={(changed: readonly FieldListItem[]) => {
          const next = withKeys(changed, findStep(editing.saved, stepId)?.outputSchema);
          const written = fieldsSchema(next, schema);
          setShown({ schema: written, items: next });
          editing.hold(stepId, "answers", Object.keys(fieldListProblems(next)).length > 0);
          if (!sameValue(written, schema)) set({ outputSchema: written });
        }}
      />
      {under("outputSchema")}
    </div>
  );
}

/** What a step gets: rows of a name and a value, which write its `inputSchema` too. */
function InputRows({
  step,
  stepId,
  editing,
  under,
  set,
  changeWithAgent
}: KindProps & { changeWithAgent: ReactNode }) {
  const { t } = useTranslation();
  const options = earlierFields(editing.manifest, stepId, editing.stepFacts, fieldWords(t));
  const rows = rowsOf(step.input);
  if (rows === undefined) {
    return (
      <div className="grid gap-2" data-step-inputs="">
        <p className="text-label">{t("workflows.settings.gets")}</p>
        <p className="text-body text-muted-foreground">{t("workflows.settings.getsAgentOnly")}</p>
        {changeWithAgent}
      </div>
    );
  }
  const errors = new Map(
    rows.flatMap((row) => {
      const found = editing.issues.fields.get(`${stepId}:input.${row.name}`);
      return found === undefined ? [] : [[row.name, found] as const];
    })
  );
  const before = isRecord(step.inputSchema) ? step.inputSchema : {};
  const kept = isRecord(before.properties) ? before.properties : {};
  return (
    <div className="grid gap-2" data-step-inputs="">
      <MappingRows
        label={t("workflows.settings.gets")}
        rows={rows}
        options={options}
        errors={errors}
        onBlur={editing.validate}
        onChange={(next: MappingRow[]) => {
          // Rows still being named are kept in the form; the save waits until each has one.
          const input = Object.fromEntries(next.map((row) => [row.name, draftValueOf(row.value)]));
          const named = next.filter((row) => row.name.trim() !== "");
          const inputSchema = {
            ...before,
            type: "object",
            properties: Object.fromEntries(
              named.map((row) => [
                row.name,
                rowSchema(row, kept[row.name], editing.manifest, editing.stepFacts)
              ])
            ),
            required: named.map((row) => row.name)
          };
          editing.hold(stepId, "inputs", mappingOf(next) === undefined);
          set({ input, inputSchema });
        }}
      />
      {under("input")}
    </div>
  );
}

/** What a step gets and what it answers with: an AI step's and a script's. */
export function StepInputsAndAnswers(props: KindProps & { changeWithAgent: ReactNode }) {
  return (
    <>
      <InputRows {...props} />
      <AnswerFields {...props} />
    </>
  );
}

/** The Settings of an AI step. */
export function AgentSettings(props: KindProps & { changeWithAgent: ReactNode }) {
  const { t } = useTranslation();
  const { step, issue, under, set, editing, missing, left } = props;
  const instructions = text(step.instructions);
  return (
    <>
      <div className="grid gap-2">
        <Field
          label={t("workflows.settings.instructions")}
          hint={t("workflows.settings.instructionsHint")}
          required
          error={
            missing(
              "instructions",
              instructions.trim() === "",
              t("workflows.settings.instructionsMissing")
            ) ?? issue("instructions")
          }
        >
          <Textarea
            rows={8}
            value={instructions}
            onChange={(event) => set({ instructions: event.target.value })}
            onBlur={left("instructions")}
          />
        </Field>
        {under("instructions")}
      </div>
      <WorkflowTools editing={editing} />
      <StepInputsAndAnswers {...props} />
    </>
  );
}

/** What every AI step of the Workflow may use: the Workflow's `tools`. */
function WorkflowTools({ editing }: Pick<KindProps, "editing">) {
  const choices = useCallableOperations(true);
  const tools = Array.isArray(editing.manifest.tools)
    ? editing.manifest.tools.filter((name) => typeof name === "string")
    : [];
  return (
    <div className="grid gap-2" data-workflow-tools="">
      <ToolsPicker
        value={tools}
        choices={choices}
        onChange={(next) =>
          editing.set(WORKFLOW_FIELDS, { tools: next.length === 0 ? undefined : next })
        }
      />
    </div>
  );
}
