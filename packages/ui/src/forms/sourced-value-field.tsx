import type { ReactNode } from "react";
import { SegmentedControl, SegmentedControlItem } from "../navigation/segmented-control";
import {
  Picker,
  PickerButton,
  type PickerOption,
  type PickerOptionGroup
} from "../overlays/picker";
import { useUiLabels } from "../ui-root";
import { Field } from "./field";
import { Input, Textarea } from "./input";
import { Select } from "./select";
import { Switch } from "./switch";

export type FixedValue = string | number | boolean | null;
export type SourcedValue =
  { kind: "fixed"; value: FixedValue } | { kind: "picked"; option: string };
export type SourcedValueKind = "text" | "textarea" | "number" | "integer" | "boolean" | "select";

export interface SourcedValueFieldProps {
  label: string;
  value: SourcedValue;
  onChange(value: SourcedValue): void;
  kind?: SourcedValueKind;
  /**
   * The values of earlier steps the field may take, already scoped and named by the caller,
   * on their own or in groups, such as one group per step.
   */
  options: readonly (PickerOption | PickerOptionGroup)[];
  /** Only a value from a step, such as the list a loop runs over: no fixed value, no toggle. */
  pickedOnly?: boolean;
  /** The choices for a fixed value of kind select. */
  choices?: readonly { value: string; label: string }[];
  hint?: ReactNode;
  error?: ReactNode;
  readOnly?: boolean;
  onBlur?(): void;
}

/**
 * One fixed value or a value from an earlier step, with the toggle between them beside the
 * label. It knows no paths, schemas or domain objects.
 */
export function SourcedValueField({
  label,
  value,
  onChange,
  kind = "text",
  options,
  choices = [],
  hint,
  error,
  readOnly = false,
  pickedOnly = false,
  onBlur
}: SourcedValueFieldProps) {
  const labels = useUiLabels("SourcedValueField");
  const initialFixed =
    kind === "boolean" ? false : kind === "number" || kind === "integer" ? null : "";
  const fixed = value.kind === "fixed" ? value.value : initialFixed;
  const text = typeof fixed === "string" || typeof fixed === "number" ? fixed : "";
  const setFixed = (next: FixedValue) => onChange({ kind: "fixed", value: next });
  const picked = value.kind === "picked" ? value.option : undefined;
  const chosen = options
    .flatMap((entry) => ("options" in entry ? entry.options : [entry]))
    .find((option) => option.value === picked);
  const control =
    value.kind === "picked" || pickedOnly ? (
      readOnly ? (
        <Input readOnly value={chosen?.label ?? labels.chooseValue} />
      ) : (
        <Picker
          label={label}
          options={options}
          value={picked}
          search
          onValueChange={(option) => onChange({ kind: "picked", option })}
        >
          <PickerButton
            label={label}
            value={chosen?.label}
            onBlur={onBlur}
            placeholder={labels.chooseValue}
          />
        </Picker>
      )
    ) : kind === "boolean" ? (
      <Switch
        checked={fixed === true}
        disabled={readOnly}
        onBlur={onBlur}
        onCheckedChange={setFixed}
      />
    ) : kind === "select" ? (
      <Select
        value={String(text)}
        disabled={readOnly}
        onBlur={onBlur}
        onChange={(event) => setFixed(event.target.value)}
      >
        <option value="">{labels.chooseValue}</option>
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </Select>
    ) : kind === "textarea" ? (
      <Textarea
        value={text}
        readOnly={readOnly}
        onBlur={onBlur}
        onChange={(event) => setFixed(event.target.value)}
      />
    ) : (
      <Input
        type={kind === "number" || kind === "integer" ? "number" : "text"}
        step={kind === "integer" ? 1 : "any"}
        value={text}
        readOnly={readOnly}
        onBlur={onBlur}
        onChange={(event) =>
          setFixed(
            kind === "number" || kind === "integer"
              ? event.target.value === ""
                ? null
                : event.target.valueAsNumber
              : event.target.value
          )
        }
      />
    );
  // Beside the field's own label, which it belongs to: the label names the field first.
  const toggle = pickedOnly ? undefined : (
    <SegmentedControl
      size="sm"
      label={`${label}: ${labels.valueSource}`}
      value={value.kind}
      disabled={readOnly}
      onValueChange={(mode) =>
        onChange(
          mode === "picked"
            ? { kind: "picked", option: "" }
            : { kind: "fixed", value: initialFixed }
        )
      }
    >
      <SegmentedControlItem value="fixed">{labels.valueFixed}</SegmentedControlItem>
      <SegmentedControlItem value="picked">{labels.valuePicked}</SegmentedControlItem>
    </SegmentedControl>
  );
  return (
    <Field
      data-slot="sourced-value-field"
      className="min-w-0"
      label={label}
      labelEnd={toggle}
      hint={hint}
      error={error}
    >
      {control}
    </Field>
  );
}
