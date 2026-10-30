import { WORKFLOW_TRIGGER_EVENT_NAMES } from "@work-shape/catalyst-core";
import type { StepReference } from "./module";

/** What the authoring skill says of a `trigger` step. */
export const triggerReference = {
  does: "Starts the run. It is always the first step, and a definition has exactly one. Its output is { input, startedAt, trigger, scheduledFor, event }, where `input` is the run's input, checked against the definition's `inputs`, and `event` is the platform event that started it ({ id, name, occurredAt, source: { kind, id, name }, data }, ids and counts only) or null.",
  fields: {
    triggers: `A nonempty list of { kind: manual } (a person, an agent or an App starts it), { kind: schedule, cron: "<five fields>", timeZone: "<IANA zone>" } (a wall-clock time in that zone), { kind: parent } (a workflow step starts it), { kind: outside } (an API key, the CLI or the platform MCP server starts it and reads its result; off unless named, and refused while any Connection operation the run calls, in child Workflows too, is not exposed to outside), { kind: webhook, perMinute: <1 to 600, 60 unless set> } (an outside system posts the run's input as JSON to the Workflow's webhook address, signed with the secret a publisher creates on the Workflow's Settings; at most one), or { kind: platform_event, event: "<${WORKFLOW_TRIGGER_EVENT_NAMES.join(" | ")}>", filter: { knowledgeBase: "<name>" } } (the event starts it, only where the Workflow's account may read the event's source; filter is optional). A run started by a schedule, a webhook or an event has no person behind it. With parent alone, only another Workflow starts it. Values of missed and overlap other than last and skip are not run yet.`
  }
} satisfies StepReference<"trigger">;
