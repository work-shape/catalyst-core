import type { ReactNode } from "react";
import { OPERATION_SOURCE_KINDS } from "@work-shape/catalyst-core";
import {
  KeyValue,
  KeyValueList,
  SourcedValueField,
  type SourcedValue,
  type SourcedValueKind
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { ChildPicker } from "./child-picker";
import { earlierFields, draftValueOf, sourcedOf } from "./mapping-rows";
import { OperationPicker, sourceWords } from "./operation-picker";
import { fieldWords, isRecord, type KindProps } from "./step-settings-parts";
import { useCallableOperations, useChildWorkflows } from "./workflow-data";
import type { CallableOperationOption } from "./workflow-views";

// The Settings of an operation step and of a step that starts another Workflow
// (workflow-canvas 9.4, WF-EDIT-3): what it calls or starts, picked from what the reader may
// call or start, and one row per field of what that takes, each a fixed value of the field's
// kind or a field of an earlier result. A field with no value is left out of the step's
// `input`; a required one holds the save back.

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The fields of an object schema, in their order, with whether each is required. */
export function schemaInputFields(
  schema: unknown
): { name: string; schema: Record<string, unknown>; required: boolean }[] | undefined {
  if (!isRecord(schema)) return undefined;
  // An object of no fields, such as `{ type: "object" }`, takes nothing.
  const properties = schema.properties === undefined ? {} : schema.properties;
  if (!isRecord(properties)) return undefined;
  const required = Array.isArray(schema.required) ? schema.required : [];
  return Object.entries(properties).flatMap(([name, field]) =>
    isRecord(field) ? [{ name, schema: field, required: required.includes(name) }] : []
  );
}

/**
 * The required fields of the schema the input gives no value: the save waits for them. A pick
 * whose field is not chosen yet counts as none.
 */
export function missingInputs(schema: unknown, input: unknown): string[] {
  const given = isRecord(input) ? input : {};
  return (schemaInputFields(schema) ?? [])
    .filter(({ name, required }) => {
      if (!required) return false;
      const shown = sourcedOf(given[name]);
      return given[name] === undefined || (shown?.kind === "picked" && shown.option === "");
    })
    .map(({ name }) => name);
}

function kindOfSchema(schema: Record<string, unknown>): {
  kind: SourcedValueKind;
  choices?: { value: string; label: string }[];
} {
  if (Array.isArray(schema.enum) && schema.enum.every((value) => typeof value === "string")) {
    return {
      kind: "select",
      choices: schema.enum.map((value) => ({ value, label: value }))
    };
  }
  switch (schema.type) {
    case "integer":
      return { kind: "integer" };
    case "number":
      return { kind: "number" };
    case "boolean":
      return { kind: "boolean" };
    default:
      return { kind: "text" };
  }
}

/** One row per field of the schema; the rest of the input is kept as it is. */
function SchemaInputs({
  schema,
  step,
  stepId,
  editing,
  issue,
  under,
  set,
  changeWithAgent
}: KindProps & { schema: unknown; changeWithAgent: ReactNode }) {
  const { t } = useTranslation();
  const fields = schemaInputFields(schema);
  const input = isRecord(step.input) ? step.input : {};
  const unshown =
    fields === undefined ||
    fields.some(
      (field) => input[field.name] !== undefined && sourcedOf(input[field.name]) === undefined
    );
  if (unshown) {
    return (
      <div className="grid gap-2" data-step-inputs="">
        <p className="text-label">{t("workflows.settings.gets")}</p>
        <p className="text-body text-muted-foreground">{t("workflows.settings.getsAgentOnly")}</p>
        {changeWithAgent}
      </div>
    );
  }
  const options = earlierFields(editing.manifest, stepId, editing.stepFacts, fieldWords(t));
  const missing = missingInputs(schema, input);
  return (
    <div className="grid gap-4" data-step-inputs="">
      <p className="text-label">{t("workflows.settings.gets")}</p>
      {fields.length === 0 ? (
        <p className="text-body text-muted-foreground">{t("workflows.settings.getsNothing")}</p>
      ) : (
        fields.map((field) => {
          const value: SourcedValue = sourcedOf(input[field.name]) ?? {
            kind: "fixed",
            value: ""
          };
          const { kind, choices } = kindOfSchema(field.schema);
          const title = text(field.schema.title) || field.name;
          return (
            <div className="grid gap-2" key={field.name} data-input-field={field.name}>
              <SourcedValueField
                label={field.required ? title : t("workflows.settings.optionalField", { title })}
                value={value}
                kind={kind}
                {...(choices === undefined ? {} : { choices })}
                options={options}
                {...(text(field.schema.description) === ""
                  ? {}
                  : { hint: text(field.schema.description) })}
                error={
                  issue(`input.${field.name}`) ??
                  (missing.includes(field.name) ? t("workflows.settings.inputMissing") : undefined)
                }
                onBlur={editing.validate}
                onChange={(next) => {
                  const { [field.name]: _before, ...rest } = input;
                  // A field with no value is left out, so a required one holds the save; a pick
                  // waits for its field.
                  const empty =
                    next.kind === "fixed" &&
                    (next.value === "" || next.value === null || next.value === undefined);
                  set({
                    input: empty ? rest : { ...rest, [field.name]: draftValueOf(next) }
                  });
                }}
              />
            </div>
          );
        })
      )}
      {under("input")}
    </div>
  );
}

/** The input of a newly picked operation or Workflow: the values of fields it still takes. */
function keptInput(input: unknown, schema: unknown): Record<string, unknown> {
  const given = isRecord(input) ? input : {};
  const fields = schemaInputFields(schema);
  if (fields === undefined) return {};
  return Object.fromEntries(
    fields.flatMap(({ name }) => (given[name] === undefined ? [] : [[name, given[name]]]))
  );
}

/** The source the step's facts name, as an option's source. */
function sourceOfFact(value: unknown): CallableOperationOption["source"] | undefined {
  if (!isRecord(value)) return undefined;
  const kind = OPERATION_SOURCE_KINDS.find((candidate) => candidate === value.kind);
  if (kind === undefined) return undefined;
  return { kind, ...(typeof value.title === "string" ? { title: value.title } : {}) };
}

/** The Settings of an operation step. */
export function OperationSettings(props: KindProps & { changeWithAgent: ReactNode }) {
  const { t } = useTranslation();
  const { step, stepId, editing, issue, under, set } = props;
  const choices = useCallableOperations(true);
  const name = text(step.operation);
  const listed = choices.rows?.find((operation) => operation.name === name);
  const facts = editing.stepFacts?.[stepId];
  // What the read of the draft says of the operation it holds, where the listing lacks it.
  const factTitle = text(facts?.title);
  const source = sourceOfFact(facts?.source);
  const shown =
    name === ""
      ? undefined
      : factTitle === ""
        ? name
        : source === undefined
          ? factTitle
          : `${factTitle} · ${sourceWords(source, t)}`;
  const schema = listed?.inputSchema ?? (name === "" ? undefined : facts?.inputSchema);
  const pick = (operation: CallableOperationOption) => {
    if (operation.name === name) return;
    set({ operation: operation.name, input: keptInput(step.input, operation.inputSchema) });
  };
  return (
    <>
      <div className="grid gap-2" data-step-operation="">
        <OperationPicker
          value={name === "" ? undefined : name}
          shown={shown}
          choices={choices}
          error={
            issue("operation") ??
            (name === "" ? t("workflows.settings.operationMissing") : undefined)
          }
          onPick={pick}
          onBlur={editing.validate}
        />
        {listed?.description === undefined ? null : (
          <p className="text-caption text-muted-foreground">{listed.description}</p>
        )}
        {choices.rows !== undefined && name !== "" && listed === undefined ? (
          <p className="text-caption text-muted-foreground">
            {t("workflows.settings.operationNotListed")}
          </p>
        ) : null}
        {under("operation")}
      </div>
      {/* The rows wait for the listing where the read of the draft says nothing of them. */}
      {name === "" ||
      (schema === undefined && choices.rows === undefined && !choices.failed) ? null : (
        <SchemaInputs {...props} schema={schema} />
      )}
    </>
  );
}

/** The Settings of a step that starts another Workflow and waits for its result. */
export function ChildWorkflowSettings(props: KindProps & { changeWithAgent: ReactNode }) {
  const { t } = useTranslation();
  const { step, stepId, editing, issue, under, set, changeWithAgent } = props;
  const choices = useChildWorkflows(editing.workspaceId, true);
  const id = text(step.workflow);
  const listed = choices.rows?.find((child) => child.id === id);
  const facts = editing.stepFacts?.[stepId];
  const shown = id === "" ? undefined : text(facts?.title) || id;
  const key = Array.isArray(step.key) ? step.key : undefined;
  return (
    <>
      <div className="grid gap-2" data-step-child="">
        <ChildPicker
          value={id === "" ? undefined : id}
          shown={shown}
          current={editing.workflowId}
          choices={choices}
          error={
            issue("workflow") ?? (id === "" ? t("workflows.settings.childMissing") : undefined)
          }
          onPick={(child) => {
            if (child.id === id) return;
            set({ workflow: child.id, input: keptInput(step.input, child.inputs) });
          }}
          onBlur={editing.validate}
        />
        {under("workflow")}
      </div>
      {id === "" || (choices.rows === undefined && !choices.failed) ? null : (
        <SchemaInputs
          {...props}
          schema={listed?.inputs ?? (listed === undefined ? undefined : { type: "object" })}
        />
      )}
      {key === undefined ? null : (
        <div className="grid gap-2">
          <KeyValueList>
            <KeyValue label={t("workflows.settings.childKey")}>
              {t("workflows.settings.childKeyAgent")}
            </KeyValue>
          </KeyValueList>
          {changeWithAgent}
        </div>
      )}
    </>
  );
}
