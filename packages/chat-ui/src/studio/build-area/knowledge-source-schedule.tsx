import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import {
  Button,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScheduleField,
  Select,
  SettingsList,
  SettingsRow,
  Switch,
  type ScheduleValue
} from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";
import { cronSchedule, scheduleCron } from "../workflows/schedule-cron";
import { scheduleInWords } from "../workflows/schedule-words";
import type { KnowledgeChoice, KnowledgeSourceStatus } from "./knowledge-base-source";
import {
  FULL_SYNC_DEFAULT,
  SYNC_OFF,
  syncsByItself,
  type KnowledgeSourceSchedule
} from "./knowledge-sources-model";

// When one source of the draft syncs by itself (SRC-SYNC), as rows of settings: one switch for
// all of it, and under it how often new and changed files are fetched and when what was deleted
// is removed. Each row has its control at its end; the time is one button that reads as the
// schedule does and opens its fields. Off, the source syncs only when a person asks, and its
// documents stay as they are. Like its folders it takes effect at publish. Deleted files are
// removed in the instance's time zone, so the fields offer no zone.

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

/** A full pass every night: a cron of one clock time before six, on every day. */
function nightly(cron: string): boolean {
  const [minute = "", hour = "", ...rest] = cron.trim().split(/\s+/u);
  return (
    /^\d+$/u.test(minute) &&
    /^\d+$/u.test(hour) &&
    Number(hour) < 6 &&
    rest.length === 3 &&
    rest.every((field) => field === "*")
  );
}

/**
 * How one source keeps itself current, in one sentence a person reads in place of its schedule:
 * how often new and changed files arrive, and when deleted ones leave. Built from what the
 * source sets and, where it sets nothing, what it takes. The pass that removes deleted files
 * lists the source by name and date; it downloads no unchanged file again.
 */
export function sourceScheduleSentence(
  schedule: KnowledgeSourceSchedule | undefined,
  defaults: SourceScheduleDefaults,
  web: boolean,
  translation: Pick<TranslationContextValue, "locale" | "t">
): string {
  const { locale, t } = translation;
  const items = t(web ? "knowledgeSources.wordsPages" : "knowledgeSources.wordsFiles");
  if (!syncsByItself(schedule)) return t("knowledgeSources.sentenceOff", { items });
  const changes = schedule?.changes ?? defaults.changes;
  const fullCron = schedule?.full ?? defaults.full;
  const regularly = t("knowledgeSources.wordsRegularly");
  const interval =
    typeof changes === "number" ? lowerFirst(intervalWords(changes, t), locale) : regularly;
  const inWords = scheduleInWords(fullCron, translation);
  const full = nightly(fullCron)
    ? t("knowledgeSources.wordsNightly")
    : inWords === undefined
      ? regularly
      : lowerFirst(inWords, locale);
  if (fullCron === SYNC_OFF) return t("knowledgeSources.sentenceChangesOnly", { items, interval });
  if (changes === SYNC_OFF) return t("knowledgeSources.sentenceFullOnly", { items, full });
  return t("knowledgeSources.sentenceBoth", { items, interval, full });
}

export function KnowledgeSourceSchedule({
  schedule,
  defaults,
  web = false,
  readOnly,
  onChange
}: {
  schedule: KnowledgeSourceSchedule | undefined;
  /** What the source takes where it sets nothing, as far as it is known. */
  defaults: SourceScheduleDefaults;
  /** A source of web pages: it fetches pages, not files. */
  web?: boolean;
  readOnly: boolean;
  onChange(schedule: KnowledgeSourceSchedule | undefined): void;
}) {
  const translation = useTranslation();
  const { locale, t } = translation;
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
  // The row's label is the switch's; the cron field beside it names itself.
  const cronId = useId();
  const incomplete = fullForm !== undefined && scheduleCron(fullForm) === undefined;
  const items = t(web ? "knowledgeSources.wordsPages" : "knowledgeSources.wordsFiles");
  return (
    <SettingsList
      aria-label={t("knowledgeSources.sync")}
      className="border-y"
      data-knowledge-source-schedule={on ? "on" : "off"}
    >
      <SettingsRow
        label={t("knowledgeSources.syncAuto")}
        description={t(on ? "knowledgeSources.syncAutoOn" : "knowledgeSources.syncAutoOff")}
      >
        <Switch
          checked={on}
          disabled={readOnly}
          data-knowledge-source-sync-auto=""
          onCheckedChange={turn}
        />
      </SettingsRow>
      {on ? (
        <SettingsRow
          label={t("knowledgeSources.syncChanges")}
          description={
            defaults.minChanges === undefined
              ? t("knowledgeSources.syncChangesHint", { items })
              : t("knowledgeSources.syncChangesHintFloor", {
                  items,
                  interval: lowerFirst(intervalWords(defaults.minChanges, t), locale)
                })
          }
        >
          <Select
            className="w-60 max-w-full"
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
        </SettingsRow>
      ) : null}
      {on ? (
        <SettingsRow
          label={t("knowledgeSources.syncFull")}
          description={
            fullOn && fullForm === undefined
              ? t("knowledgeSources.syncFullCronHint")
              : t("knowledgeSources.syncFullHint")
          }
          error={fullOn && incomplete ? t("knowledgeSources.syncFullIncomplete") : undefined}
        >
          {!fullOn ? null : fullForm === undefined ? (
            // A schedule the fields cannot hold stands as the cron expression it is.
            <Input
              id={cronId}
              value={fullCron}
              readOnly={readOnly}
              spellCheck={false}
              className="w-44 font-mono"
              aria-label={t("knowledgeSources.syncFullCron")}
              data-knowledge-source-sync-cron=""
              onChange={(event) => write({ full: event.target.value })}
            />
          ) : (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={t("knowledgeSources.syncFullWhenIs", {
                    when: fullWords(fullForm, translation)
                  })}
                  data-knowledge-source-sync-when=""
                >
                  {fullWords(fullForm, translation)}
                  <ChevronDown aria-hidden="true" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" size="md" aria-label={t("knowledgeSources.syncFull")}>
                <div className="grid min-w-0 gap-3">
                  <ScheduleField
                    label={t("knowledgeSources.syncFullWhen")}
                    labelHidden
                    value={fullForm}
                    readOnly={readOnly}
                    zonePicker={false}
                    // What is missing is said once, in the row under its label.
                    onChange={(value) => {
                      const cron = scheduleCron(value);
                      setShown({ cron: cron ?? fullCron, value });
                      if (cron !== undefined)
                        write({ full: cron === defaults.full ? undefined : cron });
                    }}
                  />
                  <p className="text-caption text-muted-foreground">
                    {t("knowledgeSources.syncFullZone")}
                  </p>
                </div>
              </PopoverContent>
            </Popover>
          )}
          <Switch
            checked={fullOn}
            disabled={readOnly}
            data-knowledge-source-sync-full=""
            onCheckedChange={(value) => write({ full: value ? undefined : SYNC_OFF })}
          />
        </SettingsRow>
      ) : null}
    </SettingsList>
  );
}

/**
 * The schedule on its button, in one line: "Daily at 02:00". Days of a week are named short,
 * and a schedule that is no whole one yet asks for one.
 */
function fullWords(
  form: ScheduleValue,
  { locale, t }: Pick<TranslationContextValue, "locale" | "t">
): string {
  if (form.kind === "hour") {
    return t("knowledgeSources.whenHour", { minute: String(form.minute).padStart(2, "0") });
  }
  const [hour = 0, minute = 0] = form.time.split(":").map(Number);
  if (form.time === "" || Number.isNaN(hour) || Number.isNaN(minute)) {
    return t("knowledgeSources.whenChoose");
  }
  // A clock time has no day: any day in UTC gives the same words.
  const time = new Date(Date.UTC(2026, 0, 1, hour, minute)).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC"
  });
  switch (form.kind) {
    case "day":
      return t("knowledgeSources.whenDay", { time });
    case "weekday":
      return t("knowledgeSources.whenWeekday", { time });
    case "month":
      return t("knowledgeSources.whenMonth", { day: form.day, time });
    case "week":
      if (form.days.length === 0) return t("knowledgeSources.whenChoose");
      return t("knowledgeSources.whenWeek", {
        // 5 January 2026 is a Monday, the field's day 1.
        days: new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(
          form.days.map((day) =>
            new Date(Date.UTC(2026, 0, 4 + day)).toLocaleDateString(locale, {
              weekday: "short",
              timeZone: "UTC"
            })
          )
        ),
        time
      });
  }
}
