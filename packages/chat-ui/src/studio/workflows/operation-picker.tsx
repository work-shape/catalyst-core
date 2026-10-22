import { OPERATION_SOURCE_KINDS } from "@work-shape/catalyst-core";
import { Field, Picker, PickerButton, type PickerOptionGroup } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import type { Translate } from "./step-settings-parts";
import type { StepChoices } from "./workflow-data";
import type { CallableOperationOption } from "./workflow-views";

// The operations a step may call, by source (workflow-canvas 9.4, WF-EDIT-3): each with its
// title, where it belongs and whether it reads or changes. The instance lists only what the
// reader may call from a step; the listing advises, and the run's own call is checked again.

type SourceKind = CallableOperationOption["source"]["kind"];

function headingOf(kind: SourceKind, t: Translate): string {
  switch (kind) {
    case "connection":
      return t("workflows.settings.sourcesConnection");
    case "data_store":
      return t("workflows.settings.sourcesDataStore");
    case "knowledge_base":
      return t("workflows.settings.sourcesKnowledgeBase");
    case "workflow":
      return t("workflows.settings.sourcesWorkflow");
    case "other":
      return t("workflows.settings.sourcesOther");
  }
}

/** Where an operation belongs, in words: its source's title, or its kind alone. */
export function sourceWords(source: CallableOperationOption["source"], t: Translate): string {
  if (source.title !== undefined) return source.title;
  switch (source.kind) {
    case "connection":
      return t("workflows.settings.sourceConnection");
    case "data_store":
      return t("workflows.settings.sourceDataStore");
    case "knowledge_base":
      return t("workflows.settings.sourceKnowledgeBase");
    case "workflow":
      return t("workflows.settings.sourceWorkflow");
    case "other":
      return t("workflows.settings.sourceOther");
  }
}

/** `workflow.<id>.start`: the id of the Workflow it starts. */
const STARTS = /^workflow\.([^.]+)\.start$/u;

/**
 * An operation in words: its title and where it belongs. An operation that starts a Workflow
 * has no title of its own, so it is named by the Workflow it starts.
 */
export function operationWords(
  operation: CallableOperationOption,
  t: Translate
): { label: string; source: string | undefined } {
  const started =
    operation.source.kind === "workflow" ? STARTS.exec(operation.name)?.[1] : undefined;
  return started === undefined
    ? { label: operation.title, source: sourceWords(operation.source, t) }
    : {
        label: t("workflows.settings.startWorkflow", { name: operation.source.title ?? started }),
        source: undefined
      };
}

const pickedWords = ({ label, source }: { label: string; source: string | undefined }) =>
  source === undefined ? label : `${label} · ${source}`;

/** The operations as the picker's groups, one per kind of source. */
function operationGroups(
  operations: readonly CallableOperationOption[],
  t: Translate
): PickerOptionGroup[] {
  return OPERATION_SOURCE_KINDS.map((kind) => ({
    heading: headingOf(kind, t),
    options: operations
      .filter((operation) => operation.source.kind === kind)
      .map((operation) => {
        const words = operationWords(operation, t);
        const effect = t(
          operation.effect === "reading" ? "workflows.step.reading" : "workflows.step.changing"
        );
        return {
          value: operation.name,
          label: words.label,
          description: words.source === undefined ? effect : `${words.source} · ${effect}`,
          keywords: operation.name,
          ...(operation.available
            ? {}
            : { disabled: true, disabledReason: t("workflows.settings.operationUnavailable") })
        };
      })
  })).filter((group) => group.options.length > 0);
}

/** The note under a list read in part, or that failed. */
export function noteOf(choices: StepChoices<unknown>, t: Translate): string | undefined {
  if (choices.failed) return t("workflows.settings.operationsFailed");
  return choices.more ? t("workflows.settings.choicesMore") : undefined;
}

/** Picks the one operation a step calls. */
export function OperationPicker({
  value,
  shown,
  choices,
  error,
  onPick,
  onBlur
}: {
  value: string | undefined;
  /** The picked operation's words, where the listing does not have it. */
  shown: string | undefined;
  choices: StepChoices<CallableOperationOption>;
  error?: string;
  onPick(operation: CallableOperationOption): void;
  onBlur?(): void;
}) {
  const { t } = useTranslation();
  const operations = choices.rows ?? [];
  const picked = operations.find((operation) => operation.name === value);
  const label = t("workflows.settings.operation");
  const note = noteOf(choices, t);
  return (
    <Field label={label} required error={error}>
      <Picker
        label={label}
        options={operationGroups(operations, t)}
        value={value}
        search
        wrapDescriptions
        {...(note === undefined ? {} : { note })}
        onValueChange={(name) => {
          const operation = operations.find((candidate) => candidate.name === name);
          if (operation !== undefined) onPick(operation);
        }}
      >
        <PickerButton
          label={label}
          value={picked === undefined ? shown : pickedWords(operationWords(picked, t))}
          placeholder={t("workflows.settings.chooseOperation")}
          onBlur={onBlur}
        />
      </Picker>
    </Field>
  );
}

/** Picks the operations every AI step of a Workflow may use, its `tools`. */
export function ToolsPicker({
  value,
  choices,
  error,
  onChange
}: {
  value: readonly string[];
  choices: StepChoices<CallableOperationOption>;
  error?: string;
  onChange(tools: string[]): void;
}) {
  const { t } = useTranslation();
  const operations = choices.rows ?? [];
  const label = t("workflows.settings.tools");
  const note = noteOf(choices, t);
  // A tool the reader may not call now stays chosen, named by its own name.
  const unlisted = value
    .filter((name) => !operations.some((operation) => operation.name === name))
    .map((name) => ({ value: name, label: name }));
  const groups = [
    ...operationGroups(operations, t),
    ...(unlisted.length === 0
      ? []
      : [{ heading: t("workflows.settings.toolsUnlisted"), options: unlisted }])
  ];
  const chosen = groups
    .flatMap((group) => group.options)
    .filter((option) => value.includes(option.value))
    .map((option) => option.label)
    .join(", ");
  return (
    <Field label={label} hint={t("workflows.settings.toolsHint")} error={error}>
      <Picker
        multiple
        label={label}
        options={groups}
        value={value}
        search
        wrapDescriptions
        {...(note === undefined ? {} : { note })}
        onValueChange={onChange}
      >
        <PickerButton
          label={label}
          value={chosen === "" ? undefined : chosen}
          placeholder={t("workflows.settings.toolsNone")}
        />
      </Picker>
    </Field>
  );
}
