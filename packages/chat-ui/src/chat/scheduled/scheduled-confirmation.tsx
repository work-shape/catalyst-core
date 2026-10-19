import { FoldedText, KeyValue, KeyValueList, Skeleton } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { useOwnScheduledStart } from "./scheduled-data";
import { headingOf, scheduleLine, type ScheduledStart } from "./scheduled-model";

// An agent's call on a scheduled prompt, as its person reads it before Allow: what it plans,
// changes, pauses or deletes, in words. The raw input stays under the card's details.

/** The operations of scheduled prompts, as an agent calls them and as the API names them. */
const VERBS = ["create", "update", "set_state", "delete"] as const;
type Verb = (typeof VERBS)[number];
const PREFIXES = ["scheduled_starts.", "platform.scheduled_starts."];

/** A held call that saves a scheduled prompt: a new one, or a change of a saved one. */
interface SaveCall {
  verb: "create" | "update";
  /** The saved one an update changes. */
  scheduledStartId?: string;
  agentName: string;
  prompt: string;
  cron: string;
  /** Absent where the call leaves the zone to the instance. */
  timeZone?: string;
}

/** A held call that pauses, resumes or deletes a saved scheduled prompt by its id. */
type SavedStartCall =
  | { verb: "set_state"; scheduledStartId: string; state: ScheduledStart["state"] }
  | { verb: "delete"; scheduledStartId: string };

/** A held call on a scheduled prompt, read from its input. */
export type ScheduledStartCall = SaveCall | SavedStartCall;

function isSave(call: ScheduledStartCall): call is SaveCall {
  return call.verb === "create" || call.verb === "update";
}

/**
 * The call on a scheduled prompt that `operationId` names with `input`, or nothing for any other
 * call or an input of another shape: the card then lists the input field by field.
 */
export function scheduledStartCall(
  operationId: string,
  input: unknown
): ScheduledStartCall | undefined {
  const prefix = PREFIXES.find((candidate) => operationId.startsWith(candidate));
  const verb = VERBS.find(
    (candidate) => prefix !== undefined && operationId === prefix + candidate
  );
  if (verb === undefined || !isRecord(input)) return undefined;
  return callOf(verb, input);
}

function callOf(verb: Verb, input: Record<string, unknown>): ScheduledStartCall | undefined {
  const id = text(input.scheduledStartId);
  switch (verb) {
    case "create":
    case "update": {
      const agentName = text(input.agentName);
      const prompt = text(input.prompt);
      const cron = text(input.cron);
      const timeZone = text(input.timeZone);
      if (!agentName || !prompt || !cron || (verb === "update" && !id)) return undefined;
      return {
        verb,
        agentName,
        prompt,
        cron,
        ...(id ? { scheduledStartId: id } : {}),
        ...(timeZone ? { timeZone } : {})
      };
    }
    case "set_state":
      return id && (input.state === "active" || input.state === "paused")
        ? { verb, scheduledStartId: id, state: input.state }
        : undefined;
    case "delete":
      return id ? { verb, scheduledStartId: id } : undefined;
  }
}

/**
 * The summary of a call, reading the saved prompt a pause, resume or delete names by its id.
 * `agentName` turns an agent's name into the one people know.
 */
export function ScheduledStartSummary({
  call,
  agentName
}: {
  call: ScheduledStartCall;
  agentName(name: string): string;
}) {
  if (isSave(call)) {
    return <ScheduledStartSummaryView call={call} agentName={agentName} />;
  }
  return <SavedStartSummary call={call} agentName={agentName} />;
}

function SavedStartSummary({
  call,
  agentName
}: {
  call: SavedStartCall;
  agentName(name: string): string;
}) {
  const saved = useOwnScheduledStart(call.scheduledStartId);
  return (
    <ScheduledStartSummaryView
      call={call}
      saved={saved.pending ? "loading" : saved.start}
      agentName={agentName}
    />
  );
}

/**
 * The summary as drawn. A pause, resume or delete names the saved prompt it acts on: while it
 * is read a bar stands in its place, and one that cannot be read is "a scheduled prompt".
 */
export function ScheduledStartSummaryView({
  call,
  saved,
  agentName
}: {
  call: ScheduledStartCall;
  saved?: ScheduledStart | "loading";
  agentName(name: string): string;
}) {
  const { locale, t } = useTranslation();
  if (isSave(call)) {
    return (
      <KeyValueList data-testid="scheduled-confirmation" data-verb={call.verb}>
        <KeyValue label={t("scheduled.agent")} data-field="agent">
          <span className="wrap-anywhere">{agentName(call.agentName)}</span>
        </KeyValue>
        <KeyValue label={t("scheduled.prompt")} data-field="prompt">
          <FoldedText>{call.prompt}</FoldedText>
        </KeyValue>
        <KeyValue label={t("scheduled.confirm.when")} data-field="when">
          {scheduleLine(
            { cron: call.cron, timeZone: call.timeZone ?? t("scheduled.confirm.instanceZone") },
            { locale, t }
          )}
        </KeyValue>
        <KeyValue label={t("scheduled.confirm.runsAs")} data-field="runs-as">
          {t("scheduled.confirm.runsAsYou")}
        </KeyValue>
      </KeyValueList>
    );
  }
  return (
    <KeyValueList data-testid="scheduled-confirmation" data-verb={call.verb}>
      <KeyValue label={t("scheduled.confirm.start")} data-field="start">
        {saved === "loading" ? (
          <Skeleton className="w-48" />
        ) : saved === undefined ? (
          t("scheduled.confirm.unknownStart")
        ) : (
          <span className="grid gap-0.5">
            <span className="wrap-anywhere">{headingOf(saved.prompt)}</span>
            <span className="text-caption text-muted-foreground wrap-anywhere">
              {agentName(saved.agentName)} · {scheduleLine(saved, { locale, t })}
            </span>
          </span>
        )}
      </KeyValue>
      <KeyValue label={t("scheduled.confirm.change")} data-field="change">
        {t(
          call.verb === "delete"
            ? "scheduled.confirm.delete"
            : call.state === "paused"
              ? "scheduled.confirm.pause"
              : "scheduled.confirm.resume"
        )}
      </KeyValue>
    </KeyValueList>
  );
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
