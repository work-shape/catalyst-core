import { useMemo, useState, type FormEvent } from "react";
import {
  Button,
  Dialog,
  Field,
  FormNotice,
  Input,
  Select,
  Textarea
} from "@work-shape/catalyst-ui";
import { SCHEDULED_START_MIN_INTERVAL_MINUTES } from "@work-shape/catalyst-core";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import { zoneInWords } from "../../studio/workflows/schedule-words";
import {
  DEFAULT_SCHEDULE,
  SCHEDULE_PRESETS,
  choiceOf,
  cronLooksValid,
  cronOf,
  cronRunsTooOften,
  scheduleLine,
  timeZoneChoices,
  type ScheduleChoice,
  type SchedulePreset,
  type ScheduledStartInput
} from "./scheduled-model";

/** An agent the person may choose: the agents the open workspace offers. */
export interface ScheduledAgent {
  name: string;
  displayName: string;
}

/** What the dialog opens with: a saved start to edit, or the start of a new one. */
export interface ScheduledDraft {
  /** The saved start this edits. Absent for a new one. */
  scheduledStartId?: string;
  agentName?: string;
  prompt: string;
  /** Absent for a new one: it starts on every weekday at eight. */
  cron?: string;
  /** Absent for a new one: it starts in the instance's zone. */
  timeZone?: string;
}

const PRESET_LABEL: Record<SchedulePreset, TranslationKey> = {
  daily: "scheduled.preset.daily",
  weekdays: "scheduled.preset.weekdays",
  weekly: "scheduled.preset.weekly",
  monthly: "scheduled.preset.monthly",
  custom: "scheduled.preset.custom"
};

const FORM_ID = "scheduled-start-form";

/**
 * The one dialog that makes a new scheduled prompt and changes a saved one: the agent, the
 * prompt, when it repeats and in which time zone. A failed save says so above the buttons and
 * keeps what was written.
 */
export function ScheduledDialog({
  draft,
  agents,
  defaultAgentName,
  instanceTimeZone,
  saving,
  failed,
  onSave,
  onClose
}: {
  draft: ScheduledDraft;
  agents: readonly ScheduledAgent[];
  defaultAgentName: string | undefined;
  /** The zone a new one starts in. */
  instanceTimeZone: string;
  saving: boolean;
  failed: boolean;
  onSave(values: ScheduledStartInput): void;
  onClose(): void;
}) {
  const { locale, t } = useTranslation();
  const editing = draft.scheduledStartId !== undefined;
  const [agentName, setAgentName] = useState(
    () =>
      [draft.agentName, defaultAgentName, agents[0]?.name].find(
        (name) => name !== undefined && agents.some((agent) => agent.name === name)
      ) ??
      draft.agentName ??
      ""
  );
  const [prompt, setPrompt] = useState(draft.prompt);
  const [schedule, setSchedule] = useState<ScheduleChoice>(() =>
    draft.cron === undefined ? DEFAULT_SCHEDULE : choiceOf(draft.cron)
  );
  const [timeZone, setTimeZone] = useState(draft.timeZone ?? instanceTimeZone);
  // Field errors show once the person tried to save, and go as the field is put right.
  const [checked, setChecked] = useState(false);
  // Each zone as the schedule field says it, "Berlin time", in the order of those words.
  const zones = useMemo(
    () =>
      timeZoneChoices(timeZone)
        .map((zone) => ({ zone, label: zoneInWords(zone, locale) }))
        .sort((left, right) => left.label.localeCompare(right.label, locale)),
    [timeZone, locale]
  );
  const weekdays = useMemo(() => weekdayNames(locale), [locale]);

  const cron = cronOf(schedule);
  const promptError = prompt.trim() === "" ? t("scheduled.promptRequired") : undefined;
  const agentError = agentName === "" ? t("scheduled.agentRequired") : undefined;
  const cronError = !cronLooksValid(cron)
    ? t("scheduled.cronInvalid")
    : cronRunsTooOften(cron)
      ? t("scheduled.cronTooOften", { minutes: SCHEDULED_START_MIN_INTERVAL_MINUTES })
      : undefined;
  const valid = !promptError && !agentError && !cronError;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setChecked(true);
    if (valid) {
      onSave({ agentName, prompt: prompt.trim(), cron, timeZone });
    }
  }

  return (
    <Dialog
      open
      size="md"
      title={t(editing ? "scheduled.dialogEdit" : "scheduled.dialogNew")}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" form={FORM_ID} loading={saving}>
            {t(editing ? "scheduled.save" : "scheduled.create")}
          </Button>
        </>
      }
    >
      <form
        id={FORM_ID}
        className="grid min-w-0 gap-4"
        data-testid="scheduled-dialog"
        noValidate
        onSubmit={submit}
      >
        <Field
          label={t("scheduled.agent")}
          required
          error={agents.length === 0 ? t("scheduled.noAgents") : checked ? agentError : undefined}
        >
          <Select
            name="agent"
            value={agentName}
            disabled={agents.length === 0}
            onChange={(event) => setAgentName(event.target.value)}
          >
            {agents.map((agent) => (
              <option key={agent.name} value={agent.name}>
                {agent.displayName}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={t("scheduled.prompt")}
          hint={t("scheduled.promptHint")}
          required
          error={checked ? promptError : undefined}
        >
          <Textarea
            name="prompt"
            autoFocus={!editing}
            rows={4}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </Field>
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <Field label={t("scheduled.repeat")}>
            <Select
              name="repeat"
              value={schedule.preset}
              onChange={(event) => {
                const preset = SCHEDULE_PRESETS.find((value) => value === event.target.value);
                if (preset) {
                  // A custom schedule starts from the one chosen before, to change by hand.
                  setSchedule({ ...schedule, preset, cron });
                }
              }}
            >
              {SCHEDULE_PRESETS.map((preset) => (
                <option key={preset} value={preset}>
                  {t(PRESET_LABEL[preset])}
                </option>
              ))}
            </Select>
          </Field>
          {schedule.preset === "weekly" ? (
            <Field label={t("scheduled.weekday")}>
              <Select
                name="weekday"
                value={String(schedule.weekday)}
                onChange={(event) =>
                  setSchedule({ ...schedule, weekday: Number(event.target.value) })
                }
              >
                {weekdays.map((name, day) => (
                  <option key={name} value={String(day)}>
                    {name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {schedule.preset === "custom" ? null : (
            <Field label={t("scheduled.time")}>
              <Input
                name="time"
                type="time"
                required
                value={schedule.time}
                onChange={(event) =>
                  setSchedule({ ...schedule, time: event.target.value || schedule.time })
                }
              />
            </Field>
          )}
        </div>
        {schedule.preset === "custom" ? (
          <Field
            label={t("scheduled.cron")}
            hint={t("scheduled.cronHint")}
            required
            error={checked ? cronError : undefined}
          >
            <Input
              name="cron"
              className="font-mono"
              spellCheck={false}
              autoComplete="off"
              value={schedule.cron}
              onChange={(event) => setSchedule({ ...schedule, cron: event.target.value })}
            />
          </Field>
        ) : null}
        <Field label={t("scheduled.timeZone")} hint={t("scheduled.timeZoneHint")}>
          <Select
            name="timeZone"
            value={timeZone}
            onChange={(event) => setTimeZone(event.target.value)}
          >
            {zones.map(({ zone, label }) => (
              <option key={zone} value={zone}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        {cronError ? null : (
          <p className="text-caption text-muted-foreground" data-testid="scheduled-dialog-summary">
            {scheduleLine({ cron, timeZone }, { locale, t })}
          </p>
        )}
        {failed ? <FormNotice tone="error">{t("scheduled.saveFailed")}</FormNotice> : null}
      </form>
    </Dialog>
  );
}

/** The names of the days of the week in the reader's language, Sunday first as cron counts. */
function weekdayNames(locale: string): string[] {
  // 4 January 2026 is a Sunday.
  return Array.from({ length: 7 }, (_, day) =>
    new Date(Date.UTC(2026, 0, 4 + day)).toLocaleDateString(locale, {
      weekday: "long",
      timeZone: "UTC"
    })
  );
}
