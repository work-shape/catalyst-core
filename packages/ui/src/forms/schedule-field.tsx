import { useId, useMemo, type ReactNode } from "react";
import type { UiLabels } from "../labels";
import { Picker, PickerButton, type PickerOption } from "../overlays/picker";
import { useUiLabels } from "../ui-root";
import { Checkbox } from "./checkbox";
import { Field } from "./field";
import { Input } from "./input";
import { Select } from "./select";

/** Monday is 1, Sunday is 7. No cron convention crosses this boundary. */
export type ScheduleWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type ScheduleValue =
  | { kind: "hour"; minute: number; zone: string }
  | { kind: "day" | "weekday"; time: string; zone: string }
  | { kind: "week"; days: readonly ScheduleWeekday[]; time: string; zone: string }
  | { kind: "month"; day: number; time: string; zone: string };

export interface ScheduleFieldProps {
  label: string;
  value: ScheduleValue;
  onChange(value: ScheduleValue): void;
  error?: ReactNode;
  readOnly?: boolean;
}

const weekdays: readonly ScheduleWeekday[] = [1, 2, 3, 4, 5, 6, 7];
const dayLabels = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday"
] as const;
const frequencies = ["hour", "day", "weekday", "week", "month"] as const;
const frequencyLabels = {
  hour: "scheduleHour",
  day: "scheduleDay",
  weekday: "scheduleWeekday",
  week: "scheduleWeek",
  month: "scheduleMonth"
} as const;

/** The zone is a time zone the browser knows by its IANA id, such as "Europe/Berlin". */
export function isScheduleZone(zone: string): boolean {
  if (zone.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** A zone in words: "Berlin time" for "Europe/Berlin". The id itself is never shown. */
function zoneWords(zone: string, labels: UiLabels): string {
  if (zone === "UTC" || zone === "Etc/UTC") return labels.scheduleZoneUtc;
  const city = (zone.split("/").at(-1) ?? zone).replaceAll("_", " ");
  return labels.scheduleZoneCity.replace("{city}", city);
}

let knownZones: readonly string[] | undefined;
function zoneIds(): readonly string[] {
  if (knownZones === undefined) {
    let ids: readonly string[] = [];
    try {
      ids = Intl.supportedValuesOf("timeZone");
    } catch {
      ids = [];
    }
    knownZones = ids.includes("UTC") ? ids : ["UTC", ...ids];
  }
  return knownZones;
}

/** A schedule in words, with product-owned values. Parsing and cron belong to the caller. */
export function ScheduleField({
  label,
  value,
  onChange,
  error,
  readOnly = false
}: ScheduleFieldProps) {
  const labels = useUiLabels("ScheduleField");
  const errorId = useId();
  const zones = useMemo<PickerOption[]>(
    () =>
      zoneIds()
        .map((zone) => ({ value: zone, label: zoneWords(zone, labels), keywords: zone }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [labels]
  );
  const zoneValid = isScheduleZone(value.zone);
  const zoneLabel = zoneValid ? zoneWords(value.zone, labels) : undefined;
  const changeKind = (kind: string) => {
    const time = value.kind === "hour" ? `09:${String(value.minute).padStart(2, "0")}` : value.time;
    const zone = value.zone;
    switch (kind) {
      case "hour":
        onChange({ kind, minute: Number(time.slice(3)), zone });
        break;
      case "day":
      case "weekday":
        onChange({ kind, time, zone });
        break;
      case "week":
        onChange({ kind, time, zone, days: [1] });
        break;
      case "month":
        onChange({ kind, time, zone, day: 1 });
        break;
    }
  };
  return (
    <fieldset
      data-slot="schedule-field"
      className="grid min-w-0 gap-3"
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? errorId : undefined}
    >
      <legend className="mb-2 text-label">{label}</legend>
      <Field label={labels.scheduleFrequency}>
        <Select
          value={value.kind}
          disabled={readOnly}
          onChange={(event) => changeKind(event.target.value)}
        >
          {frequencies.map((kind) => (
            <option key={kind} value={kind}>
              {labels[frequencyLabels[kind]]}
            </option>
          ))}
        </Select>
      </Field>
      {value.kind === "week" ? (
        <fieldset className="grid gap-2">
          <legend className="mb-2 text-label">{labels.scheduleDays}</legend>
          {weekdays.map((day, index) => (
            <Checkbox
              key={day}
              label={labels[dayLabels[index] ?? "monday"]}
              checked={value.days.includes(day)}
              disabled={readOnly}
              onCheckedChange={(checked) =>
                onChange({
                  ...value,
                  days: checked
                    ? [...value.days, day].sort((a, b) => a - b)
                    : value.days.filter((entry) => entry !== day)
                })
              }
            />
          ))}
        </fieldset>
      ) : null}
      {value.kind === "month" ? (
        <Field label={labels.scheduleMonthDay}>
          <Select
            value={value.day}
            disabled={readOnly}
            onChange={(event) => onChange({ ...value, day: Number(event.target.value) })}
          >
            {Array.from({ length: 31 }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                {i + 1}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {value.kind === "hour" ? (
        <Field label={labels.scheduleMinute}>
          <Select
            value={value.minute}
            disabled={readOnly}
            onChange={(event) => onChange({ ...value, minute: Number(event.target.value) })}
          >
            {Array.from({ length: 60 }, (_, i) => (
              <option key={i} value={i}>
                {String(i).padStart(2, "0")}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <Field label={labels.scheduleTime}>
          <Input
            type="time"
            value={value.time}
            readOnly={readOnly}
            onChange={(event) => onChange({ ...value, time: event.target.value })}
          />
        </Field>
      )}
      <Field label={labels.scheduleZone} error={zoneValid ? undefined : labels.scheduleZoneInvalid}>
        {readOnly ? (
          <Input readOnly value={zoneLabel ?? ""} />
        ) : (
          <Picker
            label={labels.scheduleZone}
            options={zones}
            value={zoneValid ? value.zone : undefined}
            search
            onValueChange={(zone) => onChange({ ...value, zone })}
          >
            <PickerButton
              label={labels.scheduleZone}
              value={zoneLabel}
              placeholder={labels.scheduleZoneChoose}
            />
          </Picker>
        )}
      </Field>
      {error ? (
        <p id={errorId} role="alert" className="text-caption text-destructive">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
