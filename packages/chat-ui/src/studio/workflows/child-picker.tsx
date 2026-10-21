import { Field, Picker, PickerButton } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import type { StepChoices } from "./workflow-data";
import type { ChildWorkflowOption } from "./workflow-views";

// The Workflow a step starts and waits for (workflow-canvas 9.4, WF-EDIT-3): the published
// Workflows that list the trigger `parent`, never the one being edited. One the reader may
// only read is shown and cannot be picked: the parent's start of it needs `workflow.use`.

export function ChildPicker({
  value,
  shown,
  current,
  choices,
  error,
  onPick,
  onBlur
}: {
  value: string | undefined;
  /** The picked Workflow's name, where the listing does not have it. */
  shown: string | undefined;
  /** The Workflow being edited: it does not start itself. */
  current: string;
  choices: StepChoices<ChildWorkflowOption>;
  error?: string;
  onPick(child: ChildWorkflowOption): void;
  onBlur?(): void;
}) {
  const { t } = useTranslation();
  const children = (choices.rows ?? []).filter((child) => child.id !== current);
  const picked = children.find((child) => child.id === value);
  const label = t("workflows.settings.child");
  const note = choices.failed
    ? t("workflows.settings.childrenFailed")
    : choices.rows !== undefined && children.length === 0
      ? t("workflows.settings.childrenNone")
      : choices.more
        ? t("workflows.settings.choicesMore")
        : undefined;
  return (
    <Field label={label} required error={error}>
      <Picker
        label={label}
        options={children.map((child) => ({
          value: child.id,
          label: child.name,
          keywords: child.id,
          ...(child.mayStart
            ? {}
            : { disabled: true, disabledReason: t("workflows.settings.childMayNotStart") })
        }))}
        value={value}
        search
        wrapDescriptions
        {...(note === undefined ? {} : { note })}
        onValueChange={(id) => {
          const child = children.find((candidate) => candidate.id === id);
          if (child?.mayStart === true) onPick(child);
        }}
      >
        <PickerButton
          label={label}
          value={picked?.name ?? shown}
          placeholder={t("workflows.settings.chooseChild")}
          onBlur={onBlur}
        />
      </Picker>
    </Field>
  );
}
