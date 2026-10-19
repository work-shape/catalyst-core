import { useState } from "react";
import {
  FieldListEditor,
  type FieldListItem,
  type FieldListKind
} from "../forms/field-list-editor";
import { ScheduleField, type ScheduleValue } from "../forms/schedule-field";
import {
  SourcedValueField,
  type SourcedValue,
  type SourcedValueKind
} from "../forms/sourced-value-field";
import { useUiLabels } from "../ui-root";
import type { GalleryEntry } from "./entry";
import type { GalleryText } from "./text";

function ValueSample({
  text,
  kind = "text",
  initial = { kind: "fixed", value: "" },
  readOnly = false,
  error
}: {
  text: GalleryText;
  kind?: SourcedValueKind;
  initial?: SourcedValue;
  readOnly?: boolean;
  error?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <SourcedValueField
      label={text.name}
      value={value}
      onChange={setValue}
      kind={kind}
      readOnly={readOnly}
      error={error}
      options={[{ value: "result", label: text.flowLoadTitle, description: text.flowLoadSummary }]}
      choices={[
        { value: "member", label: text.roleMember },
        { value: "admin", label: text.roleAdmin }
      ]}
    />
  );
}

function FieldsSample({
  text,
  empty = false,
  readOnly = false,
  invalid = false
}: {
  text: GalleryText;
  empty?: boolean;
  readOnly?: boolean;
  invalid?: boolean;
}) {
  const labels = useUiLabels("FieldsSample");
  const kinds: readonly FieldListKind[] = [
    { value: "text", label: labels.fieldText },
    { value: "number", label: labels.fieldNumber },
    { value: "record", label: labels.fieldRecord, children: "record" },
    { value: "records", label: labels.fieldRecords, children: "records" }
  ];
  const [value, setValue] = useState<readonly FieldListItem[]>(
    empty
      ? []
      : [
          { id: "summary", name: text.flowResultTitle, kind: "text", required: true },
          {
            id: "record",
            name: text.flowLoadTitle,
            kind: "record",
            required: false,
            fields: [{ id: "nested", name: text.name, kind: "text", required: true }]
          },
          { id: "records", name: text.flowLoopTitle, kind: "records", required: false, fields: [] }
        ]
  );
  return (
    <FieldListEditor
      label={text.flowResultTitle}
      value={value}
      kinds={kinds}
      onChange={setValue}
      readOnly={readOnly}
      errors={invalid ? { summary: { name: text.nameError } } : undefined}
    />
  );
}

function ScheduleSample({
  initial,
  text,
  readOnly = false,
  invalid = false
}: {
  initial: ScheduleValue;
  text: GalleryText;
  readOnly?: boolean;
  invalid?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <ScheduleField
      label={text.flowKindStart}
      value={value}
      onChange={setValue}
      readOnly={readOnly}
      error={invalid ? text.scheduleIncomplete : undefined}
    />
  );
}

function ScheduleSamples({ text }: { text: GalleryText }) {
  const samples: readonly ScheduleValue[] = [
    { kind: "hour", minute: 15, zone: "Europe/Berlin" },
    { kind: "day", time: "09:00", zone: "Europe/Berlin" },
    { kind: "weekday", time: "08:30", zone: "Europe/Berlin" },
    { kind: "week", days: [1, 3, 5], time: "09:00", zone: "Europe/Berlin" },
    { kind: "month", day: 1, time: "06:00", zone: "Europe/Berlin" }
  ];
  return (
    <div className="grid w-full max-w-sm gap-6">
      {samples.map((initial) => (
        <ScheduleSample key={initial.kind} initial={initial} text={text} />
      ))}
      <ScheduleSample
        text={text}
        initial={{ kind: "day", time: "09:00", zone: "Europe/Berlin" }}
        readOnly
      />
      <ScheduleSample
        text={text}
        initial={{ kind: "week", days: [], time: "", zone: "" }}
        invalid
      />
    </div>
  );
}

export const editingFormsEntries: readonly GalleryEntry[] = [
  {
    name: "SourcedValueField",
    components: ["SourcedValueField"],
    render: (text) => (
      <div className="grid w-full max-w-sm gap-6">
        <ValueSample text={text} />
        <ValueSample text={text} initial={{ kind: "fixed", value: text.namePlaceholder }} />
        <ValueSample text={text} initial={{ kind: "picked", option: "result" }} />
        <ValueSample text={text} initial={{ kind: "picked", option: "" }} error={text.nameError} />
        <ValueSample text={text} kind="number" initial={{ kind: "fixed", value: 5 }} />
        <ValueSample text={text} kind="integer" initial={{ kind: "fixed", value: 2 }} />
        <ValueSample text={text} kind="boolean" initial={{ kind: "fixed", value: true }} />
        <ValueSample text={text} kind="select" initial={{ kind: "fixed", value: "member" }} />
        <ValueSample
          text={text}
          kind="textarea"
          initial={{ kind: "fixed", value: text.cardBody }}
        />
        <ValueSample text={text} initial={{ kind: "picked", option: "result" }} readOnly />
        <ValueSample
          text={text}
          initial={{ kind: "fixed", value: text.namePlaceholder }}
          readOnly
        />
      </div>
    )
  },
  {
    name: "FieldListEditor",
    components: ["FieldListEditor"],
    render: (text) => (
      <div className="grid w-full max-w-sm gap-6">
        <FieldsSample text={text} empty />
        <FieldsSample text={text} />
        <FieldsSample text={text} invalid />
        <FieldsSample text={text} readOnly />
      </div>
    )
  },
  {
    name: "ScheduleField",
    components: ["ScheduleField"],
    render: (text) => <ScheduleSamples text={text} />
  }
];
