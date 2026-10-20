import type { StepReference } from "./module";

/** What the authoring skill says of a `trigger` step. */
export const triggerReference = {
  does: "Starts the run. It is always the first step, and a definition has exactly one. Its output is { input, startedAt, trigger, scheduledFor }, where `input` is the run's input, checked against the definition's `inputs`.",
  fields: {
    triggers:
      'A nonempty list of { kind: manual } (a person or a call starts it), { kind: schedule, cron: "<five fields>", timeZone: "<IANA zone>" } (a wall-clock time in that zone), or { kind: parent } (a workflow step starts it). With parent alone, only another Workflow starts it. Values of missed and overlap other than last and skip are not run yet.'
  }
} satisfies StepReference<"trigger">;
