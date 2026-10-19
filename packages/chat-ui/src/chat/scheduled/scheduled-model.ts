import {
  parseCron,
  SCHEDULED_START_MIN_INTERVAL_MINUTES,
  shortestCronGapMinutes,
  type SCHEDULED_START_STATES
} from "@work-shape/catalyst-core";
import type { BadgeTone } from "@work-shape/catalyst-ui";
import type { TranslationContextValue, TranslationKey } from "../../shared/i18n";
import { scheduleInWords } from "../../studio/workflows/schedule-words";

// The Scheduled page's own words for what the instance keeps: a saved prompt that an agent is
// asked at the times of a cron expression, and the runs it made. The screens read these types;
// only `scheduled-source.ts` knows the operations.

/** A person's saved prompt that starts a conversation at set times. Only its owner reads it. */
export interface ScheduledStart {
  id: string;
  ownerUserId: string;
  collaborationWorkspaceId: string;
  agentName: string;
  prompt: string;
  cron: string;
  timeZone: string;
  state: (typeof SCHEDULED_START_STATES)[number];
  /** When it runs next. Nothing while it is paused or the schedule has no next time. */
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One time a scheduled prompt was due, and what came of it. */
export interface ScheduledRun {
  id: string;
  /** Nothing once its scheduled start was deleted. */
  scheduledStartId: string | null;
  scheduledFor: string;
  /** The conversation the run started. Nothing where it did not start one. */
  conversationId: string | null;
  agentRunId: string | null;
  /** The status of the agent run it started, or `skipped` and `failed` where it started none. */
  status: string;
  /** Why it was skipped or failed, as a code. */
  reason: string | null;
  createdAt: string;
}

/** What a person writes in the dialog, and what create and update send. */
export interface ScheduledStartInput {
  agentName: string;
  prompt: string;
  cron: string;
  timeZone: string;
}

/** The longest heading a prompt gives its scheduled start. */
const HEADING_MAX_CHARS = 80;

/**
 * The heading a scheduled start is listed under: the first line of its prompt, cut at a word
 * where it is long. It has no name of its own.
 */
export function headingOf(prompt: string): string {
  const firstLine =
    prompt
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? "";
  const line = firstLine.replace(/\s+/gu, " ");
  if (line.length <= HEADING_MAX_CHARS) {
    return line;
  }
  const cut = line.slice(0, HEADING_MAX_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${(space > HEADING_MAX_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The ready-made schedules of the dialog. `custom` is a cron expression written by hand. */
export const SCHEDULE_PRESETS = ["daily", "weekdays", "weekly", "monthly", "custom"] as const;

export type SchedulePreset = (typeof SCHEDULE_PRESETS)[number];

/** A schedule as the dialog holds it: a preset with its time and day, or a cron expression. */
export interface ScheduleChoice {
  preset: SchedulePreset;
  /** The time of day as `HH:MM`. */
  time: string;
  /** The day of a weekly schedule, as cron counts it: 0 is Sunday. */
  weekday: number;
  /** The expression of a custom schedule. */
  cron: string;
}

/** The time a new schedule starts with. */
const DEFAULT_TIME = "08:00";

/** The schedule the dialog starts with: every weekday at eight. */
export const DEFAULT_SCHEDULE: ScheduleChoice = {
  preset: "weekdays",
  time: DEFAULT_TIME,
  weekday: 1,
  cron: ""
};

const TIME = /^(\d{2}):(\d{2})$/u;

/** The cron expression of a choice. */
export function cronOf(choice: ScheduleChoice): string {
  if (choice.preset === "custom") {
    return choice.cron.trim().replace(/\s+/gu, " ");
  }
  const [, hour = "8", minute = "0"] = TIME.exec(choice.time) ?? [];
  const at = `${Number(minute)} ${Number(hour)}`;
  switch (choice.preset) {
    case "daily":
      return `${at} * * *`;
    case "weekdays":
      return `${at} * * 1-5`;
    case "weekly":
      return `${at} * * ${choice.weekday}`;
    case "monthly":
      return `${at} 1 * *`;
  }
}

const NUMBER = /^\d{1,2}$/u;

/**
 * The choice that writes `cron` again: a preset where the expression is one, else the
 * expression by hand. A saved schedule opens in the dialog as it was written.
 */
export function choiceOf(cron: string): ScheduleChoice {
  const custom = { ...DEFAULT_SCHEDULE, preset: "custom" as const, cron };
  const [minute = "", hour = "", day = "", month = "", weekday = "", ...rest] = cron
    .trim()
    .split(/\s+/u);
  if (rest.length > 0 || !NUMBER.test(minute) || !NUMBER.test(hour) || month !== "*") {
    return custom;
  }
  if (Number(minute) > 59 || Number(hour) > 23) {
    return custom;
  }
  const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  const base = { ...DEFAULT_SCHEDULE, time, cron };
  if (day === "*" && weekday === "*") return { ...base, preset: "daily" };
  if (day === "*" && weekday === "1-5") return { ...base, preset: "weekdays" };
  if (day === "*" && NUMBER.test(weekday) && Number(weekday) <= 6) {
    return { ...base, preset: "weekly", weekday: Number(weekday) };
  }
  if (day === "1" && weekday === "*") return { ...base, preset: "monthly" };
  return custom;
}

/** One field of cron: numbers, names, `*`, ranges, lists and steps. */
const CRON_FIELD = /^[\d*a-z?,/-]+$/iu;

/**
 * Whether `cron` has the shape of a five-field expression. The instance checks the values; this
 * catches what is plainly not one before the person saves.
 */
export function cronLooksValid(cron: string): boolean {
  const fields = cron.trim().split(/\s+/u);
  return fields.length === 5 && fields.every((field) => CRON_FIELD.test(field));
}

/** Whether `cron` is due more often than a scheduled prompt may run, as the instance refuses it. */
export function cronRunsTooOften(cron: string): boolean {
  const parsed = parseCron(cron);
  return (
    parsed !== undefined && shortestCronGapMinutes(parsed) < SCHEDULED_START_MIN_INTERVAL_MINUTES
  );
}

/**
 * A schedule in words with the zone its times are in: "Every weekday, 08:00 (Europe/Berlin)".
 * An expression the words do not cover is shown as written.
 */
export function scheduleLine(
  start: Pick<ScheduledStart, "cron" | "timeZone">,
  text: Pick<TranslationContextValue, "locale" | "t">
): string {
  const { t } = text;
  const fields = start.cron.trim().split(/\s+/u);
  const words =
    fields.length === 5 && fields[2] === "*" && fields[3] === "*" && fields[4] === "1-5"
      ? weekdaysInWords(fields[0] ?? "", fields[1] ?? "", text)
      : scheduleInWords(start.cron, text);
  return t("scheduled.schedule.inWords", {
    schedule: words ?? t("scheduled.schedule.custom", { cron: start.cron.trim() }),
    zone: start.timeZone
  });
}

function weekdaysInWords(
  minute: string,
  hour: string,
  { t, locale }: Pick<TranslationContextValue, "locale" | "t">
): string | undefined {
  if (!NUMBER.test(minute) || !NUMBER.test(hour) || Number(minute) > 59 || Number(hour) > 23) {
    return undefined;
  }
  const time = new Date(Date.UTC(2026, 0, 1, Number(hour), Number(minute))).toLocaleTimeString(
    locale,
    { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }
  );
  return t("scheduled.schedule.weekdays", { time });
}

/** The reasons a run gives that the page puts in its own words. */
const WAITING_FOR_DECISION = "waiting_for_decision";
const CONNECTION_NOT_CONNECTED = "connection_not_connected";
const CONNECTION_NEEDS_RECONNECT = "connection_needs_reconnect";

/** How a run's state reads in its badge. */
export interface RunStatePresentation {
  label: TranslationKey;
  tone: BadgeTone;
  /** The run is going: the badge carries a spinner. */
  spins: boolean;
}

/** The badge of a run's status. A status the page does not know reads as unknown. */
export function runState(status: string): RunStatePresentation {
  switch (status) {
    case "queued":
      return { label: "scheduled.runStatus.queued", tone: "neutral", spins: true };
    case "running":
    case "waiting_for_subagents":
    case "cancelling":
      return { label: "scheduled.runStatus.running", tone: "info", spins: true };
    case WAITING_FOR_DECISION:
      return { label: "scheduled.runStatus.waiting", tone: "warning", spins: false };
    case "completed":
      return { label: "scheduled.runStatus.done", tone: "success", spins: false };
    case "cancelled":
      return { label: "scheduled.runStatus.cancelled", tone: "neutral", spins: false };
    case "failed":
      return { label: "scheduled.runStatus.failed", tone: "danger", spins: false };
    case "skipped":
      return { label: "scheduled.runStatus.skipped", tone: "warning", spins: false };
    default:
      return { label: "scheduled.runStatus.other", tone: "neutral", spins: false };
  }
}

/** Whether a run has not ended yet: its list is read again until it has. */
export function runGoing(run: Pick<ScheduledRun, "status">): boolean {
  return GOING.has(run.status);
}

/** The statuses of an agent run that has not ended and does not wait for the person. */
const GOING: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "waiting_for_subagents",
  "cancelling"
]);

/** The line under a run that did not start or failed: why, in the page's words. */
export function runReasonKey(
  run: Pick<ScheduledRun, "status" | "reason">
): TranslationKey | undefined {
  if (run.reason === null || run.status === WAITING_FOR_DECISION) return undefined;
  switch (run.reason) {
    case WAITING_FOR_DECISION:
      return "scheduled.reason.waiting";
    case CONNECTION_NOT_CONNECTED:
      return "scheduled.reason.notConnected";
    case CONNECTION_NEEDS_RECONNECT:
      return "scheduled.reason.needsReconnect";
    case "previous_run_active":
      return "scheduled.reason.previousRunActive";
    case "agent_unavailable":
      return "scheduled.reason.agentUnavailable";
    default:
      return "scheduled.reason.other";
  }
}

/** What the page says above the runs of a scheduled start, from its latest run. */
export type StartNotice =
  | { kind: "waiting"; conversationId: string | null }
  | { kind: "connection"; message: TranslationKey };

/**
 * The notice a scheduled start stands under while its latest run says something the owner has
 * to act on: a run waits for their decision, so the next times are skipped; or a personal
 * connection is missing. The run that waits is the newest one with a conversation.
 */
export function startNotice(runs: readonly ScheduledRun[]): StartNotice | undefined {
  const latest = runs[0];
  if (latest === undefined) return undefined;
  if (latest.status === WAITING_FOR_DECISION || latest.reason === WAITING_FOR_DECISION) {
    const waiting = runs.find((run) => run.conversationId !== null);
    return { kind: "waiting", conversationId: waiting?.conversationId ?? null };
  }
  if (latest.reason === CONNECTION_NOT_CONNECTED) {
    return { kind: "connection", message: "scheduled.connectionNotConnected" };
  }
  if (latest.reason === CONNECTION_NEEDS_RECONNECT) {
    return { kind: "connection", message: "scheduled.connectionNeedsReconnect" };
  }
  return undefined;
}

/** Every IANA zone the browser knows, with `current` among them where the browser lacks it. */
export function timeZoneChoices(current: string): string[] {
  const known = Intl.supportedValuesOf("timeZone");
  const zones = known.includes("UTC") ? known : ["UTC", ...known];
  return zones.includes(current) || current === "" ? zones : [current, ...zones];
}
