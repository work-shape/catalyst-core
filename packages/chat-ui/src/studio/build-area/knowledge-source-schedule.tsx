import { useState } from "react";
import {
  Field,
  Input,
  ScheduleField,
  Select,
  Switch,
  type ScheduleValue
} from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";
import { cronSchedule, scheduleCron } from "../workflows/schedule-cron";
import type { KnowledgeChoice, KnowledgeSourceStatus } from "./knowledge-base-source";
import {
  FULL_SYNC_DEFAULT,
  SYNC_OFF,
  syncsByItself,
  type KnowledgeSourceSchedule
} from "./knowledge-sources-model";

// When one source of the draft syncs by itself (SRC-SYNC): one switch for all of it, and under
// it how often its changes are fetched and when the full sync runs. Off, the source syncs only
// when a person asks, and its documents stay as they are. Like its folders it takes effect at
// publish. The full sync runs in the instance's time zone, so the field offers no zone.

/** The intervals offered for fetching changes, in minutes. A stored other one is offered too. */
const CHANGE_INTERVALS = [5, 15, 30, 60, 240, 1_440] as const;
/** The choice that leaves the interval to the instance. */
const DEFAULT_CHOICE = "default";
/** The zone the field carries but never shows: cron has none, the instance gives it. */
const NO_ZONE = "UTC";

/**
 * What a source takes where it sets nothing: its connector type's full pass and shortest poll,
 * and, once published, the poll the instance gives it. A type that names none takes nightly.
 */
export interface SourceScheduleDefaults {
  changes?: number;
  full: string;
  minChanges?: number;
}

export function scheduleDefaults(
  published: KnowledgeSourceStatus["schedule"] | undefined,
  choice: KnowledgeChoice | undefined
): SourceScheduleDefaults {
  const minChanges = published?.minChanges ?? choice?.sourceMinChanges;
  return {
    ...(published ? { changes: published.defaultChanges } : {}),
    full: published?.defaultFull ?? choice?.sourceFull ?? FULL_SYNC_DEFAULT,
    ...(minChanges === undefined ? {} : { minChanges })
  };
}

/** An interval in words: every 15 minutes, every hour, every 4 hours, once a day. */
export function intervalWords(minutes: number, t: TranslationContextValue["t"]): string {
  if (minutes === 1_440) return t("knowledgeSources.everyDay");
  if (minutes === 60) return t("knowledgeSources.everyHour");
  if (minutes % 60 === 0) return t("knowledgeSources.everyHours", { hours: minutes / 60 });
  return t("knowledgeSources.everyMinutes", { minutes });
}

/** "Alle 15 Minuten" inside a sentence: "wie die Instanz es vorgibt (alle 15 Minuten)". */
function lowerFirst(text: string, locale: string): string {
  return text.charAt(0).toLocaleLowerCase(locale) + text.slice(1);
}

export function KnowledgeSourceSchedule({
  schedule,
  defaults,
  readOnly,
  onChange
}: {
  schedule: KnowledgeSourceSchedule | undefined;
  /** What the source takes where it sets nothing, as far as it is known. */
  defaults: SourceScheduleDefaults;
  readOnly: boolean;
  onChange(schedule: KnowledgeSourceSchedule | undefined): void;
}) {
  const { locale, t } = useTranslation();
  // What the switch brings back once turned on again in this visit; the defaults otherwise.
  const [before, setBefore] = useState<KnowledgeSourceSchedule | undefined>();
  const on = syncsByItself(schedule);
  const changes = schedule?.changes;
  const full = schedule?.full;
  const write = (patch: KnowledgeSourceSchedule) => {
    const next = { ...schedule, ...patch };
    const kept = {
      ...(next.changes === undefined ? {} : { changes: next.changes }),
      ...(next.full === undefined ? {} : { full: next.full })
    };
    onChange(Object.keys(kept).length > 0 ? kept : undefined);
  };
  const turn = (value: boolean) => {
    if (value) {
      onChange(before);
      return;
    }
    setBefore(schedule);
    onChange({ changes: SYNC_OFF, full: SYNC_OFF });
  };
  const floor = defaults.minChanges ?? 0;
  const intervals: number[] = CHANGE_INTERVALS.filter((minutes) => minutes >= floor);
  if (typeof changes === "number" && !intervals.includes(changes)) intervals.push(changes);
  intervals.sort((a, b) => a - b);
  const fullOn = full !== SYNC_OFF;
  const fullCron = full === undefined || full === SYNC_OFF ? defaults.full : full;
  // A schedule being filled in that is no whole one yet stays as it is, and the full sync keeps
  // the one it had until it is.
  const [shown, setShown] = useState<{ cron: string; value: ScheduleValue }>();
  const fullForm = shown?.cron === fullCron ? shown.value : cronSchedule(fullCron, NO_ZONE);
  return (
    <fieldset className="grid min-w-0 gap-3" data-knowledge-source-schedule={on ? "on" : "off"}>
      <legend className="mb-1 text-label">{t("knowledgeSources.sync")}</legend>
      <Field
        layout="inline"
        label={t("knowledgeSources.syncAuto")}
        hint={on ? undefined : t("knowledgeSources.syncAutoOff")}
      >
        <Switch
          checked={on}
          disabled={readOnly}
          data-knowledge-source-sync-auto=""
          onCheckedChange={turn}
        />
      </Field>
      {on ? (
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <Field
            label={t("knowledgeSources.syncChanges")}
            hint={
              defaults.minChanges === undefined
                ? t("knowledgeSources.syncChangesHint")
                : `${t("knowledgeSources.syncChangesHint")} ${t(
                    "knowledgeSources.syncChangesFloor",
                    {
                      interval: lowerFirst(intervalWords(defaults.minChanges, t), locale)
                    }
                  )}`
            }
          >
            <Select
              value={changes === undefined ? DEFAULT_CHOICE : String(changes)}
              disabled={readOnly}
              data-knowledge-source-sync-changes=""
              onChange={(event) => {
                const value = event.target.value;
                write({
                  changes:
                    value === DEFAULT_CHOICE
                      ? undefined
                      : value === SYNC_OFF
                        ? SYNC_OFF
                        : Number(value)
                });
              }}
            >
              <option value={DEFAULT_CHOICE}>
                {defaults.changes === undefined
                  ? t("knowledgeSources.syncChangesDefault")
                  : t("knowledgeSources.syncChangesDefaultIs", {
                      interval: lowerFirst(intervalWords(defaults.changes, t), locale)
                    })}
              </option>
              {intervals.map((minutes) => (
                <option key={minutes} value={String(minutes)}>
                  {intervalWords(minutes, t)}
                </option>
              ))}
              <option value={SYNC_OFF}>{t("knowledgeSources.syncNever")}</option>
            </Select>
          </Field>
          <div className="grid min-w-0 content-start gap-3">
            <Field
              layout="inline"
              label={t("knowledgeSources.syncFull")}
              hint={t("knowledgeSources.syncFullHint")}
            >
              <Switch
                checked={fullOn}
                disabled={readOnly}
                data-knowledge-source-sync-full=""
                onCheckedChange={(value) => write({ full: value ? undefined : SYNC_OFF })}
              />
            </Field>
            {!fullOn ? null : fullForm ? (
              <ScheduleField
                label={t("knowledgeSources.syncFullWhen")}
                value={fullForm}
                readOnly={readOnly}
                zonePicker={false}
                error={
                  scheduleCron(fullForm) === undefined
                    ? t("knowledgeSources.syncFullIncomplete")
                    : undefined
                }
                onChange={(value) => {
                  const cron = scheduleCron(value);
                  setShown({ cron: cron ?? fullCron, value });
                  if (cron !== undefined)
                    write({ full: cron === defaults.full ? undefined : cron });
                }}
              />
            ) : (
              <Field
                label={t("knowledgeSources.syncFullCron")}
                hint={t("knowledgeSources.syncFullCronHint")}
              >
                <Input
                  value={fullCron}
                  readOnly={readOnly}
                  spellCheck={false}
                  className="font-mono"
                  data-knowledge-source-sync-cron=""
                  onChange={(event) => write({ full: event.target.value })}
                />
              </Field>
            )}
          </div>
        </div>
      ) : null}
    </fieldset>
  );
}
